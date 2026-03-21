import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { streamText } from 'ai';
import type { FrameworkAdapter } from './index';

const DEFAULT_MODEL = 'minimax/minimax-m2.7';

export function createAdapter(): FrameworkAdapter {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OPENROUTER_API_KEY environment variable is required.\n' +
        'Get one at https://openrouter.ai/keys'
    );
  }

  const openrouter = createOpenRouter({ apiKey });

  return {
    async streamText(prompt, onChunk) {
      const result = streamText({
        model: openrouter(DEFAULT_MODEL),
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
