// Renders the brand mark (the same drawing as the app's sidebar) to build/icon.png, which the installer
// turns into the Windows icon. Run with: node scripts/run.mjs electron scripts/make-icon.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';

const SIZE = 512;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="9" fill="#4338ca"/>
  <g stroke="#ffffff" stroke-width="2.4" stroke-linecap="round"><path d="M8 14v4M12.5 10.5v11M17 7.5v17M21.5 11.5v9M26 14.5v3"/></g>
</svg>`;
const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`;

app.whenReady().then(async () => {
  try {
  const win = new BrowserWindow({ show: false, width: SIZE, height: SIZE, transparent: true, frame: false, webPreferences: { offscreen: true } });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  mkdirSync(join(import.meta.dirname, '..', 'build'), { recursive: true });
  writeFileSync(join(import.meta.dirname, '..', 'build', 'icon.png'), image.resize({ width: SIZE, height: SIZE }).toPNG());
  app.quit();
  } catch (e) {
    // An error must end Electron, or it would wait forever with no window.
    console.error(e);
    app.exit(1);
  }
});
