import { copyFile, mkdir, readdir, rm, statfs, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { app, dialog, ipcMain, nativeTheme, Notification, powerMonitor, safeStorage, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { AppLock } from './services/app-lock';
import { ModelFallbackProvider } from './ai/model-fallback';
import { inspectArchive } from './services/archive';
import { applyPendingRestore, BackupService } from './services/backup';
import { BundleService } from './services/bundles';
import type { EchoApi, EchoEvents } from '@shared/api';
import { JOB_KIND_LABEL, type AiPurpose } from '@shared/models';
import { markdownToClipboard } from '@shared/markdown';
import { LLM_PROVIDER_INFO, PROVIDER_INFO, SPEECH_BITRATE, reasoningOptions, validateBaseUrl, type LlmProviderId, type TranscriptionProviderId } from '@shared/providers';
import { toPlainText, toSrt, toVtt } from '@shared/transcript';
import { EXPORT_FORMATS, transcriptToCsv } from '@shared/documents';
import { ChatHttpProvider } from './ai/chat-http';
import { FakeChatProvider } from './ai/fake-chat';
import { FakeProvider } from './ai/fake-provider';
import { WhisperHttpProvider } from './ai/whisper-http';
import { openDatabase } from './db/database';
import { ImportRepository, LibraryRepository, SessionRepository } from './db/library';
import { DocumentRepository } from './db/documents';
import { SummaryRepository } from './db/summaries';
import { loadFontCss } from './documents/fonts';
import { renderPdf } from './documents/pdf';
import { ConsentRepository, JobRepository, SecretStore, TranscriptRepository, UsageRepository, type Cipher } from './db/transcripts';
import { hardenContents, hardenSession } from './security';
import { initLogFile, logError, logEvent } from './log';
import { Ffmpeg } from './services/ffmpeg';
import { ImportService } from './services/imports';
import { IngestPipeline } from './services/ingest';
import { JobQueue } from './services/job-queue';
import { DOCUMENT_SCHEME, handleDocumentProtocol, handleMediaProtocol, registerMediaScheme } from './services/media-protocol';
import { DocumentService } from './services/documents';
import { ChatService } from './services/chat';
import { StudioService } from './services/studio';
import { StudioRepository, TaskRepository } from './db/studio';
import { scoreQuiz, studioMarkdown } from '@shared/studio';
import { MediaWorker } from './services/media-worker';
import { RecorderService } from './services/recorder';
import { SettingsStore } from './services/settings';
import { SummaryService, textConsentKey } from './services/summaries';
import { keyName, TranscriptionService } from './services/transcription';
import { createMainWindow } from './window';
import { ChatRepository } from './db/chats';
import { KnowledgeRepository } from './db/knowledge';

// Tests point this at a throwaway folder so they never touch real user data.
if (process.env.ECHOMIND_USER_DATA) app.setPath('userData', process.env.ECHOMIND_USER_DATA);

registerMediaScheme();

// Anything that ends or interrupts the app is written down, so "it just closed" always leaves a reason.
initLogFile(join(app.getPath('userData'), 'logs'));
if (!app.requestSingleInstanceLock()) {
  logEvent('quit', 'another EchoMind window is already open');
  app.quit();
} else {
  logEvent('start', `version ${app.getVersion()}`);
}
app.on('render-process-gone', (_e, contents, d) => logEvent('renderer-gone', `${d.reason} code=${d.exitCode} ${contents.getURL().split('/').pop() ?? ''}`));
app.on('child-process-gone', (_e, d) => logEvent('child-gone', `${d.type} ${d.reason} code=${d.exitCode}${d.name ? ` ${d.name}` : ''}`));
process.on('uncaughtException', (e) => logError('uncaught', e));
process.on('unhandledRejection', (e) => logError('unhandled rejection', e));
process.on('exit', (code) => logEvent('exit', `code=${code}`));

const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'amr', 'webm', 'mka'];
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'mkv', 'm4v', 'ts'];

let mainWindow: BrowserWindow | null = null;
let appLock: AppLock | null = null;

/** What still works while the app is locked: unlocking, what the lock screen shows, and keeping a recording safe. */
const ALLOWED_WHILE_LOCKED = new Set<string>(['getAppLockState', 'unlockApp', 'getSettings', 'getAppInfo', 'appendRecording']);
let closeConfirmed = false;
/** Set when the window's page crashed and was reopened; the page asks for it once. */
let recoveredNotice = false;

function emit<E extends keyof EchoEvents>(event: E, payload: EchoEvents[E]): void {
  mainWindow?.webContents.send(event, payload);
}

function registerApi(api: EchoApi): void {
  for (const method of Object.keys(api) as (keyof EchoApi)[]) {
    ipcMain.handle(`api:${method}`, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      // Only the main window may use the app's API, not the media worker or anything else.
      if (event.sender !== mainWindow?.webContents) throw new Error('Not allowed.');
      if (appLock?.isLocked() && !ALLOWED_WHILE_LOCKED.has(method)) throw new Error('EchoMind is locked.');
      return (api[method] as (...a: unknown[]) => unknown)(...args);
    });
  }
}

