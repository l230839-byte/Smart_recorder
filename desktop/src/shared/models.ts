/** Domain types shared by the main process and the UI. No Electron or DOM imports here, so they stay portable. */
import type { TranscriptionProviderId } from './providers';
import type { Segment } from './transcript';

export const RECORDING_MODES = ['lecture', 'meeting', 'interview', 'notes', 'business', 'journal', 'custom'] as const;
export type RecordingMode = (typeof RECORDING_MODES)[number];

export const MODE_INFO: Record<RecordingMode, { label: string; hint: string }> = {
  lecture: { label: 'Lecture', hint: 'Topics, definitions, exam points and revision notes' },
  meeting: { label: 'Meeting', hint: 'Decisions, action items, owners and deadlines' },
  interview: { label: 'Interview', hint: 'Speakers, questions and answers, key quotes' },
  notes: { label: 'Personal notes', hint: 'Voice notes turned into organized ideas' },
  business: { label: 'Business', hint: 'Client requirements, commitments and follow-ups' },
  journal: { label: 'Journal', hint: 'Private reflections, kept organized' },
  custom: { label: 'Custom', hint: 'Your own instructions and outputs' },
};

/** Where audio came from. Informational only: nothing downstream may branch on it (prompt §3). */
export type RecordingSource = 'native' | 'recovered' | 'picker' | 'dropped' | 'opened' | 'video' | 'trim';

export const SOURCE_LABEL: Record<RecordingSource, string> = {
  native: 'Recorded',
  recovered: 'Recovered',
  picker: 'Imported',
  dropped: 'Imported',
  opened: 'Imported',
  video: 'From video',
  trim: 'Trimmed',
};

export interface Tag {
  id: string;
  name: string;
}

export interface Recording {
  id: string;
  title: string;
  description: string;
  mode: RecordingMode;
  source: RecordingSource;
  originalName: string | null;
  format: string;
  codec: string;
  durationMs: number;
  sizeBytes: number;
  sampleRate: number;
  channels: number;
  favorite: boolean;
  archived: boolean;
  deletedAt: number | null;
  collectionId: string | null;
  createdAt: number;
  importedAt: number | null;
  updatedAt: number;
  tags: Tag[];
  hasTranscript: boolean;
}

export interface Bookmark {
  id: string;
  recordingId: string;
  positionMs: number;
  label: string;
  note: string | null;
  createdAt: number;
}

export interface Collection {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
  recordingCount: number;
}

export const LIBRARY_VIEWS = ['all', 'recent', 'favorites', 'recorded', 'imported', 'archived', 'trash'] as const;
export type LibraryView = (typeof LIBRARY_VIEWS)[number];

export const LIBRARY_VIEW_LABEL: Record<LibraryView, string> = {
  all: 'All',
  recent: 'Recent',
  favorites: 'Favorites',
  recorded: 'Recorded',
  imported: 'Imported',
  archived: 'Archived',
  trash: 'Trash',
};

export const LIBRARY_SORTS = ['newest', 'oldest', 'title', 'longest', 'largest'] as const;
export type LibrarySort = (typeof LIBRARY_SORTS)[number];

export const LIBRARY_SORT_LABEL: Record<LibrarySort, string> = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  title: 'Title A–Z',
  longest: 'Longest first',
  largest: 'Largest first',
};

export interface LibraryQuery {
  view: LibraryView;
  sort: LibrarySort;
  text?: string;
  tagId?: string | null;
  /** Includes recordings in nested sub-collections. */
  collectionId?: string | null;
}

export type ImportStatus = 'queued' | 'copying' | 'checking' | 'converting' | 'done' | 'failed' | 'duplicate';

export interface ImportJob {
  id: string;
  batchId: string;
  displayName: string;
  sizeBytes: number | null;
  status: ImportStatus;
  progress: number;
  error: string | null;
  /** False when retrying cannot help, such as a corrupt file. The UI then offers only Remove. */
  retryable: boolean;
  recordingId: string | null;
  duplicateOf: string | null;
  mode: RecordingMode;
  createdAt: number;
}

