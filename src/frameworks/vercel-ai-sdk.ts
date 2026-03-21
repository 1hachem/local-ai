import { env } from '@/env';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { streamText } from 'ai';
import type { FrameworkAdapter } from './index';

export function createAdapter(): FrameworkAdapter {
  const openrouter = createOpenRouter({ apiKey: env.OPENROUTER_API_KEY });

  return {
    async streamText(prompt, onChunk) {
      const model = DEFAULT_MODEL;

      const result = streamText({
        model: openrouter(model),
        prompt,
        onError({ error }) {
          console.error('[vercel-ai-sdk] stream error:', error);
        },
      });

      for await (const delta of result.textStream) {
        onChunk(delta);
      }

      // Ensure the stream is fully consumed and all internal
      // promises are settled before signalling completion.
      await result.text;
    },
  };
}
