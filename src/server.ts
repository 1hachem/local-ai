import type {
  ClientMessage,
  ServerMessage,
} from '@/const';
import type { FrameworkAdapter } from '@/frameworks/index';
import type { MessageStore } from '@/store/index';
import { InMemoryStore } from '@/store/index';
import fs from 'node:fs';
import net from 'node:net';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string) {
  process.stderr.write(`[local-ai] ${msg}\n`);
}

/** Send an NDJSON message to a socket (JSON + newline). */
function send(socket: net.Socket, msg: ServerMessage) {
  if (!socket.destroyed) {
    socket.write(JSON.stringify(msg) + '\n');
  }
}

/** Try to parse a single NDJSON line. Returns `null` on failure. */
function parseLine(line: string): ClientMessage | null {
  try {
    return JSON.parse(line) as ClientMessage;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Connection handler
// ---------------------------------------------------------------------------

/**
 * Handle a single socket connection.
 *
 * Protocol (NDJSON – one JSON object per line):
 *
 *   1. Client sends a HandshakeRequest  →  Server replies with HandshakeResponse
 *   2. Client sends PromptRequest(s)    →  Server streams ChunkResponse(s) + DoneResponse
 *
 * The server maintains conversation history in the provided MessageStore
 * so each subsequent prompt includes the full history.
 */
function handleConnection(
  socket: net.Socket,
  adapter: FrameworkAdapter,
  store: MessageStore,
) {
  const remoteId =
    socket.remoteAddress && socket.remotePort
      ? `${socket.remoteAddress}:${socket.remotePort}`
      : 'unix-client';

  log(`connection from ${remoteId}`);

  socket.setKeepAlive(true, 30_000);

  let buffer = '';
  let sessionId: string | null = null;
  let processing = false;
  const queue: string[] = [];

  // ------ prompt processing -----------------------------------------------

  async function processPrompt(content: string) {
    if (!sessionId) {
      send(socket, { type: 'error', message: 'handshake required before sending prompts' });
      return;
    }

    processing = true;
    log(
      `prompt from ${remoteId} [${sessionId}]: ${content.slice(0, 80)}${content.length > 80 ? '...' : ''}`,
    );

    // Append the user message to history
    store.addMessage(sessionId, { role: 'user', content });

    // Collect the full assistant response so we can persist it
    let assistantContent = '';

    try {
      const messages = store.getMessages(sessionId);
      await adapter.streamText(messages, (chunk) => {
        assistantContent += chunk;
        send(socket, { type: 'chunk', content: chunk });
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`error: ${msg}`);
      send(socket, { type: 'error', message: msg });
    }

    // Persist the assistant's full reply
    if (assistantContent.length > 0) {
      store.addMessage(sessionId, { role: 'assistant', content: assistantContent });
    }

    send(socket, { type: 'done' });

    processing = false;

    // Drain the queue
    if (queue.length > 0) {
      const next = queue.shift()!;
      await processPrompt(next);
    }
  }

  // ------ handshake -------------------------------------------------------

  function handleHandshake(msg: ClientMessage & { type: 'handshake' }) {
    if (msg.sessionId && store.hasSession(msg.sessionId)) {
      sessionId = msg.sessionId;
      log(`resumed session ${sessionId} for ${remoteId}`);
    } else {
      sessionId = store.createSession();
      log(`new session ${sessionId} for ${remoteId}`);
    }
    send(socket, { type: 'handshake', sessionId });
  }

  // ------ incoming data (NDJSON framing) ----------------------------------

  function handleLine(line: string) {
    const msg = parseLine(line);
    if (!msg) {
      send(socket, { type: 'error', message: 'invalid JSON' });
      return;
    }

    switch (msg.type) {
      case 'handshake':
        handleHandshake(msg);
        break;

      case 'prompt':
        if (processing) {
          queue.push(msg.content);
        } else {
          processPrompt(msg.content);
        }
        break;

      default:
        send(socket, {
          type: 'error',
          message: `unknown message type: ${(msg as { type: string }).type}`,
        });
    }
  }

  socket.on('data', (data) => {
    buffer += data.toString('utf-8');

    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);

      if (line.length === 0) continue;
      handleLine(line);
    }
  });

  socket.on('end', () => {
    // Process any remaining buffered data
    const remaining = buffer.trim();
    if (remaining.length > 0) {
      handleLine(remaining);
    }
    log(`disconnected: ${remoteId}`);
  });

  socket.on('error', (err) => {
    log(`socket error (${remoteId}): ${err.message}`);
  });
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

export interface ServerOptions {
  adapter: FrameworkAdapter;
  port?: number;
  socketPath?: string;
  /** Message store implementation.  Defaults to InMemoryStore. */
  store?: MessageStore;
}

export interface ServerHandle {
  /** All running net.Server instances */
  servers: net.Server[];
  /** The message store used by this server */
  store: MessageStore;
  /** Gracefully shut everything down */
  close(): Promise<void>;
}

export function startServer(options: ServerOptions): ServerHandle {
  const { adapter, port, socketPath } = options;
  const store: MessageStore = options.store ?? new InMemoryStore();
  const servers: net.Server[] = [];

  function createServer(): net.Server {
    return net.createServer((socket) =>
      handleConnection(socket, adapter, store),
    );
  }

  // TCP server
  if (port !== undefined) {
    const tcpServer = createServer();
    tcpServer.listen(port, '0.0.0.0', () => {
      log(`listening on tcp://0.0.0.0:${port}`);
    });
    tcpServer.on('error', (err) => {
      console.error(`[local-ai] TCP server error: ${err.message}`);
      process.exit(1);
    });
    servers.push(tcpServer);
  }

  // Unix socket server
  if (socketPath !== undefined) {
    // Clean up stale socket file
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // Ignore – file may not exist
    }

    const unixServer = createServer();
    unixServer.listen(socketPath, () => {
      log(`listening on unix://${socketPath}`);
    });
    unixServer.on('error', (err) => {
      console.error(`[local-ai] Unix socket server error: ${err.message}`);
      process.exit(1);
    });
    servers.push(unixServer);
  }

  // Cleanup on exit
  function cleanup() {
    log('shutting down...');
    for (const s of servers) {
      s.close();
    }
    if (socketPath) {
      try {
        fs.unlinkSync(socketPath);
      } catch {
        // Ignore
      }
    }
  }

  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

  return {
    servers,
    store,
    async close() {
      cleanup();
    },
  };
}
