import net from "node:net";
import fs from "node:fs";
import type { FrameworkAdapter } from "./frameworks/index.js";

/** Marks the end of a streamed response. */
const EOT = "\n---END---\n";

function log(msg: string) {
  process.stderr.write(`[local-ai] ${msg}\n`);
}

/**
 * Handle a single socket connection.
 *
 * Protocol (per connection, repeatable):
 *   Client  ->  prompt text terminated by \n
 *   Server  <-  streamed text chunks, ending with \n\x04\n
 */
function handleConnection(socket: net.Socket, adapter: FrameworkAdapter) {
  const remoteId =
    socket.remoteAddress && socket.remotePort
      ? `${socket.remoteAddress}:${socket.remotePort}`
      : "unix-client";

  log(`connection from ${remoteId}`);

  socket.setKeepAlive(true, 30_000);

  let buffer = "";
  let processing = false;
  const queue: string[] = [];

  async function processPrompt(prompt: string) {
    processing = true;
    log(`prompt from ${remoteId}: ${prompt.slice(0, 80)}${prompt.length > 80 ? "..." : ""}`);

    try {
      await adapter.streamText(prompt, (chunk) => {
        if (!socket.destroyed) {
          socket.write(chunk);
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`error: ${msg}`);
      if (!socket.destroyed) {
        socket.write(`\n[error] ${msg}`);
      }
    }

    if (!socket.destroyed) {
      socket.write(EOT);
    }

    processing = false;

    // Drain the queue
    if (queue.length > 0) {
      const next = queue.shift()!;
      await processPrompt(next);
    }
  }

  socket.on("data", (data) => {
    buffer += data.toString("utf-8");

    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);

      if (line.length === 0) continue;

      if (processing) {
        queue.push(line);
      } else {
        processPrompt(line);
      }
    }
  });

  socket.on("end", () => {
    // If there's remaining buffered text without a trailing newline, treat it as a prompt
    const remaining = buffer.trim();
    if (remaining.length > 0) {
      if (processing) {
        queue.push(remaining);
      } else {
        processPrompt(remaining);
      }
    }
    log(`disconnected: ${remoteId}`);
  });

  socket.on("error", (err) => {
    log(`socket error (${remoteId}): ${err.message}`);
  });
}

export interface ServerOptions {
  adapter: FrameworkAdapter;
  port?: number;
  socketPath?: string;
}

export interface ServerHandle {
  /** All running net.Server instances */
  servers: net.Server[];
  /** Gracefully shut everything down */
  close(): Promise<void>;
}

export function startServer(options: ServerOptions): ServerHandle {
  const { adapter, port, socketPath } = options;
  const servers: net.Server[] = [];

  function createServer(): net.Server {
    return net.createServer((socket) => handleConnection(socket, adapter));
  }

  // TCP server
  if (port !== undefined) {
    const tcpServer = createServer();
    tcpServer.listen(port, "0.0.0.0", () => {
      log(`listening on tcp://0.0.0.0:${port}`);
    });
    tcpServer.on("error", (err) => {
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
    unixServer.on("error", (err) => {
      console.error(`[local-ai] Unix socket server error: ${err.message}`);
      process.exit(1);
    });
    servers.push(unixServer);
  }

  // Cleanup on exit
  function cleanup() {
    log("shutting down...");
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

  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  return {
    servers,
    async close() {
      cleanup();
    },
  };
}
