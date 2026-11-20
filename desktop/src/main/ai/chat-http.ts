import { ProviderError, type ChatProvider, type ChatRequest, type ChatResult } from './types';
import { rateFromHeaders, toProviderError } from './whisper-http';

/** Any OpenAI-compatible chat service. Groq and Gemini both offer this interface. */
export class ChatHttpProvider implements ChatProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | null,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) };
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchFn(url, init);
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw e;
      throw new ProviderError('network', 'Could not reach the AI service. Check your internet connection.');
    }
  }

  async complete(request: ChatRequest): Promise<ChatResult> {
    const body = {
      model: request.model,
      messages: request.messages,
      temperature: request.json ? 0 : 0.2,
      max_tokens: request.maxOutputTokens,
      ...(request.json ? { response_format: { type: 'json_object' } } : {}),
    };
    const response = await this.send(`${this.baseUrl}/chat/completions`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: request.signal });
    if (!response.ok) {
      const error = await toProviderError(response);
      // Some services (Gemini) answer an unknown model with a bare 404 and no message. For a chat request
      // that almost always means the model, so EchoMind can switch to one the service has.
      throw response.status === 404 && error.kind === 'rejected' ? new ProviderError('model', 'The service does not recognize this model or address. Check Settings.') : error;
    }

    let data: { model?: unknown; choices?: { message?: { content?: unknown }; finish_reason?: unknown }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
    try {
      data = (await response.json()) as typeof data;
    } catch {
      throw new ProviderError('server', 'The AI service returned an unexpected response.');
    }
    const choice = data.choices?.[0];
    const text = choice?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new ProviderError('server', 'The AI service returned an empty response.');
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
