/**
 * Provider facts live here, in one place, because free tiers change often (prompt §0). Limits that vary by
 * account are deliberately absent: EchoMind shows what the provider reports and what the user configures.
 */

export const TRANSCRIPTION_PROVIDERS = ['groq', 'gemini', 'local', 'custom', 'fake'] as const;

/**
 * Whisper models that run on this computer through whisper.cpp (MIT). All multilingual, so Urdu, Hindi
 * and Arabic work; all quantized, which keeps them small with little loss. Hashes are the files'
 * published SHA-256 at huggingface.co/ggerganov/whisper.cpp, checked after every download.
 */
export const LOCAL_MODELS = {
  tiny: { label: 'Tiny', file: 'ggml-tiny-q5_1.bin', sizeMb: 31, sha256: '818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7', hint: 'Fastest. Rough with accents and noise.' },
  base: { label: 'Base', file: 'ggml-base-q5_1.bin', sizeMb: 57, sha256: '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898', hint: 'Fast. Fine for clear speech.' },
  small: { label: 'Small', file: 'ggml-small-q5_1.bin', sizeMb: 181, sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb', hint: 'Recommended. Good accuracy at a reasonable speed.' },
  medium: { label: 'Medium', file: 'ggml-medium-q5_0.bin', sizeMb: 514, sha256: '19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f', hint: 'More accurate, several times slower.' },
  'large-v3-turbo': { label: 'Large v3 Turbo', file: 'ggml-large-v3-turbo-q5_0.bin', sizeMb: 547, sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2', hint: 'Most accurate, especially for other languages. Needs a fast computer.' },
} as const;
export type LocalModelId = keyof typeof LOCAL_MODELS;
export const LOCAL_MODEL_IDS = Object.keys(LOCAL_MODELS) as LocalModelId[];
export const LOCAL_MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

export interface LocalModelStatus {
  id: LocalModelId;
  installed: boolean;
  /** Set while downloading: bytes so far and in all. */
  downloading: { received: number; total: number } | null;
  /** A part file from an interrupted download, which "Download" continues. */
  partialBytes: number;
}
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
  /**
   * Longer pieces than the usual 10 minutes, where a provider benefits: Gemini's speaker labels restart
   * with every request, so fewer, longer pieces keep "Speaker A" the same person for longer.
   */
  maxChunkMs?: number;
  /** How each piece is encoded: small Opus for upload, or the 16 kHz WAV whisper.cpp reads. */
  pieceFormat?: 'opus' | 'wav16k';
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
  gemini: {
    id: 'gemini',
    label: 'Google Gemini Transcribe',
    hint: 'Tells speakers apart and times every word. The same free key as Gemini text. Free use may help improve Google products.',
    local: false,
    needsKey: true,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    // Checked live on 2026-11-23. Up to 30 minutes per request with speakers and word times on.
    models: ['gemini-3.5-transcribe'],
    maxChunkBytes: 20 * 1024 * 1024,
    // Gemini accepts 30 minutes per request with speakers and word times on; 25 leaves room. At 32 kbps
    // a piece is about 6 MB, 8 MB as base64.
    maxChunkMs: 25 * 60 * 1000,
    keyUrl: 'https://aistudio.google.com/apikey',
    limitsUrl: 'https://ai.google.dev/gemini-api/docs/rate-limits',
    disclosure:
      "Audio from your recording is sent to Google, in pieces, to create the transcript. On Gemini's free tier, Google's terms say it may use what you submit, and the results, to improve its products and machine learning technology. Do not use this for confidential recordings. Groq Whisper or the offline demo are alternatives.",
    speakerLabels: true,
  },
  local: {
    id: 'local',
    label: 'On this computer (offline Whisper)',
    hint: 'Nothing leaves your computer, and no key is needed. Download a model once; speed depends on your computer.',
    local: true,
    needsKey: false,
    baseUrl: null,
    models: ['small', 'base', 'tiny', 'medium', 'large-v3-turbo'],
    maxChunkBytes: 1024 * 1024 * 1024,
    pieceFormat: 'wav16k',
    keyUrl: null,
    limitsUrl: null,
    disclosure: '',
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

export const LLM_PROVIDERS = ['groq', 'gemini', 'local-llm', 'custom-chat', 'fake'] as const;
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
    // Checked against Groq's live model list on 2026-11-20; Llama 3.x has been retired there.
    models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'],
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
    // Checked live on 2026-11-23. Flash-Lite answers in about a second; the others are used when it is busy.
    models: ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-flash-lite-latest', 'gemini-3.1-flash-lite'],
    maxInputChars: 200_000,
    keyUrl: 'https://aistudio.google.com/apikey',
    limitsUrl: 'https://ai.google.dev/gemini-api/docs/rate-limits',
    disclosure:
      "Transcript text is sent to Google to write the result. On Gemini's free tier, Google's terms say it may use what you submit, and the responses, to improve its products and machine learning technology. Do not use this for confidential recordings. Groq or the offline demo are alternatives.",
  },
  'local-llm': {
    id: 'local-llm',
    label: 'On this computer (offline)',
    hint: 'Nothing leaves your computer, and no key is needed. Download a model once; slower than online services.',
    local: true,
    needsKey: false,
    baseUrl: null,
    models: ['qwen3-4b', 'qwen3-1.7b'],
    // A small model on a CPU reads slowly; pieces of this size keep each step to a minute or two.
    maxInputChars: 14_000,
    keyUrl: null,
    limitsUrl: null,
    disclosure: '',
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

/**
 * Extra request fields for models that think before answering. Their hidden reasoning counts against the
 * answer's length limit: seen live, Groq's gpt-oss-120b spent 1,498 of 1,500 tokens thinking about one
 * part of a 3-hour transcript and returned nothing, 77 times in a row. EchoMind's tasks (notes, summaries,
 * JSON) need little reasoning, so these models are asked to keep it short. Other services get nothing
 * extra, because an unknown field can make a strict service refuse the request.
 */
export function reasoningOptions(provider: LlmProviderId, model: string): Record<string, unknown> {
  if (provider === 'groq' && model.startsWith('openai/gpt-oss')) return { reasoning_effort: 'low' };
  // Qwen3 1.7B thinks before answering unless told not to (the server also starts with reasoning off).
  if (provider === 'local-llm') return { chat_template_kwargs: { enable_thinking: false } };
  if (provider === 'gemini' && /^gemini-(2\.5|[3-9])/.test(model)) return { reasoning_effort: 'low' };
  return {};
}

/**
 * Writing models that run on this computer through llama.cpp (MIT). Both Apache-2.0, quantized to 4 bits.
 * Hashes are the files' published SHA-256 on Hugging Face, checked after every download.
 */
export const LOCAL_LLM_MODELS = {
  'qwen3-4b': {
    label: 'Qwen3 4B',
    file: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    sizeMb: 2382,
    sha256: '3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597',
    url: 'https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    hint: 'Recommended. Good summaries and answers; needs about 4 GB of free memory.',
  },
  'qwen3-1.7b': {
    label: 'Qwen3 1.7B',
    file: 'Qwen3-1.7B-Q4_K_M.gguf',
    sizeMb: 1056,
    sha256: 'b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897',
    url: 'https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf',
    hint: 'Faster and smaller, for older computers. Noticeably less accurate: in testing it got some dates and owners wrong.',
  },
} as const;
export type LocalLlmModelId = keyof typeof LOCAL_LLM_MODELS;

/**
 * The provider and model a job will really use. With Offline only on, cloud services are replaced by the
 * ones on this computer, so every AI feature keeps working without the internet; if their models are not
 * downloaded yet, the privacy gate says so. The person's cloud choices are kept for when they go online.
 */
export function transcriptionChoice(s: { offlineOnly: boolean; transcriptionProvider: TranscriptionProviderId; transcriptionModel: string | null; offlineTranscriptionModel: string }): { provider: TranscriptionProviderId; model: string } {
  const provider = s.offlineOnly && !PROVIDER_INFO[s.transcriptionProvider].local ? 'local' : s.transcriptionProvider;
  if (provider === 'local') return { provider, model: s.offlineTranscriptionModel };
  return { provider, model: s.transcriptionModel ?? PROVIDER_INFO[provider].models[0]! };
}

export function llmChoice(s: { offlineOnly: boolean; llmProvider: LlmProviderId; llmModel: string | null; offlineLlmModel: string }): { provider: LlmProviderId; model: string } {
  const provider = s.offlineOnly && !LLM_PROVIDER_INFO[s.llmProvider].local ? 'local-llm' : s.llmProvider;
  if (provider === 'local-llm') return { provider, model: s.offlineLlmModel };
  return { provider, model: s.llmModel ?? LLM_PROVIDER_INFO[provider].models[0]! };
}

/**
 * The two models sherpa-onnx (Apache-2.0) uses to tell speakers apart on this computer: pyannote's
 * segmentation 3.0 (MIT), which finds where each voice speaks, and 3D-Speaker's ERes2Net (Apache-2.0),
 * which recognises the same voice again across the whole recording. Hashes checked after download.
 */
export const SPEAKER_MODELS = {
  segmentation: {
    label: 'Speech segmentation (pyannote 3.0)',
    file: 'pyannote-segmentation-3.0.onnx',
    sizeMb: 6,
    sha256: '220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079',
    url: 'https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx',
  },
  voices: {
    label: 'Voice recognition (3D-Speaker ERes2Net)',
    file: '3dspeaker-eres2net-voxceleb-16k.onnx',
    sizeMb: 26,
    sha256: 'c4947caf150b8502fdd75bbe4089b971ab1ec42e90ee3ba547faca2cde44d9ee',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx',
  },
} as const;
export type SpeakerModelId = keyof typeof SPEAKER_MODELS;

/** Transcript versions whose speaker labels were found on this computer. */
export const SPEAKERS_PROVIDER = 'sherpa-onnx';

/** Any provider's display name, for screens that list jobs from every kind. */
export function providerLabel(id: string): string {
  if (id === SPEAKERS_PROVIDER) return 'Speakers found on this computer';
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
