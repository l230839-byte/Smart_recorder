import type {
  AppInfo,
  Bookmark,
  Collection,
  ImportJob,
  LibraryQuery,
  LibraryStats,
  Recording,
  RecordingMode,
  Settings,
  StorageInfo,
  ProcessingJob,
  ProviderStatus,
  Tag,
  TranscribeOutcome,
  Transcript,
  UsageSummary,
} from './models';
import type { TranscriptionProviderId } from './providers';

export interface RecordingEdit {
  title?: string;
  description?: string;
  mode?: RecordingMode;
  collectionId?: string | null;
  favorite?: boolean;
  archived?: boolean;
}

/**
 * Everything the UI may ask of the main process. The preload bridge exposes exactly this surface
 * (see `src/preload/index.ts`); the renderer has no other access to Node, files or the database.
 */
export interface EchoApi {
  getSettings(): Settings;
  updateSettings(patch: Partial<Settings>): Settings;
  getAppInfo(): AppInfo;
  openDataFolder(): void;

  // Library
  listRecordings(query: LibraryQuery): Recording[];
  getRecording(id: string): Recording | null;
  getPeaks(id: string): Uint8Array | null;
  getLibraryStats(): LibraryStats;
  getStorageInfo(): Promise<StorageInfo>;
  updateRecording(id: string, edit: RecordingEdit): void;
  setFavorite(ids: string[], value: boolean): void;
  setArchived(ids: string[], value: boolean): void;
  moveToCollection(ids: string[], collectionId: string | null): void;
  trashRecordings(ids: string[]): void;
  restoreRecordings(ids: string[]): void;
  deleteForever(ids: string[]): Promise<void>;
  emptyTrash(): Promise<void>;
  /** Writes a copy of the audio to a location the user picks. Returns false if they cancel. */
  exportAudio(id: string): Promise<boolean>;
  trimRecording(id: string, startMs: number, endMs: number): Promise<string>;

  listTags(trashed: boolean): Tag[];
  addTag(recordingId: string, name: string): void;
  removeTag(recordingId: string, tagId: string): void;

  listBookmarks(recordingId: string): Bookmark[];
  addBookmark(recordingId: string, positionMs: number, label: string, note: string | null): void;
  deleteBookmark(id: string): void;

  listCollections(): Collection[];
  createCollection(name: string, parentId: string | null): string;
  renameCollection(id: string, name: string): void;
  moveCollection(id: string, parentId: string | null): void;
  deleteCollection(id: string): void;

  // Import
  /** Opens the system file dialog. Returns the batch id, or null if the user cancels. */
  pickAndImport(mode: RecordingMode): Promise<string | null>;
  importPaths(paths: string[], mode: RecordingMode): Promise<string>;
  listImports(): ImportJob[];
  retryImport(id: string): void;
  removeImport(id: string): void;
  clearFinishedImports(): void;

  // Recording session
  beginRecording(title: string, mode: RecordingMode): Promise<string>;
  appendRecording(sessionId: string, chunk: Uint8Array): Promise<void>;
  addSessionBookmark(sessionId: string, positionMs: number, label: string, note: string | null, maxMs: number): void;
  finishRecording(sessionId: string, details: { title: string; description: string }): Promise<string | null>;
  discardRecording(sessionId: string): Promise<void>;
  getFreeSpace(): Promise<number>;

  // AI providers. Keys go in and are never returned to the UI.
  getProviderStatus(provider: TranscriptionProviderId): ProviderStatus;
  saveProviderKey(provider: TranscriptionProviderId, key: string): void;
  clearProviderKey(provider: TranscriptionProviderId): void;
  testProvider(provider: TranscriptionProviderId): Promise<void>;
  acceptConsent(provider: TranscriptionProviderId): void;
  revokeConsent(provider: TranscriptionProviderId): void;
  getUsage(): UsageSummary[];

  // Transcription
  requestTranscription(recordingId: string, language?: string): TranscribeOutcome;
  listJobs(): ProcessingJob[];
  latestJob(recordingId: string): ProcessingJob | null;
  cancelJob(id: string): void;
  retryJob(id: string): void;
  removeJob(id: string): void;
  clearFinishedJobs(): void;

  getTranscript(recordingId: string, versionId?: string): Transcript | null;
  editSegment(recordingId: string, idx: number, text: string): void;
  setCurrentVersion(recordingId: string, versionId: string): void;
  renameSpeaker(recordingId: string, label: string, name: string): void;
  /** Saves the transcript as a file the user picks. Returns false if they cancel. */
  exportTranscript(recordingId: string, format: 'txt' | 'srt' | 'vtt'): Promise<boolean>;
  openExternal(url: string): void;
}

/** Events pushed from the main process to the UI. */
export interface EchoEvents {
  /** Stored data changed; screens re-read what they show. The value names the area. */
  'data:changed': 'settings' | 'library' | 'imports' | 'jobs' | 'transcripts';
  /** Files arrived from outside the window ("Open with", a second launch). The batch is already queued. */
  'imports:opened': string;
  /** Interrupted recordings were rebuilt at launch. The value is how many. */
  'recordings:recovered': number;
  /** The user chose "Stop and save" when closing during a recording. */
  'recorder:stop-and-quit': null;
  /** The user clicked a notification about this recording. */
  'recording:open': string;
}

export type ApiMethod = keyof EchoApi;

export interface EchoBridge {
  call<M extends ApiMethod>(method: M, ...args: Parameters<EchoApi[M]>): Promise<Awaited<ReturnType<EchoApi[M]>>>;
  on<E extends keyof EchoEvents>(event: E, listener: (payload: EchoEvents[E]) => void): () => void;
  /** Real path of a dragged file. Only available for files the user actually dropped. */
  pathForFile(file: File): string;
  platform: string;
  /** Tells the main process recording has finished, so it may now close the window. */
  closeAfterRecording(): void;
}
