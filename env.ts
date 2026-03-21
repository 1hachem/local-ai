import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

const serverSchema = z.object({
  OPENROUTER_API_KEY: z.string(),
});

export const env = createEnv({
  extends: [],
  server: serverSchema.shape,
  runtimeEnv: {
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  },
});
