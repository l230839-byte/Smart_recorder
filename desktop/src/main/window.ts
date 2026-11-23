import { join } from 'node:path';
import { app, BrowserWindow, nativeTheme } from 'electron';

const BAR_HEIGHT = 44;

function overlay() {
  const dark = nativeTheme.shouldUseDarkColors;
  return { color: '#00000000', symbolColor: dark ? '#E7E5E0' : '#3A3833', height: BAR_HEIGHT };
}

export function backgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? '#111218' : '#F5F6F9';
}

/** `minimized` is for starting with Windows: EchoMind runs for reminders without covering the desktop. */
export function createMainWindow(options: { minimized?: boolean } = {}): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 860,
    minHeight: 600,
    show: false,
    title: 'EchoMind',
    // The installed app takes its icon from the .exe; a development build would otherwise show Electron's.
    ...(app.isPackaged ? {} : { icon: join(__dirname, '../../build/icon.ico') }),
    backgroundColor: backgroundColor(),
    titleBarStyle: 'hidden',
    titleBarOverlay: overlay(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Recording and playback must keep running at full rate while the window is hidden.
      backgroundThrottling: false,
    },
  });

  const onTheme = () => {
    win.setTitleBarOverlay(overlay());
    win.setBackgroundColor(backgroundColor());
  };
  nativeTheme.on('updated', onTheme);
  win.on('closed', () => nativeTheme.off('updated', onTheme));

  win.once('ready-to-show', () => (options.minimized ? win.showInactive() : win.show()));
  if (options.minimized) win.once('ready-to-show', () => win.minimize());

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
  return win;
}
