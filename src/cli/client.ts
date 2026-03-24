import { LocalAIClient } from '@/client/client';
import { command, number, option, optional, string } from 'cmd-ts';
import readline from 'node:readline';

export const clientCommand = command({
  name: 'client',
  description:
    'Interactive client for the local-ai NDJSON server. ' +
    'Connect via TCP port or Unix socket and send prompts interactively.',
  version: '1.0.0',
  args: {
    port: option({
      type: optional(number),
      long: 'port',
      short: 'p',
      description: 'TCP port to connect to',
    }),
    socket: option({
      type: optional(string),
      long: 'socket',
      short: 's',
      description: 'Unix domain socket path to connect to',
    }),
    session: option({
      type: optional(string),
      long: 'session',
      description: 'Existing session ID to resume',
    }),
  },
  handler: async ({ port, socket, session }) => {
    await startCli(
      port ?? undefined,
      socket ?? undefined,
      session ?? undefined,
    );
  },
});

// ---------------------------------------------------------------------------
// Interactive CLI logic
//
// Enter sends the message, Shift+Enter inserts a newline.
// ---------------------------------------------------------------------------

async function startCli(
  port: number | undefined,
  socketPath: string | undefined,
  sessionId: string | undefined,
) {
  if (port === undefined && socketPath === undefined) {
    console.error(
      'Error: at least one of --port or --socket must be specified.',
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
  //   - Enter (\r or \n)        -> send the accumulated message
  //   - Shift+Enter (\x1b[13;2u or detected via escape sequence) -> insert newline
  //   - Ctrl+C                  -> exit
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
          // Shift+Enter -> insert newline
          inputBuffer += '\n';
          process.stdout.write('\n');
          redrawInput();
          i += 6; // skip past the sequence
          continue;
        }
        // \x1bOM -- some terminals
        if (remaining.startsWith('\x1bOM')) {
          inputBuffer += '\n';
          process.stdout.write('\n');
          redrawInput();
          i += 2;
          continue;
        }
        // Generic escape -- mark pending and continue
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

      // Enter (\r or \n) -> send
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
