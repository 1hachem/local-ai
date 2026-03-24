import { app } from '@/cli/index';
import { binary, run } from 'cmd-ts';

run(binary(app), process.argv);
