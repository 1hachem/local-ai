/**
 * Framework adapter interface.
 *
 * Every AI framework (vercel-ai-sdk, langchain, llamaindex, …) implements
 * this contract so the socket server can drive them uniformly.
 */
export interface FrameworkAdapter {
  /**
   * Stream a text response for the given prompt.
   * Each chunk of generated text is forwarded to `onChunk`.
   * The returned promise resolves when generation is complete.
   */
  streamText(prompt: string, onChunk: (text: string) => void): Promise<void>;
}

/** Lazy-loaded registry of available framework adapters. */
export const frameworks: Record<string, () => Promise<FrameworkAdapter>> = {
  vercel: async () => {
    const mod = await import('./vercel-ai-sdk');
    return mod.createAdapter();
  },
};

/** Names that can be passed to --framework */
export const frameworkNames = Object.keys(frameworks);
