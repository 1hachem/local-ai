import type { ClientMessage, ServerMessage } from '@/const';
import net from 'node:net';

// ---------------------------------------------------------------------------
// LocalAIClient – programmatic client for the local-ai NDJSON server
//
// Usage as a module:
//
//   import { LocalAIClient } from '@/client/client';
//
//   const client = new LocalAIClient({ port: 3005 });
//   const sessionId = await client.connect();
//
//   for await (const chunk of client.send('Hello!')) {
//     process.stdout.write(chunk);
//   }
//
//   client.disconnect();
//
// ---------------------------------------------------------------------------

export interface LocalAIClientOptions {
  /** TCP host (default "127.0.0.1"). */
  host?: string;
  /** TCP port.  Provide either `port` or `socketPath`. */
  port?: number;
  /** Unix domain socket path.  Provide either `port` or `socketPath`. */
  socketPath?: string;
  /** Existing session ID to resume. */
  sessionId?: string;
}

export class LocalAIClient {
  private socket: net.Socket | null = null;
  private buffer = '';
  private sessionId: string | null = null;

  /**
   * Pending message resolvers.  Each entry corresponds to a JSON line the
   * client is waiting for.  We use a simple FIFO queue because the server
   * processes prompts sequentially per connection.
   */
  private waiters: Array<(msg: ServerMessage) => void> = [];

  private opts: Required<Pick<LocalAIClientOptions, 'host'>> &
    LocalAIClientOptions;

  constructor(options: LocalAIClientOptions) {
    this.opts = { host: '127.0.0.1', ...options };
  }

  // ---- public API --------------------------------------------------------

  /**
   * Open the TCP / Unix socket connection and perform the handshake.
   * Returns the session ID assigned (or resumed) by the server.
   */
  async connect(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const socket = this.opts.socketPath
        ? net.createConnection({ path: this.opts.socketPath })
        : net.createConnection({
            host: this.opts.host,
            port: this.opts.port!,
          });

      socket.setKeepAlive(true, 30_000);

      socket.on('connect', async () => {
        this.socket = socket;
        this.setupDataHandler();

        // Perform handshake
        const handshake: ClientMessage = {
          type: 'handshake',
          ...(this.opts.sessionId ? { sessionId: this.opts.sessionId } : {}),
        };
        this.sendRaw(handshake);

        try {
          const resp = await this.nextMessage();
          if (resp.type === 'handshake') {
            this.sessionId = resp.sessionId;
            resolve(resp.sessionId);
          } else {
            reject(
              new Error(
                `unexpected handshake response: ${JSON.stringify(resp)}`
              )
            );
          }
        } catch (err) {
          reject(err);
        }
      });

      socket.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Send a prompt and yield streamed text chunks as they arrive.
   * The generator completes when the server sends a `done` message.
   */
  async *send(content: string): AsyncGenerator<string, void, unknown> {
    if (!this.socket || this.socket.destroyed) {
      throw new Error('not connected');
    }

    const msg: ClientMessage = { type: 'prompt', content };
    this.sendRaw(msg);

    while (true) {
      const resp = await this.nextMessage();

      switch (resp.type) {
        case 'chunk':
          yield resp.content;
          break;
        case 'done':
          return;
        case 'error':
          throw new Error(resp.message);
        default:
          // Ignore unexpected messages
          break;
      }
    }
  }

  /** Close the connection. */
  disconnect() {
    if (this.socket && !this.socket.destroyed) {
      this.socket.end();
    }
    this.socket = null;
    this.sessionId = null;
  }

  /** Return the current session ID (if connected). */
  getSessionId(): string | null {
    return this.sessionId;
  }

  // ---- internals ---------------------------------------------------------

  private sendRaw(msg: ClientMessage) {
    this.socket!.write(JSON.stringify(msg) + '\n');
  }

  /** Wait for the next NDJSON message from the server. */
  private nextMessage(): Promise<ServerMessage> {
    return new Promise<ServerMessage>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** Wire up the socket `data` event to parse NDJSON and dispatch waiters. */
  private setupDataHandler() {
    this.socket!.on('data', (data) => {
      this.buffer += data.toString('utf-8');

      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);

        if (line.length === 0) continue;

        try {
          const msg = JSON.parse(line) as ServerMessage;
          const waiter = this.waiters.shift();
          if (waiter) {
            waiter(msg);
          }
        } catch {
          // Ignore unparseable lines
        }
      }
    });

    this.socket!.on('close', () => {
      // Reject any pending waiters
      for (const w of this.waiters) {
        // Resolve with an error message so generators can terminate
        w({ type: 'error', message: 'connection closed' });
      }
      this.waiters.length = 0;
    });
  }
}
