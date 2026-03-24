import { clientCommand } from '@/cli/client';
import { serverCommand } from '@/cli/server';
import { subcommands } from 'cmd-ts';

export const app = subcommands({
  name: 'local-ai',
  version: '1.0.0',
  description: 'Run AI agents and workflows over a TCP/Unix socket.',
  cmds: {
    server: serverCommand,
    client: clientCommand,
  },
});
