import { ProviderError, type ChatProvider, type ChatRequest, type ChatResult } from './types';

/** Models that are not for writing text: speech, safety filters, embeddings and the like. */
const NOT_FOR_TEXT = /whisper|guard|safeguard|tts|orpheus|embed|moderation|vision-only|distil/i;
/** Specialised models a service lists beside its text models (images, music, robots, live audio…). */
const SPECIALISED = /image|banana|lyria|robotics|computer-use|transcribe|deep-research|antigravity|omni|-live|veo|imagen|aqa/i;

/** Which of a service's models can do a purpose, for the choice offered in Settings. */
export function modelsFor(available: string[], purpose: 'text' | 'audio'): string[] {
  if (purpose === 'audio') return available.filter((m) => /whisper|transcribe/i.test(m) && !/-live|tts/i.test(m));
  return available.filter((m) => !NOT_FOR_TEXT.test(m) && !SPECIALISED.test(m));
}

/**
 * The model to use when the chosen one is gone: the first of EchoMind's preferred models that the
 * service still offers, otherwise the first text model it offers. Null if it offers none.
 */
export function pickModel(available: string[], preferred: string[], current: string): string | null {
  const offered = available.filter((m) => m !== current);
  return preferred.find((m) => offered.includes(m)) ?? modelsFor(offered, 'text')[0] ?? null;
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
      if (e instanceof ProviderError && e.busy) return this.tryOthers(request, model, e);
      if (!(e instanceof ProviderError) || e.kind !== 'model' || !this.inner.listModels) throw e;
      // If even the list cannot be read, the address is probably wrong: the original error says so.
      const available = await this.inner.listModels(request.signal).catch(() => null);
      if (!available) throw e;
      const next = pickModel(available, this.preferred, model);
      if (!next) throw new ProviderError('rejected', 'The service no longer offers this model, and no other text model is available. Choose one in Settings > AI providers.');
      this.replaced.set(request.model, next);
      this.onSwitch(model, next);
      return this.inner.complete({ ...request, model: next });
    }
  }

  /**
   * The chosen model is overloaded: this one request is tried on EchoMind's other preferred models, in
   * order. Nothing is remembered, because "busy" passes; the person's choice stays as it is. If every
   * model is busy, the first error goes back to the queue, which waits and retries.
   */
  private async tryOthers(request: ChatRequest, busyModel: string, first: ProviderError): Promise<ChatResult> {
    for (const other of this.preferred.filter((m) => m !== busyModel)) {
      try {
        return await this.inner.complete({ ...request, model: other });
      } catch (e) {
        if (!(e instanceof ProviderError) || !(e.busy || e.kind === 'model')) throw e;
      }
    }
    throw first;
  }

  listModels(signal: AbortSignal): Promise<string[]> {
    return this.inner.listModels ? this.inner.listModels(signal) : Promise.resolve([]);
  }

  testConnection(signal: AbortSignal): Promise<void> {
    return this.inner.testConnection(signal);
  }
}
