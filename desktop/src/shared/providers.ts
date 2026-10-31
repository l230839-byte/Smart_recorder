/**
 * Provider facts live here, in one place, because free tiers change often (prompt §0). Limits that vary by
 * account are deliberately absent: EchoMind shows what the provider reports and what the user configures.
 */

export const TRANSCRIPTION_PROVIDERS = ['groq', 'custom', 'fake'] as const;
export type TranscriptionProviderId = (typeof TRANSCRIPTION_PROVIDERS)[number];

export interface ProviderInfo {
  id: TranscriptionProviderId;
  label: string;
  hint: string;
  /** Nothing leaves this computer, so no key, consent or online mode is needed. */
  local: boolean;
  needsKey: boolean;
  baseUrl: string | null;
  models: string[];
  /** The largest audio chunk this provider accepts. EchoMind splits recordings to fit. */
  maxChunkBytes: number;
  keyUrl: string | null;
  limitsUrl: string | null;
  /** Shown before the first upload. States what is known and where to check, and promises nothing. */
  disclosure: string;
  speakerLabels: boolean;
}

export const PROVIDER_INFO: Record<TranscriptionProviderId, ProviderInfo> = {
  groq: {
    id: 'groq',
    label: 'Groq Whisper',
    hint: 'Fast Whisper transcription. Free tier with your own key.',
    local: false,
    needsKey: true,
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['whisper-large-v3-turbo', 'whisper-large-v3'],
    maxChunkBytes: 25 * 1024 * 1024,
    keyUrl: 'https://console.groq.com/keys',
    limitsUrl: 'https://console.groq.com/settings/limits',
    disclosure:
      "Audio from your recording is sent to Groq, in pieces, to create the transcript. Groq's documentation says it does not use customer data for training, and does not keep inputs by default, except that it may log them for up to 30 days for reliability and abuse checks. Terms can change, so check Groq's data policy if this recording is sensitive.",
    speakerLabels: false,
  },
  custom: {
    id: 'custom',
    label: 'Other Whisper-compatible service',
    hint: 'Any OpenAI-compatible transcription address, including one you host yourself.',
    local: false,
    needsKey: false,
    baseUrl: null,
    models: ['whisper-1'],
    maxChunkBytes: 25 * 1024 * 1024,
    keyUrl: null,
    limitsUrl: null,
    disclosure: 'Audio from your recording is sent, in pieces, to the address you entered. Its privacy and data terms are set by whoever runs that service.',
    speakerLabels: false,
  },
  fake: {
    id: 'fake',
    label: 'Demo (placeholder text)',
    hint: 'Tries the whole flow with no key and no internet. The text is made up, not your audio.',
    local: true,
    needsKey: false,
    baseUrl: null,
    models: ['demo'],
    maxChunkBytes: 25 * 1024 * 1024,
    keyUrl: null,
    limitsUrl: null,
    disclosure: '',
    speakerLabels: true,
  },
};

export const LLM_PROVIDERS = ['groq', 'gemini', 'custom-chat', 'fake'] as const;
export type LlmProviderId = (typeof LLM_PROVIDERS)[number];

export interface LlmProviderInfo {
  id: LlmProviderId;
  label: string;
  hint: string;
  local: boolean;
  needsKey: boolean;
  baseUrl: string | null;
  /** The first model is the default. Checked against the provider's docs on 2026-10-31. */
  models: string[];
  /** Transcript text per request. Conservative, because free tiers limit tokens per minute. */
  maxInputChars: number;
  keyUrl: string | null;
  limitsUrl: string | null;
  disclosure: string;
}

export const LLM_PROVIDER_INFO: Record<LlmProviderId, LlmProviderInfo> = {
  groq: {
    id: 'groq',
    label: 'Groq',
    hint: 'Fast open models. The same free key as Groq Whisper.',
    local: false,
    needsKey: true,
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile', 'openai/gpt-oss-20b', 'llama-3.1-8b-instant'],
    maxInputChars: 12_000,
    keyUrl: 'https://console.groq.com/keys',
    limitsUrl: 'https://console.groq.com/settings/limits',
    disclosure:
      "Transcript text is sent to Groq to write the result. Groq's documentation says it does not use customer data for training, and does not keep inputs by default, except that it may log them for up to 30 days for reliability and abuse checks. Terms can change, so check Groq's data policy if this recording is sensitive.",
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    hint: 'Handles long transcripts in one go. Free use may help improve Google products.',
    local: false,
    needsKey: true,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.1-flash-lite'],
    maxInputChars: 200_000,
    keyUrl: 'https://aistudio.google.com/apikey',
    limitsUrl: 'https://ai.google.dev/gemini-api/docs/rate-limits',
    disclosure:
      "Transcript text is sent to Google to write the result. On Gemini's free tier, Google's terms say it may use what you submit, and the responses, to improve its products and machine learning technology. Do not use this for confidential recordings. Groq or the offline demo are alternatives.",
  },
  'custom-chat': {
    id: 'custom-chat',
    label: 'Other OpenAI-compatible service',
    hint: 'Any compatible chat address, including one you host yourself, such as Ollama.',
    local: false,
    needsKey: false,
    baseUrl: null,
    models: ['local-model'],
    maxInputChars: 12_000,
    keyUrl: null,
    limitsUrl: null,
    disclosure: 'Transcript text is sent to the address you entered. Its privacy and data terms are set by whoever runs that service.',
  },
  fake: {
    id: 'fake',
    label: 'Demo (placeholder text)',
    hint: 'Tries the whole flow with no key and no internet. It only quotes the transcript.',
    local: true,
    needsKey: false,
    baseUrl: null,
    models: ['demo'],
    maxInputChars: 12_000,
    keyUrl: null,
    limitsUrl: null,
    disclosure: '',
  },
};

/** Any provider's display name, for screens that list jobs from every kind. */
export function providerLabel(id: string): string {
  return (PROVIDER_INFO as Record<string, { label: string }>)[id]?.label ?? (LLM_PROVIDER_INFO as Record<string, { label: string }>)[id]?.label ?? id;
}

export const TRANSCRIPT_LANGUAGES: { value: string; label: string }[] = [
  { value: 'auto', label: 'Detect automatically' },
  { value: 'en', label: 'English' },
  { value: 'ur', label: 'Urdu' },
  { value: 'hi', label: 'Hindi' },
  { value: 'ar', label: 'Arabic' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'zh', label: 'Chinese' },
];

/** Limits on each long-audio piece: short enough to retry cheaply, and well under provider sizes. */
export const MAX_CHUNK_MS = 10 * 60 * 1000;
export const SPEECH_BITRATE = 32_000;

/** http is only allowed to this computer; any address across a network must be encrypted (prompt §21). */
export function validateBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
  return url.toString().replace(/\/+$/, '');
}
