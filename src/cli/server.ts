import { frameworkNames, frameworks } from '@/frameworks/index';
import { startServer } from '@/server/server';
import { command, number, option, optional, string } from 'cmd-ts';

export const serverCommand = command({
  name: 'server',
  description:
    'Start the local-ai NDJSON server over TCP and/or Unix socket. ' +
    'Send a prompt (newline-terminated) and receive streaming text back.',
  version: '1.0.0',
  args: {
    framework: option({
      type: string,
      long: 'framework',
      short: 'f',
      description: `AI framework to use (${frameworkNames.join(', ')})`,
    }),
    port: option({
      type: optional(number),
      long: 'port',
      short: 'p',
      description: 'TCP port to listen on',
    }),
    socket: option({
      type: optional(string),
      long: 'socket',
      short: 's',
      description: 'Unix domain socket path to listen on',
    }),
  },
  handler: async ({ framework, port, socket }) => {
    // Validate that at least one listener is specified
    if (port === undefined && socket === undefined) {
      console.error(
        'Error: at least one of --port or --socket must be specified.'
      );
      process.exit(1);
    }

    // Validate framework name
    const loaderFn = frameworks[framework];
    if (!loaderFn) {
      console.error(
        `Error: unknown framework "${framework}". Available: ${frameworkNames.join(', ')}`
      );
      process.exit(1);
    }

    // Load the adapter
    process.stderr.write(`[local-ai] loading framework: ${framework}\n`);
    const adapter = await loaderFn();

    // Start the server(s)
    startServer({
      adapter,
      port: port ?? undefined,
      socketPath: socket ?? undefined,
    });
  },
});
