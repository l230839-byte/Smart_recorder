import type {
  AppLockState,
  AiOutcome,
  AiPurpose,
  AppInfo,
  Bookmark,
  Collection,
  CreateDocumentInput,
  CreateDocumentOutcome,
  DocumentExport,
  DocumentRecord,
  DocumentVersionInfo,
  ImportJob,
  JobKind,
  LibraryQuery,
  LibraryStats,
  Recording,
  RecordingMode,
  Settings,
  StorageInfo,
  Summary,
  SummaryTemplate,
  ProcessingJob,
  ProviderStatus,
  Tag,
  TranscribeOutcome,
  Transcript,
  UsageSummary,
} from './models';
import type { LlmProviderId, TranscriptionProviderId } from './providers';
import type { ChatDetail, ChatScope, ChatThread } from './chat';
import type { DocumentSettings, ExportFormat } from './documents';
import type { SearchQuery, SearchResult } from './search';
import type { QuizAnswer, QuizAttempt, StartStudioInput, StudioKind, StudioOptions, StudioOutput, StudioTemplate, Task, TaskEdit, TaskStatus } from './studio';
import type { Chapter, Suggestions, SummaryOptions } from './summaries';

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
  getProviderStatus(provider: TranscriptionProviderId | LlmProviderId, purpose: AiPurpose): ProviderStatus;
  saveProviderKey(provider: TranscriptionProviderId | LlmProviderId, key: string): void;
  clearProviderKey(provider: TranscriptionProviderId | LlmProviderId): void;
  testProvider(provider: TranscriptionProviderId | LlmProviderId, purpose: AiPurpose): Promise<void>;
  acceptConsent(provider: TranscriptionProviderId | LlmProviderId, purpose: AiPurpose): void;
  revokeConsent(provider: TranscriptionProviderId | LlmProviderId, purpose: AiPurpose): void;
  getUsage(): UsageSummary[];

  // Transcription
  requestTranscription(recordingId: string, language?: string): TranscribeOutcome;
  listJobs(): ProcessingJob[];
  latestJob(recordingId: string, kind: JobKind): ProcessingJob | null;
  cancelJob(id: string): void;
  retryJob(id: string): void;
  removeJob(id: string): void;
  clearFinishedJobs(): void;

  getTranscript(recordingId: string, versionId?: string): Transcript | null;
  editSegment(recordingId: string, idx: number, text: string): void;
  setCurrentVersion(recordingId: string, versionId: string): void;
  renameSpeaker(recordingId: string, label: string, name: string): void;
  /** Saves the transcript as a file the user picks. Returns false if they cancel. */
  exportTranscript(recordingId: string, format: 'txt' | 'srt' | 'vtt' | 'csv'): Promise<boolean>;
  openExternal(url: string): void;

  // Summaries, chapters, suggestions. All read the stored transcript; none transcribes again.
  requestSummary(recordingId: string, options: SummaryOptions): AiOutcome;
  requestChapters(recordingId: string, language?: string): AiOutcome;
  requestSuggestions(recordingId: string): AiOutcome;
  listSummaries(recordingId: string): Summary[];
  deleteSummary(id: string): void;
  /** Saves a summary as Markdown or text where the user picks. Returns false if they cancel. */
  exportSummary(id: string, format: 'md' | 'txt'): Promise<boolean>;
  listChapters(recordingId: string): Chapter[];
  getSuggestions(recordingId: string): Suggestions | null;
  dismissSuggestions(recordingId: string): void;
  listTemplates(): SummaryTemplate[];
  saveTemplate(name: string, options: SummaryOptions): string;
  deleteTemplate(id: string): void;

  // Chat with recordings, and search across everything
  startChat(scope: ChatScope): string;
  chatScopeInfo(scope: ChatScope): { recordings: number; withTranscript: number; label: string };
  listChats(): ChatThread[];
  getChat(id: string): ChatDetail | null;
  /** Starts an answer. `jobId` is the answer's id. */
  askChat(threadId: string, question: string): AiOutcome;
  retryChat(answerId: string): AiOutcome;
  cancelChat(answerId: string): void;
  renameChat(id: string, title: string): void;
  deleteChat(id: string): void;
  searchEverything(query: SearchQuery): SearchResult[];

  // AI Studio, study tools and tasks
  /** Starts a Studio tool. Returns the result's id, or why it cannot start. */
  startStudio(input: StartStudioInput): { ok: true; outputId: string } | Exclude<AiOutcome, { ok: true }>;
  listStudio(recordingId?: string): StudioOutput[];
  getStudio(id: string): StudioOutput | null;
  studioJob(id: string): ProcessingJob | null;
  renameStudio(id: string, title: string): void;
  deleteStudio(id: string): void;
  saveQuizAttempt(outputId: string, answers: QuizAnswer[]): QuizAttempt;
  listQuizAttempts(outputId: string): QuizAttempt[];
  listStudioTemplates(): StudioTemplate[];
  saveStudioTemplate(name: string, kind: StudioKind, options: StudioOptions): string;
  deleteStudioTemplate(id: string): void;
  listTasks(filter: { status?: TaskStatus; recordingId?: string; text?: string }): Task[];
  taskCounts(): { suggested: number; open: number; overdue: number };
  createTask(input: { title: string; description?: string; dueDate?: string | null; recordingId?: string | null }): string;
  updateTask(id: string, edit: TaskEdit): void;
  deleteTask(id: string): void;
  /** Saves an image (a mind map) where the user picks. Returns false if they cancel. */
  saveImage(defaultName: string, format: 'png' | 'svg', data: Uint8Array): Promise<boolean>;

  // App lock. While locked, the main process refuses everything except unlocking.
  getAppLockState(): AppLockState;
  setAppPin(pin: string, currentPin: string | null): AppLockState;
  disableAppLock(currentPin: string): AppLockState;
  setAutoLock(minutes: number): AppLockState;
  lockApp(): void;
  /** Returns the new state: still locked when the PIN was wrong. Throws while a wait applies. */
  unlockApp(pin: string): AppLockState;

  // Backup, restore and share bundles
  /** Asks where to save, then writes an encrypted backup. Null if the user cancels. */
  createBackup(password: string): Promise<{ sizeBytes: number; recordings: number } | null>;
  /** Asks for a backup file and reads what it holds. The choice is remembered for restoreBackup. */
  pickBackup(): Promise<{ createdAt: number; appVersion: string; recordings: number | null; encrypted: boolean; name: string } | null>;
  /** Checks and unpacks the chosen backup. It replaces the library when EchoMind restarts. */
  restoreBackup(password: string): Promise<{ recordings: number; createdAt: number }>;
  restartToRestore(): void;
  cancelRestore(): Promise<void>;
  previousData(): Promise<{ sizeBytes: number } | null>;
  deletePreviousData(): Promise<void>;
  /** Saves a recording with its transcript, summaries, chapters and documents as one file. */
  exportBundle(recordingId: string): Promise<boolean>;
  importBundle(): Promise<{ recordingId: string; title: string } | null>;

  // Documents
  listDocuments(recordingId?: string): DocumentRecord[];
  getDocument(id: string): DocumentRecord | null;
  createDocument(input: CreateDocumentInput): CreateDocumentOutcome;
  updateDocument(id: string, patch: { title?: string; markdown?: string; settings?: DocumentSettings }): void;
  saveDocumentVersion(id: string, label: string): void;
  listDocumentVersions(id: string): DocumentVersionInfo[];
  restoreDocumentVersion(id: string, versionId: string): void;
  deleteDocument(id: string): Promise<void>;
  documentJob(id: string): ProcessingJob | null;
  exportDocument(id: string, format: ExportFormat): Promise<DocumentExport>;
  listExports(): DocumentExport[];
  openExport(id: string): Promise<void>;
  showExport(id: string): void;
  /** Copies an export to a place the user picks. Returns false if they cancel. */
  saveExportCopy(id: string): Promise<boolean>;
  deleteExport(id: string): Promise<void>;
}

/** Events pushed from the main process to the UI. */
export interface EchoEvents {
  /** Stored data changed; screens re-read what they show. The value names the area. */
  'data:changed': 'settings' | 'library' | 'imports' | 'jobs' | 'transcripts' | 'summaries' | 'documents' | 'chats' | 'studio' | 'tasks';
  /** Files arrived from outside the window ("Open with", a second launch). The batch is already queued. */
  'imports:opened': string;
  /** Interrupted recordings were rebuilt at launch. The value is how many. */
  'recordings:recovered': number;
  /** The user chose "Stop and save" when closing during a recording. */
  'recorder:stop-and-quit': null;
  /** The app was locked or unlocked. */
  'lock:changed': AppLockState;
  /** Progress of a backup, restore or bundle, in bytes. */
  'archive:progress': { done: number; total: number };
  /** The user clicked a task reminder. */
  'tasks:open': null;
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
