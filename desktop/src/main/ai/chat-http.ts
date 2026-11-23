import { ProviderError, type ChatProvider, type ChatRequest, type ChatResult } from './types';
import { fetchWithTimeout, rateFromHeaders, REQUEST_TIMEOUT_MS, toProviderError } from './whisper-http';

/** The reply hit the length limit before any visible text: the model spent it all on reasoning. */
class ThoughtOnly extends Error {}

/** Any OpenAI-compatible chat service. Groq and Gemini both offer this interface. */
export class ChatHttpProvider implements ChatProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | null,
    private readonly fetchFn: typeof fetch = fetch,
    /** Longer for a model on your own computer, which can be slow. */
    private readonly timeoutMs = REQUEST_TIMEOUT_MS,
    /** Fields a particular model needs, such as a short reasoning budget (see `reasoningOptions`). */
    private readonly extraBody: (model: string) => Record<string, unknown> = () => ({}),
  ) {}

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) };
  }

  private send(url: string, init: RequestInit): Promise<Response> {
    return fetchWithTimeout(this.fetchFn, url, init, this.timeoutMs, 'Could not reach the AI service. Check your internet connection.');
  }

  async complete(request: ChatRequest): Promise<ChatResult> {
    try {
      return await this.attempt(request, request.maxOutputTokens);
    } catch (e) {
      // A thinking model can spend the whole length limit on hidden reasoning and say nothing. One more
      // try with twice the room usually leaves space for the answer; anything else is a real failure.
      if (!(e instanceof ThoughtOnly)) throw e;
      try {
        return await this.attempt(request, Math.min(request.maxOutputTokens * 2, 16_000));
      } catch (again) {
        if (again instanceof ThoughtOnly) throw new ProviderError('server', 'The AI model used its whole answer length on thinking and wrote nothing. EchoMind will try again.');
        throw again;
      }
    }
  }

  private async attempt(request: ChatRequest, maxTokens: number): Promise<ChatResult> {
    const body = {
      model: request.model,
      messages: request.messages,
      temperature: request.json ? 0 : 0.2,
      max_tokens: maxTokens,
      ...(request.json ? { response_format: { type: 'json_object' } } : {}),
      ...this.extraBody(request.model),
    };
    let response = await this.send(`${this.baseUrl}/chat/completions`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: request.signal });
    if (!response.ok) {
      let error = await toProviderError(response);
      // Groq checks JSON-mode replies and refuses one the model wrote badly ("Failed to validate JSON",
      // seen live on a long transcript). The next try usually succeeds; a second refusal is a server problem.
      if (request.json && response.status === 400 && /validate json|json_validate_failed/i.test(error.message)) {
        response = await this.send(`${this.baseUrl}/chat/completions`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: request.signal });
        if (response.ok) return this.read(response, request);
        error = await toProviderError(response);
        if (response.status === 400 && /validate json|json_validate_failed/i.test(error.message)) throw new ProviderError('server', 'The AI service could not produce a readable answer. EchoMind will try again.');
      }
      // Some services (Gemini) answer an unknown model with a bare 404 and no message. For a chat request
      // that almost always means the model, so EchoMind can switch to one the service has.
      throw response.status === 404 && error.kind === 'rejected' ? new ProviderError('model', 'The service does not recognize this model or address. Check Settings.') : error;
    }
    return this.read(response, request);
  }

  private async read(response: Response, request: ChatRequest): Promise<ChatResult> {
    let data: { model?: unknown; choices?: { message?: { content?: unknown }; finish_reason?: unknown }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
    try {
      data = (await response.json()) as typeof data;
    } catch {
      throw new ProviderError('server', 'The AI service returned an unexpected response.');
    }
    const choice = data.choices?.[0];
    const text = choice?.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
      if (choice?.finish_reason === 'length') throw new ThoughtOnly();
      throw new ProviderError('server', 'The AI service returned an empty response.');
    }
    const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    return {
      text,
      truncated: choice?.finish_reason === 'length',
      inputTokens: count(data.usage?.prompt_tokens),
      outputTokens: count(data.usage?.completion_tokens),
      rate: rateFromHeaders(response.headers),
      model: request.model,
    };
  }

  async listModels(signal: AbortSignal): Promise<string[]> {
    const response = await this.send(`${this.baseUrl}/models`, { headers: { ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) }, signal });
    if (!response.ok) throw await toProviderError(response);
    const data = (await response.json().catch(() => null)) as { data?: { id?: unknown; active?: unknown }[] } | null;
    // Gemini names models "models/gemini-…"; requests take the bare name, as EchoMind's lists do.
    return (data?.data ?? []).filter((m) => typeof m.id === 'string' && m.active !== false).map((m) => (m.id as string).replace(/^models\//, ''));
  }

  async testConnection(signal: AbortSignal): Promise<void> {
    const response = await this.send(`${this.baseUrl}/models`, { headers: { ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) }, signal });
    if (!response.ok) throw await toProviderError(response);
  }
}