/** Files passed by Windows through "Open with" or a double-click arrive as plain command-line arguments. */
function filesFromArgs(argv: string[]): string[] {
  return argv.filter((arg) => {
    if (arg.startsWith('-') || !extname(arg)) return false;
    const suffix = extname(arg).slice(1).toLowerCase();
    if (!AUDIO_EXTENSIONS.includes(suffix) && !VIDEO_EXTENSIONS.includes(suffix)) return false;
    try {
      return statSync(resolve(arg)).isFile();
    } catch {
      return false;
    }
  });
}

async function start(): Promise<void> {
  const dataDir = app.getPath('userData');
  mkdirSync(dataDir, { recursive: true });
  const mediaDir = join(dataDir, 'media');
  const tempDir = join(dataDir, 'tmp');
  const sessionDir = join(dataDir, 'sessions');
  const exportsDir = join(dataDir, 'exports');
  await Promise.all([mediaDir, tempDir, sessionDir, exportsDir].map((d) => mkdir(d, { recursive: true })));

  // Anything here was left by an interrupted run; imports restart from their originals.
  for (const name of await readdir(tempDir)) await rm(join(tempDir, name), { force: true, recursive: true });

  // A backup checked and unpacked before the last restart takes its place now, before anything opens.
  const restored = await applyPendingRestore(dataDir).catch(() => false);
  const db = openDatabase(join(dataDir, 'echomind.db'));
  const settings = new SettingsStore(db);
  const library = new LibraryRepository(db);
  const importJobs = new ImportRepository(db);
  const sessions = new SessionRepository(db);
  nativeTheme.themeSource = settings.get().theme;

  hardenSession();
  hardenContents();
  const lock = new AppLock(db);
  appLock = lock;
  handleMediaProtocol(library, mediaDir, () => lock.isLocked());

  const libraryChanged = () => emit('data:changed', 'library');
  const importsChanged = () => emit('data:changed', 'imports');

  const media = new MediaWorker();
  const ffmpeg = new Ffmpeg();
  const pipeline = new IngestPipeline(media, library, mediaDir, ffmpeg);
  const imports = new ImportService(importJobs, library, pipeline, tempDir, importsChanged, libraryChanged);
  const recorder = new RecorderService(sessions, pipeline, sessionDir, libraryChanged);

  const cipher: Cipher = {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (data) => safeStorage.decryptString(Buffer.from(data)),
  };
  const transcripts = new TranscriptRepository(db);
  const jobs = new JobRepository(db);
  const usage = new UsageRepository(db);
  const consents = new ConsentRepository(db);
  const secrets = new SecretStore(db, cipher);
  const summaries = new SummaryRepository(db);
  const documentRepo = new DocumentRepository(db);
  const documentsChanged = () => emit('data:changed', 'documents');
  const chatsChanged = () => emit('data:changed', 'chats');
  const chats = new ChatRepository(db);
  const studioRepo = new StudioRepository(db);
  const taskRepo = new TaskRepository(db);
  const studioChanged = () => emit('data:changed', 'studio');
  const tasksChanged = () => emit('data:changed', 'tasks');
  const knowledge = new KnowledgeRepository(db);
  const jobsChanged = () => emit('data:changed', 'jobs');
  const queue = new JobQueue(jobs, jobsChanged);

  const notifyReady = (recordingId: string, title: string, what: string) => {
    if (Notification.isSupported() && !mainWindow?.isFocused()) {
      // While locked, a notification must not reveal what a recording is called.
      const note = new Notification({ title: `${what} ready`, body: appLock?.isLocked() ? 'Unlock EchoMind to see it.' : title });
      note.on('click', () => {
        mainWindow?.show();
        emit('recording:open', recordingId);
      });
      note.show();
    }
  };

  const makeProvider = (id: TranscriptionProviderId) => {
    if (id === 'fake') return new FakeProvider();
    const key = secrets.get(keyName(id));
    const baseUrl = id === 'custom' ? settings.get().customBaseUrl : PROVIDER_INFO[id].baseUrl;
    if (!baseUrl) throw new Error('This provider has no address set. Check Settings.');
    // A Whisper server on your own computer may need far longer than a cloud service for a 10-minute part.
    return new WhisperHttpProvider(baseUrl, key, fetch, id === 'custom' ? 30 * 60_000 : undefined);
  };

  const transcription = new TranscriptionService({
    jobs,
    transcripts,
    library,
    usage,
    consents,
    secrets,
    settings: () => settings.get(),
    makeProvider,
    prepareChunk: async (recordingId, startMs, endMs, outputPath) => {
      const file = library.mediaFile(recordingId);
      if (!file) throw new Error('The audio for this recording is missing.');
      await media.convert(join(mediaDir, file.fileName), outputPath, { container: 'ogg', transcode: true, startMs, endMs, speechBitrate: SPEECH_BITRATE });
    },
    tempDir,
    changed: jobsChanged,
    transcriptReady: (recordingId, title) => {
      emit('data:changed', 'transcripts');
      libraryChanged();
      notifyReady(recordingId, title, 'Transcript');
    },
    queue,
  });

  const makeChatProvider = (id: LlmProviderId) => {
    if (id === 'fake') return new FakeChatProvider();
    const baseUrl = id === 'custom-chat' ? settings.get().llmBaseUrl : LLM_PROVIDER_INFO[id].baseUrl;
    if (!baseUrl) throw new Error('This provider has no address set. Check Settings.');
    // If the service has retired the chosen model, the best one it still offers is used and remembered.
    // A model on your own computer can take many minutes for one answer; online services get five.
    const timeoutMs = id === 'custom-chat' ? 20 * 60_000 : undefined;
    return new ModelFallbackProvider(new ChatHttpProvider(baseUrl, secrets.get(keyName(id)), fetch, timeoutMs, (model) => reasoningOptions(id, model)), LLM_PROVIDER_INFO[id].models, (_from, to) => {
      if (settings.get().llmProvider === id) {
        settings.update({ llmModel: to });
        emit('data:changed', 'settings');
      }
    });
  };

  const summaryService = new SummaryService({
    jobs,
    queue,
    transcripts,
    library,
    summaries,
    usage,
    consents,
    secrets,
    settings: () => settings.get(),
    makeProvider: makeChatProvider,
    changed: jobsChanged,
    ready: (recordingId, title, kind) => {
      emit('data:changed', kind === 'document' ? 'documents' : 'summaries');
      notifyReady(recordingId, title, JOB_KIND_LABEL[kind]);
    },
    documentReady: (documentId, markdown, dropped, truncated) => {
      // The user may have deleted the document while it was being written.
      if (documentRepo.get(documentId)) documentRepo.setGenerated(documentId, markdown, dropped, truncated);
    },
  });

  let fontCss: Promise<string> | null = null;
  const documentService = new DocumentService({
    documents: documentRepo,
    library,
    transcripts,
    summaries,
    studioMarkdown: (id) => {
      const output = studioRepo.get(id);
      return output?.content && output.content.type !== 'tasks' ? { title: output.title, markdown: studioMarkdown(output.content, output.title) } : null;
    },
    requestAi: (recordingId, documentId, options) => (documentId ? summaryService.request(recordingId, 'document', { summary: options, documentId }) : summaryService.check(recordingId)),
    exportsDir,
    // Loaded once and kept; a failed load is forgotten so the next export tries again.
    fontCss: () =>
      (fontCss ??= loadFontCss(join(app.getAppPath(), 'node_modules')).catch((e: unknown) => {
        fontCss = null;
        throw e;
      })),
    renderPdf: (documentId, documentSettings) => renderPdf(`${DOCUMENT_SCHEME}://preview/${documentId}`, documentSettings),
    changed: documentsChanged,
  });
  handleDocumentProtocol((id) => documentService.html(id), () => lock.isLocked());

  const chatService = new ChatService({
    chats,
    knowledge,
    library,
    transcripts,
    usage,
    settings: () => settings.get(),
    makeProvider: makeChatProvider,
    blockedBy: (provider) => summaryService.blockedBy(provider),
    changed: chatsChanged,
  });
  chatService.recover();

  const studioService = new StudioService({
    studio: studioRepo,
    tasks: taskRepo,
    jobs,
    queue,
    library,
    transcripts,
    summaries,
    usage,
    settings: () => settings.get(),
    makeProvider: makeChatProvider,
    blockedBy: (provider) => summaryService.blockedBy(provider),
    changed: jobsChanged,
    ready: (recordingId, title) => {
      studioChanged();
      tasksChanged();
      notifyReady(recordingId, title, 'AI Studio result');
    },
  });

  // Task reminders: checked every half minute while EchoMind runs, and once at launch. Each shows once.
  const remind = () => {
    const due = taskRepo.takeDueReminders();
    if (!due.length) return;
    tasksChanged();
    if (!Notification.isSupported()) return;
    for (const task of due) {
      const body = lock.isLocked() ? 'You have a task reminder. Unlock EchoMind to see it.' : task.dueDate ? `${task.title} (due ${task.dueDate})` : task.title;
      const note = new Notification({ title: 'Reminder', body });
      note.on('click', () => {
        mainWindow?.show();
        emit('tasks:open', null);
      });
      note.show();
    }
  };
  setInterval(remind, 30_000);

  const consentKey = (provider: string, purpose: AiPurpose) => (purpose === 'text' ? textConsentKey(provider) : provider);

  const deleteFiles = async (ids: string[]) => {
    queue.cancelForRecordings(ids);
    // Everything made from a recording goes with it, including exported documents (prompt §21).
    const exported = documentRepo.exportFilesForRecordings(ids);
    const files = library.deleteForever(ids);
    await Promise.all(files.map((f) => rm(join(mediaDir, f), { force: true })));
    await Promise.all(exported.map((f) => rm(join(exportsDir, f), { force: true })));
    libraryChanged();
    chatsChanged();
    studioChanged();
    tasksChanged();
  };
  const purgeTrash = async () => {
    const days = settings.get().trashRetentionDays;
    const expired = library.trashedIds(Date.now() - days * 86_400_000);
    if (expired.length) await deleteFiles(expired);
  };
  const mutate = <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => {
    fn(...args);
    libraryChanged();
  };


  const sqlite = db.prepare('SELECT sqlite_version() AS v').get() as { v: string };

  // Starting with Windows, minimized, so task reminders appear on time. Only an installed copy registers,
  // so a development build never adds itself to startup.
  const applyLoginItem = (on: boolean) => {
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: on, args: ['--minimized'] });
  };

  const lockChanged = () => emit('lock:changed', lock.state());
  const refreshAll = () => {
    for (const area of ['settings', 'library', 'imports', 'jobs', 'transcripts', 'summaries', 'documents', 'chats', 'studio', 'tasks'] as const) emit('data:changed', area);
  };
  const lockNow = () => {
    if (lock.lock()) lockChanged();
  };
  // Locks when the computer has been idle for the chosen time, when Windows locks, and before sleep.
  setInterval(() => {
    if (lock.idle(powerMonitor.getSystemIdleTime())) lockChanged();
  }, 15_000);
  powerMonitor.on('lock-screen', lockNow);
  powerMonitor.on('suspend', lockNow);

  const backups = new BackupService(db, dataDir, app.getVersion());
  const bundles = new BundleService({ library, transcripts, summaries, documents: documentRepo, pipeline, mediaDir, tempDir, appVersion: app.getVersion() });
  let pickedBackup: string | null = null;
  const progress = (done: number, total: number) => emit('archive:progress', { done, total });
  const saveDialog = (options: Electron.SaveDialogOptions) => (mainWindow ? dialog.showSaveDialog(mainWindow, options) : dialog.showSaveDialog(options));
  const openDialog = (options: Electron.OpenDialogOptions) => (mainWindow ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options));
  const stamp = () => new Date().toISOString().slice(0, 10);

  registerApi({
    takeRecoveryNotice: () => {
      const shown = recoveredNotice;
      recoveredNotice = false;
      return shown;
    },
    getAppLockState: () => lock.state(),
    setAppPin: (pin, currentPin) => {
      lock.setPin(pin, currentPin);
      return lock.state();
    },
    disableAppLock: (currentPin) => {
      lock.disable(currentPin);
      lockChanged();
      return lock.state();
    },
    setAutoLock: (minutes) => {
      lock.setAutoLock(minutes);
      return lock.state();
    },
    lockApp: lockNow,
    unlockApp: (pin) => {
      if (lock.unlock(pin)) {
        lockChanged();
        refreshAll();
      }
      return lock.state();
    },

    createBackup: async (password) => {
      const result = await saveDialog({ title: 'Save backup', defaultPath: `EchoMind backup ${stamp()}.echomind-backup`, filters: [{ name: 'EchoMind backup', extensions: ['echomind-backup'] }] });
      if (result.canceled || !result.filePath) return null;
      const done = await backups.create(result.filePath, password, progress);
      settings.update({ lastBackupAt: Date.now() });
      emit('data:changed', 'settings');
      return done;
    },
    pickBackup: async () => {
      const result = await openDialog({ title: 'Restore from backup', properties: ['openFile'], filters: [{ name: 'EchoMind backup', extensions: ['echomind-backup'] }] });
      const file = result.filePaths[0];
      if (result.canceled || !file) return null;
      const info = await inspectArchive(file);
      if (info.kind !== 'backup') throw new Error('This is a share bundle, not a backup. Use Import bundle in the Library instead.');
      pickedBackup = file;
      const recordings = typeof info.summary.recordings === 'number' ? info.summary.recordings : null;
      return { createdAt: info.createdAt, appVersion: info.appVersion, recordings, encrypted: info.encrypted, name: file.split(/[\\/]/).pop() ?? file };
    },
    restoreBackup: async (password) => {
      if (!pickedBackup) throw new Error('Choose a backup first.');
      return backups.prepareRestore(pickedBackup, password, progress);
    },
    restartToRestore: () => {
      closeConfirmed = true;
      app.relaunch();
      app.quit();
    },
    cancelRestore: () => backups.cancelRestore(),
    previousData: () => backups.previousData(),
    deletePreviousData: () => backups.deletePreviousData(),
    exportBundle: async (recordingId) => {
      const rec = library.getRecording(recordingId);
      if (!rec) throw new Error('This recording no longer exists.');
      const result = await saveDialog({ title: 'Share as bundle', defaultPath: `${rec.title.replace(/[<>:"/\\|?*]+/g, ' ').trim() || 'recording'}.echomind`, filters: [{ name: 'EchoMind bundle', extensions: ['echomind'] }] });
      if (result.canceled || !result.filePath) return false;
      await bundles.export(recordingId, result.filePath);
      return true;
    },
    importBundle: async () => {
      const result = await openDialog({ title: 'Import a shared recording', properties: ['openFile'], filters: [{ name: 'EchoMind bundle', extensions: ['echomind'] }] });
      const file = result.filePaths[0];
      if (result.canceled || !file) return null;
      const imported = await bundles.import(file);
      refreshAll();
      return imported;
    },

    getSettings: () => settings.get(),
    updateSettings: (patch) => {
      for (const field of ['customBaseUrl', 'llmBaseUrl'] as const) {
        const value = patch[field];
        if (!value) continue;
        const url = validateBaseUrl(value);
        if (!url) throw new Error('Use an https:// address. Plain http:// is only allowed on this computer.');
        patch = { ...patch, [field]: url };
      }
      const before = settings.get();
      const next = settings.update(patch);
      nativeTheme.themeSource = next.theme;
      if (next.openAtLogin !== before.openAtLogin) applyLoginItem(next.openAtLogin);
      emit('data:changed', 'settings');
      return next;
    },
    getAppInfo: () => ({
      version: app.getVersion(),
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
      sqlite: sqlite.v,
      dataDirectory: dataDir,
      ffmpeg: ffmpeg.available,
    }),
    openDataFolder: () => void shell.openPath(dataDir),

    listRecordings: (query) => library.list(query),
    getRecording: (id) => library.getRecording(id),
    getPeaks: (id) => library.peaks(id),
    getLibraryStats: () => library.stats(),
    getStorageInfo: async () => {
      const fs = await statfs(dataDir);
      return { ...library.storageTotals(), freeBytes: fs.bavail * fs.bsize, dataDirectory: dataDir, largest: library.largest(5) };
    },
    updateRecording: mutate((id, edit) => library.updateRecording(id, edit)),
    setFavorite: mutate((ids, value) => library.setManyFlag(ids, 'favorite', value)),
    setArchived: mutate((ids, value) => library.setManyFlag(ids, 'archived', value)),
    moveToCollection: mutate((ids, collectionId) => library.moveToCollection(ids, collectionId)),
    trashRecordings: mutate((ids) => {
      queue.cancelForRecordings(ids);
      library.trash(ids);
    }),
    restoreRecordings: mutate((ids) => library.restore(ids)),
    deleteForever: (ids) => deleteFiles(ids),
    emptyTrash: () => deleteFiles(library.trashedIds()),
    exportAudio: async (id) => {
      const recording = library.getRecording(id);
      const file = library.mediaFile(id);
      if (!recording || !file) throw new Error('This recording no longer exists.');
      const ext = extname(file.fileName);
      const options = { defaultPath: `${recording.title.replace(/[<>:"/\\|?*]+/g, ' ').trim() || 'recording'}${ext}`, filters: [{ name: recording.format, extensions: [ext.slice(1)] }] };
      const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return false;
      await copyFile(join(mediaDir, file.fileName), result.filePath);
      return true;
    },
    trimRecording: async (id, startMs, endMs) => {
      const recording = library.getRecording(id);
      const file = library.mediaFile(id);
      if (!recording || !file) throw new Error('This recording no longer exists.');
      const workFile = join(tempDir, `trim-${Date.now()}`);
      const container = extname(file.fileName).slice(1) as 'ogg' | 'm4a' | 'mp3' | 'flac' | 'wav';
      try {
        const source = join(mediaDir, file.fileName);
        // Lossless when the format allows it. MP3 and some others cannot be cut that way, so those are re-encoded.
        await media.convert(source, workFile, { container, transcode: false, startMs, endMs }).catch(() => media.convert(source, workFile, { container: 'ogg', transcode: true, startMs, endMs }));
        const { recordingId } = await pipeline.ingest({
          workFile,
          title: `${recording.title} (trimmed)`,
          description: recording.description,
          mode: recording.mode,
          source: 'trim',
          originalName: recording.originalName,
          collectionId: recording.collectionId,
        });
        libraryChanged();
        return recordingId;
      } finally {
        await rm(workFile, { force: true });
      }
    },

    listTags: (trashed) => library.tagsInUse(trashed),
    addTag: mutate((id, name) => library.addTag(id, name)),
    removeTag: mutate((id, tagId) => library.removeTag(id, tagId)),

    listBookmarks: (id) => library.bookmarks(id),
    addBookmark: mutate((id, positionMs, label, note) => library.addBookmark(id, positionMs, label, note)),
    deleteBookmark: mutate((id) => library.deleteBookmark(id)),

    listCollections: () => library.collections(),
    createCollection: (name, parentId) => {
      const id = library.createCollection(name, parentId);
      libraryChanged();
      return id;
    },
    renameCollection: mutate((id, name) => library.renameCollection(id, name)),
    moveCollection: mutate((id, parentId) => library.moveCollection(id, parentId)),
    deleteCollection: mutate((id) => library.deleteCollection(id)),

    pickAndImport: async (mode) => {
      const options: Electron.OpenDialogOptions = {
        title: 'Import audio or video',
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'Audio and video', extensions: [...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS] },
          { name: 'All files', extensions: ['*'] },
        ],
      };
      const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) return null;
      return imports.enqueue(result.filePaths, 'picker', mode);
    },
    importPaths: (paths, mode) => imports.enqueue(paths, 'dropped', mode),
    listImports: () => importJobs.list().map(({ sourcePath: _path, sourceKind: _kind, ...job }) => job),
    retryImport: (id) => imports.retry(id),
    removeImport: (id) => {
      importJobs.remove(id);
      importsChanged();
    },
    clearFinishedImports: () => {
      importJobs.clearFinished();
      importsChanged();
    },

    beginRecording: (title, mode) => recorder.begin(title, mode),
    appendRecording: (id, chunk) => recorder.append(id, chunk),
    addSessionBookmark: (id, positionMs, label, note, maxMs) => recorder.addBookmark(id, positionMs, label, note, maxMs),
    finishRecording: (id, details) => recorder.finish(id, details),
    discardRecording: (id) => recorder.discard(id),
    getFreeSpace: async () => {
      const fs = await statfs(dataDir);
      return fs.bavail * fs.bsize;
    },

    getProviderStatus: (provider, purpose) => ({ hasKey: secrets.has(keyName(provider)), consented: consents.has(consentKey(provider, purpose)), secureStorage: cipher.available() }),
    saveProviderKey: (provider, key) => {
      const clean = key.trim();
      if (!clean) throw new Error('Enter a key first.');
      secrets.set(keyName(provider), clean);
      emit('data:changed', 'settings');
    },
    clearProviderKey: (provider) => {
      secrets.clear(keyName(provider));
      emit('data:changed', 'settings');
    },
    testProvider: async (provider, purpose) => {
      if (provider === 'fake') return;
      if (settings.get().offlineOnly) throw new Error('Offline only is on, so EchoMind did not contact the service.');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      try {
        await (purpose === 'text' ? makeChatProvider(provider as LlmProviderId) : makeProvider(provider as TranscriptionProviderId)).testConnection(controller.signal);
      } catch (e) {
        if (controller.signal.aborted) throw new Error('The service did not answer in time.');
        throw e;
      } finally {
        clearTimeout(timer);
      }
    },
    acceptConsent: (provider, purpose) => {
      consents.accept(consentKey(provider, purpose));
      emit('data:changed', 'settings');
    },
    revokeConsent: (provider, purpose) => {
      consents.revoke(consentKey(provider, purpose));
      emit('data:changed', 'settings');
    },
    getUsage: () => usage.summary(),

    requestTranscription: (recordingId, language) => transcription.request(recordingId, language),
    listJobs: () => jobs.list().map(({ attempts, model, language, options, ...job }) => job),
    latestJob: (recordingId, kind) => {
      const job = jobs.latestFor(recordingId, kind);
      if (!job) return null;
      const { attempts, model, language, options, ...rest } = job;
      return rest;
    },
    cancelJob: (id) => queue.cancel(id),
    retryJob: (id) => queue.retry(id),
    removeJob: (id) => {
      jobs.remove(id);
      jobsChanged();
    },
    clearFinishedJobs: () => {
      jobs.clearFinished();
      jobsChanged();
    },

    getTranscript: (recordingId, versionId) => {
      const versions = transcripts.versions(recordingId);
      const version = versions.find((v) => v.id === versionId) ?? versions.find((v) => v.isCurrent);
      if (!version) return null;
      return { version, versions, segments: transcripts.segments(version.id), speakers: transcripts.speakerNames(recordingId) };
    },
    editSegment: (recordingId, idx, text) => {
      transcripts.editSegment(recordingId, idx, text);
      emit('data:changed', 'transcripts');
    },
    setCurrentVersion: (recordingId, versionId) => {
      transcripts.setCurrent(recordingId, versionId);
      emit('data:changed', 'transcripts');
    },
    renameSpeaker: (recordingId, label, name) => {
      transcripts.renameSpeaker(recordingId, label, name);
      emit('data:changed', 'transcripts');
    },
    exportTranscript: async (recordingId, format) => {
      const recording = library.getRecording(recordingId);
      const version = transcripts.current(recordingId);
      if (!recording || !version) throw new Error('This recording has no transcript yet.');
      const segments = transcripts.segments(version.id);
      const names = transcripts.speakerNames(recordingId);
      const text = format === 'srt' ? toSrt(segments, names) : format === 'vtt' ? toVtt(segments, names) : format === 'csv' ? transcriptToCsv(segments, names) : toPlainText(segments, names);
      const options = { defaultPath: `${recording.title.replace(/[<>:"/\\|?*]+/g, ' ').trim() || 'transcript'}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] };
      const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return false;
      await writeFile(result.filePath, `\uFEFF${text}`, 'utf8');
      return true;
    },
    requestSummary: (recordingId, options) => summaryService.request(recordingId, 'summarize', { summary: options }),
    requestChapters: (recordingId, language) => summaryService.request(recordingId, 'chapters', { language }),
    requestSuggestions: (recordingId) => summaryService.request(recordingId, 'suggest'),
    listSummaries: (recordingId) => summaries.list(recordingId),
    deleteSummary: (id) => {
      summaries.delete(id);
      emit('data:changed', 'summaries');
    },
    exportSummary: async (id, format) => {
      const summary = summaries.get(id);
      const recording = summary && library.getRecording(summary.recordingId);
      if (!summary || !recording) throw new Error('This summary no longer exists.');
      const options = { defaultPath: `${recording.title.replace(/[<>:"/\\|?*]+/g, ' ').trim() || 'summary'} summary.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] };
      const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return false;
      await writeFile(result.filePath, `\uFEFF${markdownToClipboard(summary.markdown)}`, 'utf8');
      return true;
    },
    listChapters: (recordingId) => summaries.chapters(recordingId),
    getSuggestions: (recordingId) => summaries.suggestions(recordingId),
    dismissSuggestions: (recordingId) => {
      summaries.dismissSuggestions(recordingId);
      emit('data:changed', 'summaries');
    },
    listTemplates: () => summaries.templates(),
    saveTemplate: (name, options) => {
      const id = summaries.saveTemplate(name, options);
      emit('data:changed', 'summaries');
      return id;
    },
    deleteTemplate: (id) => {
      summaries.deleteTemplate(id);
      emit('data:changed', 'summaries');
    },

    startChat: (scope) => chatService.start(scope),
    chatScopeInfo: (scope) => chatService.scopeInfo(scope),
    listChats: () => chats.list(),
    getChat: (id) => {
      const thread = chats.get(id);
      return thread ? { thread, turns: chats.turns(id) } : null;
    },
    askChat: (threadId, question) => chatService.ask(threadId, question),
    retryChat: (answerId) => chatService.retry(answerId),
    cancelChat: (answerId) => chatService.cancel(answerId),
    renameChat: (id, title) => {
      chats.rename(id, title);
      chatsChanged();
    },
    deleteChat: (id) => {
      chats.delete(id);
      chatsChanged();
    },
    searchEverything: (query) => knowledge.search(query),

    startStudio: (input) => studioService.start(input),
    listStudio: (recordingId) => studioRepo.list(recordingId),
    getStudio: (id) => studioRepo.get(id),
    studioJob: (id) => {
      const job = studioService.jobFor(id);
      if (!job) return null;
      const { attempts, model, language, options, ...rest } = job;
      return rest;
    },
    renameStudio: (id, title) => {
      studioRepo.rename(id, title);
      studioChanged();
    },
    deleteStudio: (id) => {
      const job = studioService.jobFor(id);
      if (job && ['queued', 'running', 'waiting'].includes(job.status)) queue.cancel(job.id);
      studioRepo.delete(id);
      studioChanged();
    },
    saveQuizAttempt: (outputId, answers) => {
      const output = studioRepo.get(outputId);
      if (output?.content?.type !== 'quiz') throw new Error('This quiz no longer exists.');
      const { score, total } = scoreQuiz(output.content.questions, answers);
      const id = studioRepo.addAttempt(outputId, answers, score, total);
      studioChanged();
      return studioRepo.attempts(outputId).find((a) => a.id === id)!;
    },
    listQuizAttempts: (outputId) => studioRepo.attempts(outputId),
    listStudioTemplates: () => studioRepo.templates(),
    saveStudioTemplate: (name, kind, options) => {
      const id = studioRepo.saveTemplate(name, kind, options);
      studioChanged();
      return id;
    },
    deleteStudioTemplate: (id) => {
      studioRepo.deleteTemplate(id);
      studioChanged();
    },
    listTasks: (filter) => taskRepo.list(filter),
    taskCounts: () => taskRepo.counts(),
    createTask: (input) => {
      const id = taskRepo.create(input);
      tasksChanged();
      return id;
    },
    updateTask: (id, edit) => {
      taskRepo.update(id, edit);
      tasksChanged();
    },
    deleteTask: (id) => {
      taskRepo.delete(id);
      tasksChanged();
    },
    saveImage: async (defaultName, format, data) => {
      if (format !== 'png' && format !== 'svg') throw new Error('Unsupported image format.');
      const options = { defaultPath: `${defaultName.replace(/[<>:"/\\|?*]+/g, ' ').trim() || 'Mind map'}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] };
      const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return false;
      await writeFile(result.filePath, Buffer.from(data));
      return true;
    },

    listDocuments: (recordingId) => documentRepo.list(recordingId),
    getDocument: (id) => documentRepo.get(id),
    createDocument: (input) => documentService.create(input),
    updateDocument: (id, patch) => {
      documentRepo.update(id, patch);
    },
    saveDocumentVersion: (id, label) => {
      documentRepo.saveVersion(id, label);
      documentsChanged();
    },
    listDocumentVersions: (id) => documentRepo.versions(id),
    restoreDocumentVersion: (id, versionId) => {
      documentRepo.restoreVersion(id, versionId);
      documentsChanged();
    },
    deleteDocument: (id) => documentService.delete(id),
    documentJob: (id) => {
      const job = jobs.latestForDocument(id);
      if (!job) return null;
      const { attempts, model, language, options, ...rest } = job;
      return rest;
    },
    exportDocument: (id, format) => documentService.export(id, format),
    listExports: () => documentService.listExports(),
    openExport: async (id) => {
      const error = await shell.openPath(documentService.exportPath(id));
      if (error) throw new Error(`Windows could not open this file: ${error}`);
    },
    showExport: (id) => shell.showItemInFolder(documentService.exportPath(id)),
    saveExportCopy: async (id) => {
      const path = documentService.exportPath(id);
      const ext = extname(path).slice(1);
      const format = Object.values(EXPORT_FORMATS).find((f) => f.extension === ext);
      const options = { defaultPath: basename(path), filters: [{ name: format?.label ?? ext.toUpperCase(), extensions: [ext] }] };
      const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return false;
      await copyFile(path, result.filePath);
      return true;
    },
    deleteExport: (id) => documentService.deleteExport(id),

    openExternal: (url) => {
      // Only the provider pages listed in configuration, never an address from content.
      const known = [...Object.values(PROVIDER_INFO), ...Object.values(LLM_PROVIDER_INFO)].flatMap((p) => [p.keyUrl, p.limitsUrl]);
      if (known.includes(url)) void shell.openExternal(url);
    },
  });

  const openFiles = (argv: string[]) => {
    // A shared bundle opened with EchoMind is imported whole, with its transcript and documents.
    for (const bundle of argv.filter((a) => a.toLowerCase().endsWith('.echomind') && existsSync(a))) {
      void bundles.import(bundle).then(
        (imported) => {
          refreshAll();
          emit('recording:open', imported.recordingId);
        },
        (e: unknown) => void dialog.showMessageBox({ type: 'error', message: 'This bundle could not be imported.', detail: e instanceof Error ? e.message : String(e) }),
      );
    }
    const files = filesFromArgs(argv);
    if (!files.length) return;
    void imports.enqueue(files, 'opened', settings.get().defaultMode).then((batch) => emit('imports:opened', batch));
  };

  const window = createMainWindow({ minimized: process.argv.includes('--minimized') });
  mainWindow = window;
  if (restored) window.once('ready-to-show', () => void dialog.showMessageBox(window, { type: 'info', message: 'Your backup has been restored.', detail: 'Your previous library was kept aside. You can remove it in Settings > Backup once you have checked everything. API keys are not part of backups, so add them again in Settings > AI providers.' }));
  window.on('closed', () => {
    mainWindow = null;
    logEvent('window-closed');
    // The hidden media worker is also a window, so "all windows closed" alone would never fire.
    app.quit();
  });
  window.on('unresponsive', () => logEvent('window-unresponsive'));
  window.on('responsive', () => logEvent('window-responsive'));
  // If the window's page crashes, EchoMind reopens it rather than leaving a blank window. All work lives
  // in the main process and the database, so nothing is lost; the person is told what happened.
  window.webContents.on('render-process-gone', (_e, d) => {
    if (d.reason === 'clean-exit' || window.isDestroyed()) return;
    recoveredNotice = true;
    window.webContents.reload();
  });

  // Closing during a recording must never silently lose it.
  window.on('close', (event) => {
    logEvent('window-close', recorder.isRecording && !closeConfirmed ? 'asked to confirm: recording in progress' : '');
    if (closeConfirmed || !recorder.isRecording) return;
    event.preventDefault();
    void dialog
      .showMessageBox(window, {
        type: 'warning',
        title: 'Recording in progress',
        message: 'A recording is in progress.',
        detail: 'Stop and save it before closing, or keep recording.',
        buttons: ['Stop and save', 'Keep recording'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) emit('recorder:stop-and-quit', null);
      });
  });
  ipcMain.on('recorder:closed', () => {
    closeConfirmed = true;
    window.close();
  });

  app.on('second-instance', (_e, argv) => {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.focus();
    openFiles(argv);
  });

  let closed = false;
  app.on('before-quit', () => {
    if (closed) return;
    closed = true;
    logEvent('quit');
    queue.stop();
    void recorder.stopForQuit();
    media.destroy();
    // The database is deliberately left open: background work may still be unwinding, and WAL mode is
    // safe across any exit, so closing it here could only cause errors.
  });

  await new Promise<void>((done) => window.webContents.once('did-finish-load', () => done()));
  // Background work starts after the first paint, so launch stays quick.
  void recorder.recover().then((count) => {
    if (count > 0) emit('recordings:recovered', count);
  });
  imports.resume();
  queue.resume();
  remind();
  // Transcripts made before chat existed get their passages indexed once, a few at a time so the app
  // stays responsive. Chat also indexes anything it needs that this has not reached yet.
  const indexPassages = () => {
    if (transcripts.indexMissingPassages(10) > 0) setImmediate(indexPassages);
  };
  setTimeout(indexPassages, 1500);
  void purgeTrash();
  openFiles(process.argv.slice(1));
}

void app.whenReady().then(start);
app.on('window-all-closed', () => app.quit());

