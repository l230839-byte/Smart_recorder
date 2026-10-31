import { join } from 'node:path';
import { BrowserWindow, nativeTheme } from 'electron';

const BAR_HEIGHT = 44;

function overlay() {
  const dark = nativeTheme.shouldUseDarkColors;
  return { color: '#00000000', symbolColor: dark ? '#E7E5E0' : '#3A3833', height: BAR_HEIGHT };
}

export function backgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? '#14131A' : '#F7F6F2';
}

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 860,
    minHeight: 600,
    show: false,
    title: 'EchoMind',
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

  win.once('ready-to-show', () => win.show());

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
  return win;
}