export type JobStatus = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'canceled';

export interface ProcessingJob {
  id: string;
  kind: 'transcribe';
  recordingId: string;
  recordingTitle: string;
  status: JobStatus;
  stage: string;
  progress: number;
  error: string | null;
  retryable: boolean;
  provider: TranscriptionProviderId;
  nextAttemptAt: number | null;
  createdAt: number;
}

export interface TranscriptVersion {
  id: string;
  recordingId: string;
  version: number;
  kind: 'original' | 'edited';
  provider: string;
  model: string;
  language: string | null;
  isCurrent: boolean;
  createdAt: number;
}

export interface Transcript {
  version: TranscriptVersion;
  versions: TranscriptVersion[];
  segments: Segment[];
  speakers: Record<string, string>;
}

export type TranscribeOutcome = { ok: true; jobId: string } | { ok: false; reason: 'offline-only' | 'needs-setup' | 'needs-consent'; provider: TranscriptionProviderId };

export interface ProviderRateInfo {
  remainingRequests: number | null;
  limitRequests: number | null;
  resetsInMs: number | null;
}

export interface UsageSummary {
  provider: string;
  requestsToday: number;
  audioMsToday: number;
  requestsMonth: number;
  audioMsMonth: number;
  rate: ProviderRateInfo | null;
  rateUpdatedAt: number | null;
}

export interface ProviderStatus {
  hasKey: boolean;
  consented: boolean;
  secureStorage: boolean;
}

export type ThemeSetting = 'system' | 'light' | 'dark';
export type AudioQuality = 'voice' | 'standard' | 'high';

export const AUDIO_QUALITY: Record<AudioQuality, { label: string; hint: string; bitrate: number }> = {
  voice: { label: 'Voice', hint: '32 kbps, about 14 MB per hour', bitrate: 32_000 },
  standard: { label: 'Standard', hint: '64 kbps, about 29 MB per hour', bitrate: 64_000 },
  high: { label: 'High', hint: '128 kbps, about 58 MB per hour', bitrate: 128_000 },
};

export interface Settings {
  onboardingComplete: boolean;
  displayName: string;
  theme: ThemeSetting;
  /** While true, nothing may leave this computer. Starts on; the user turns it off deliberately. */
  offlineOnly: boolean;
  defaultMode: RecordingMode;
  audioQuality: AudioQuality;
  inputDeviceId: string | null;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGain: boolean;
  trashRetentionDays: number;
  playbackSpeed: number;
  skipSilence: boolean;
  transcriptionProvider: TranscriptionProviderId;
  /** Null uses the provider's first listed model. */
  transcriptionModel: string | null;
  transcriptionLanguage: string;
  customBaseUrl: string | null;
  /** Warn past this much audio per day, in minutes. Null means no warning. */
  dailyAudioLimitMinutes: number | null;
}

export const DEFAULT_SETTINGS: Settings = {
  onboardingComplete: false,
  displayName: '',
  theme: 'system',
  offlineOnly: true,
  defaultMode: 'lecture',
  audioQuality: 'standard',
  inputDeviceId: null,
  noiseSuppression: true,
  echoCancellation: false,
  autoGain: true,
  trashRetentionDays: 30,
  playbackSpeed: 1,
  skipSilence: false,
  transcriptionProvider: 'groq',
  transcriptionModel: null,
  transcriptionLanguage: 'auto',
  customBaseUrl: null,
  dailyAudioLimitMinutes: null,
};

export interface LibraryStats {
  recordings: number;
  totalDurationMs: number;
  totalBytes: number;
}

export interface StorageInfo {
  /** Size of audio in the library, including the trash. */
  mediaBytes: number;
  trashBytes: number;
  trashCount: number;
  freeBytes: number;
  dataDirectory: string;
  largest: Recording[];
}

export interface AppInfo {
  version: string;
  electron: string;
  chromium: string;
  node: string;
  sqlite: string;
  dataDirectory: string;
  /** The optional bundled FFmpeg is present, so extra formats such as AMR can be imported. */
  ffmpeg: boolean;
}
