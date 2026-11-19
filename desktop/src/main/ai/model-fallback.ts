import { ProviderError, type ChatProvider, type ChatRequest, type ChatResult } from './types';

/** Models that are not for writing text: speech, safety filters, embeddings and the like. */
const NOT_FOR_TEXT = /whisper|guard|safeguard|tts|orpheus|embed|moderation|vision-only|distil/i;

/**
 * The model to use when the chosen one is gone: the first of EchoMind's preferred models that the
 * service still offers, otherwise the first text model it offers. Null if it offers none.
 */
export function pickModel(available: string[], preferred: string[], current: string): string | null {
  const offered = available.filter((m) => m !== current);
  return preferred.find((m) => offered.includes(m)) ?? offered.find((m) => !NOT_FOR_TEXT.test(m)) ?? null;
}

/**
 * Free services retire models often. When the service says a model no longer exists, this asks which
 * models it has, switches to the best one, remembers it (so Settings shows it and later work uses it),
 * and carries on, instead of failing every summary, chat and Studio tool until someone edits Settings.
 */
export class ModelFallbackProvider implements ChatProvider {
  private readonly replaced = new Map<string, string>();

  constructor(
    private readonly inner: ChatProvider,
    private readonly preferred: string[],
    private readonly onSwitch: (from: string, to: string) => void,
  ) {}

  async complete(request: ChatRequest): Promise<ChatResult> {
    const model = this.replaced.get(request.model) ?? request.model;
    try {
      return await this.inner.complete({ ...request, model });
    } catch (e) {
      if (!(e instanceof ProviderError) || e.kind !== 'model' || !this.inner.listModels) throw e;
      const next = pickModel(await this.inner.listModels(request.signal), this.preferred, model);
      if (!next) throw new ProviderError('rejected', 'The service no longer offers this model, and no other text model is available. Choose one in Settings > AI providers.');
      this.replaced.set(request.model, next);
      this.onSwitch(model, next);
      return this.inner.complete({ ...request, model: next });
    }
  }

  listModels(signal: AbortSignal): Promise<string[]> {
    return this.inner.listModels ? this.inner.listModels(signal) : Promise.resolve([]);
  }

  testConnection(signal: AbortSignal): Promise<void> {
    return this.inner.testConnection(signal);
  }
}
