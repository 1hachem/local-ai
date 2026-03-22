import type { ClientMessage, ServerMessage } from '@/const';
import net from 'node:net';
import readline from 'node:readline';

// ---------------------------------------------------------------------------
// LocalAIClient – programmatic client for the local-ai NDJSON server
//
// Usage as a module:
//
//   import { LocalAIClient } from '@/client';
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

// ---------------------------------------------------------------------------
// Interactive CLI mode
//
// When this file is executed directly (not imported), start an interactive
// session.  Enter sends the message, Shift+Enter inserts a newline.
// ---------------------------------------------------------------------------

async function main() {
  // Parse CLI args (minimal, no dependency on cmd-ts for the client)
  const args = process.argv.slice(2);
  let port: number | undefined;
  let socketPath: string | undefined;
  let sessionId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--port':
      case '-p':
        port = Number(args[++i]);
        break;
      case '--socket':
      case '-s':
        socketPath = args[++i];
        break;
      case '--session':
        sessionId = args[++i];
        break;
    }
  }

  if (port === undefined && socketPath === undefined) {
    console.error(
      'Usage: client --port <port> | --socket <path> [--session <id>]'
    );
    process.exit(1);
  }

  const client = new LocalAIClient({ port, socketPath, sessionId });

  try {
    const sid = await client.connect();
    console.log(`connected (session: ${sid})`);
    console.log('Enter to send, Shift+Enter for new line, Ctrl+C to quit.\n');
  } catch (err) {
    console.error('failed to connect:', err);
    process.exit(1);
  }

  // -- Raw-mode input handling ---------------------------------------------
  //
  // We use raw mode so we can intercept individual keystrokes:
  //   - Enter (\r or \n)        → send the accumulated message
  //   - Shift+Enter (\x1b[13;2u or detected via escape sequence) → insert newline
  //   - Ctrl+C                  → exit
  //
  // Terminal emulators vary in how they report Shift+Enter.  Common sequences:
  //   \x1b[13;2u   (kitty keyboard protocol / many modern terminals)
  //   \x1bOM        (some terminals)
  //
  // For broad compatibility we also support a simple approach: if the user
  // types a backslash followed by n (\n) we treat it as a literal newline.
  // This makes the client usable even in terminals that don't send distinct
  // Shift+Enter sequences.

  const stdin = process.stdin;

  if (stdin.isTTY) {
    stdin.setRawMode(true);
  }

  let inputBuffer = '';
  let pendingEscape = false;

  function printPrompt() {
    const lines = inputBuffer.split('\n');
    if (lines.length > 1) {
      process.stdout.write(`\r\x1b[K... `);
    } else {
      process.stdout.write(`\r\x1b[K> `);
    }
    // Show only the current line being edited
    process.stdout.write(lines[lines.length - 1]);
  }

  function redrawInput() {
    // Clear current line and reprint
    printPrompt();
  }

  async function sendMessage() {
    const content = inputBuffer.trim();
    inputBuffer = '';

    if (content.length === 0) {
      process.stdout.write('\n');
      redrawInput();
      return;
    }

    process.stdout.write('\n');

    try {
      for await (const chunk of client.send(content)) {
        process.stdout.write(chunk);
      }
      process.stdout.write('\n\n');
    } catch (err) {
      console.error('\nerror:', err instanceof Error ? err.message : err);
    }

    redrawInput();
  }

  // Print initial prompt
  printPrompt();

  stdin.on('data', (data) => {
    const str = data.toString('utf-8');

    // Handle escape sequences byte by byte
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      const code = str.charCodeAt(i);

      // Ctrl+C
      if (code === 3) {
        process.stdout.write('\n');
        client.disconnect();
        process.exit(0);
      }

      // Ctrl+D (EOF)
      if (code === 4) {
        process.stdout.write('\n');
        client.disconnect();
        process.exit(0);
      }

      // Backspace (127 or 8)
      if (code === 127 || code === 8) {
        if (inputBuffer.length > 0) {
          inputBuffer = inputBuffer.slice(0, -1);
          redrawInput();
        }
        continue;
      }

      // Check for Shift+Enter escape sequences
      // Kitty protocol: \x1b[13;2u
      if (ch === '\x1b') {
        const remaining = str.slice(i);
        if (remaining.startsWith('\x1b[13;2u')) {
          // Shift+Enter → insert newline
          inputBuffer += '\n';
          process.stdout.write('\n');
          redrawInput();
          i += 6; // skip past the sequence
          continue;
        }
        // \x1bOM — some terminals
        if (remaining.startsWith('\x1bOM')) {
          inputBuffer += '\n';
          process.stdout.write('\n');
          redrawInput();
          i += 2;
          continue;
        }
        // Generic escape — mark pending and continue
        pendingEscape = true;
        continue;
      }

      // If we're in an escape sequence, skip non-alpha chars
      if (pendingEscape) {
        if (/[a-zA-Z~u]/.test(ch)) {
          pendingEscape = false;
        }
        continue;
      }

      // Enter (\r or \n) → send
      if (ch === '\r' || ch === '\n') {
        sendMessage();
        continue;
      }

      // Regular character
      inputBuffer += ch;
      process.stdout.write(ch);
    }
  });

  // Handle non-TTY input (piped input, used by agents)
  if (!stdin.isTTY) {
    const rl = readline.createInterface({ input: stdin });
    const lines: string[] = [];

    rl.on('line', (line) => {
      lines.push(line);
    });

    rl.on('close', async () => {
      const content = lines.join('\n').trim();
      if (content.length > 0) {
        try {
          for await (const chunk of client.send(content)) {
            process.stdout.write(chunk);
          }
          process.stdout.write('\n');
        } catch (err) {
          console.error('error:', err instanceof Error ? err.message : err);
          process.exit(1);
        }
      }
      client.disconnect();
      process.exit(0);
    });
  }
}

// Run CLI when executed directly
// Check if this module is the entry point
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('/client.ts') ||
    process.argv[1].endsWith('/client.js'));

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
