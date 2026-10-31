import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { app, type BrowserWindow, ipcMain, nativeTheme, shell } from 'electron';
import type { EchoApi, EchoEvents } from '@shared/api';
import { openDatabase } from './db/database';
import { hardenContents, hardenSession } from './security';
import { SettingsStore } from './services/settings';
import { createMainWindow } from './window';

// Tests point this at a throwaway folder so they never touch real user data.
if (process.env.ECHOMIND_USER_DATA) app.setPath('userData', process.env.ECHOMIND_USER_DATA);

if (!app.requestSingleInstanceLock()) app.quit();

let mainWindow: BrowserWindow | null = null;

function emit<E extends keyof EchoEvents>(event: E, payload: EchoEvents[E]): void {
  mainWindow?.webContents.send(event, payload);
}

function registerApi(api: EchoApi): void {
  for (const method of Object.keys(api) as (keyof EchoApi)[]) {
    ipcMain.handle(`api:${method}`, (_e, ...args: unknown[]) => (api[method] as (...a: unknown[]) => unknown)(...args));
  }
}

void app.whenReady().then(() => {
  const dataDir = app.getPath('userData');
  mkdirSync(dataDir, { recursive: true });
  const db = openDatabase(join(dataDir, 'echomind.db'));
  const settings = new SettingsStore(db);
  nativeTheme.themeSource = settings.get().theme;

  hardenSession();
  hardenContents();

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
  });

  mainWindow = createMainWindow();
  mainWindow.on('closed', () => (mainWindow = null));

  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });
  app.on('before-quit', () => db.close());
});

app.on('window-all-closed', () => app.quit());
