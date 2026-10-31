import { copyFile, mkdir, rm, statfs } from 'node:fs/promises';
import { mkdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { app, dialog, ipcMain, nativeTheme, shell, type BrowserWindow } from 'electron';
import type { EchoApi, EchoEvents } from '@shared/api';
import type { RecordingMode } from '@shared/models';
import { openDatabase } from './db/database';
import { ImportRepository, LibraryRepository, SessionRepository } from './db/library';
import { hardenContents, hardenSession } from './security';
import { ImportService } from './services/imports';
import { IngestPipeline } from './services/ingest';
import { handleMediaProtocol, registerMediaScheme } from './services/media-protocol';
import { MediaWorker } from './services/media-worker';
import { RecorderService } from './services/recorder';
import { SettingsStore } from './services/settings';
import { createMainWindow } from './window';

// Tests point this at a throwaway folder so they never touch real user data.
if (process.env.ECHOMIND_USER_DATA) app.setPath('userData', process.env.ECHOMIND_USER_DATA);

registerMediaScheme();
if (!app.requestSingleInstanceLock()) app.quit();

const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'amr', 'webm', 'mka'];
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'mkv', 'm4v', 'ts'];
const VIDEO_SUFFIXES = new Set(VIDEO_EXTENSIONS.map((e) => `.${e}`));

let mainWindow: BrowserWindow | null = null;
let closeConfirmed = false;

function emit<E extends keyof EchoEvents>(event: E, payload: EchoEvents[E]): void {
  mainWindow?.webContents.send(event, payload);
}

function registerApi(api: EchoApi): void {
  for (const method of Object.keys(api) as (keyof EchoApi)[]) {
    ipcMain.handle(`api:${method}`, (_e, ...args: unknown[]) => (api[method] as (...a: unknown[]) => unknown)(...args));
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
  await Promise.all([mediaDir, tempDir, sessionDir].map((d) => mkdir(d, { recursive: true })));

  const db = openDatabase(join(dataDir, 'echomind.db'));
  const settings = new SettingsStore(db);
  const library = new LibraryRepository(db);
  const importJobs = new ImportRepository(db);
  const sessions = new SessionRepository(db);
  nativeTheme.themeSource = settings.get().theme;

  hardenSession();
  hardenContents();
  handleMediaProtocol(library, mediaDir);

  const libraryChanged = () => emit('data:changed', 'library');
  const importsChanged = () => emit('data:changed', 'imports');

  const media = new MediaWorker();
  const pipeline = new IngestPipeline(media, library, mediaDir);
  const imports = new ImportService(importJobs, library, pipeline, tempDir, importsChanged, libraryChanged);
  const recorder = new RecorderService(sessions, pipeline, sessionDir, libraryChanged);

  const deleteFiles = async (ids: string[]) => {
    const files = library.deleteForever(ids);
    await Promise.all(files.map((f) => rm(join(mediaDir, f), { force: true })));
    libraryChanged();
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

  const kindFor = (path: string) => (VIDEO_SUFFIXES.has(extname(path).toLowerCase()) ? 'video' : 'dropped') as 'video' | 'dropped';
  const enqueueMixed = async (paths: string[], mode: RecordingMode, base: 'picker' | 'dropped' | 'opened') => {
    const videos = paths.filter((p) => kindFor(p) === 'video');
    const audio = paths.filter((p) => kindFor(p) !== 'video');
    const batch = audio.length ? await imports.enqueue(audio, base, mode) : null;
    const videoBatch = videos.length ? await imports.enqueue(videos, 'video', mode) : null;
    return (batch ?? videoBatch)!;
  };

  const sqlite = db.prepare('SELECT sqlite_version() AS v').get() as { v: string };
  registerApi({
    getSettings: () => settings.get(),
    updateSettings: (patch) => {
      const next = settings.update(patch);
      nativeTheme.themeSource = next.theme;
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
    trashRecordings: mutate((ids) => library.trash(ids)),
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
        await media.convert(join(mediaDir, file.fileName), workFile, { container, transcode: false, startMs, endMs });
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
      return enqueueMixed(result.filePaths, mode, 'picker');
    },
    importPaths: (paths, mode) => enqueueMixed(paths, mode, 'dropped'),
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
  });

  const openFiles = (argv: string[]) => {
    const files = filesFromArgs(argv);
    if (!files.length) return;
    void enqueueMixed(files, settings.get().defaultMode, 'opened').then((batch) => emit('imports:opened', batch));
  };

  const window = createMainWindow();
  mainWindow = window;
  window.on('closed', () => {
    mainWindow = null;
    // The hidden media worker is also a window, so "all windows closed" alone would never fire.
    app.quit();
  });

  // Closing during a recording must never silently lose it.
  window.on('close', (event) => {
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
    void recorder.stopForQuit();
    media.destroy();
  });
  app.on('will-quit', () => db.close());

  await new Promise<void>((done) => window.webContents.once('did-finish-load', () => done()));
  // Background work starts after the first paint, so launch stays quick.
  void recorder.recover().then((count) => {
    if (count > 0) emit('recordings:recovered', count);
  });
  imports.resume();
  void purgeTrash();
  openFiles(process.argv.slice(1));
}

void app.whenReady().then(start);
app.on('window-all-closed', () => app.quit());

