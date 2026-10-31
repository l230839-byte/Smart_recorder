// Generates test media with the app's own codecs. Run through Electron by tests/e2e/fixtures.ts.
const { app, BrowserWindow, ipcMain } = require('electron');
const { writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const outDir = process.argv[process.argv.length - 1];
app.whenReady().then(() => {
  mkdirSync(outDir, { recursive: true });
  ipcMain.on('write', (_e, name, data) => writeFileSync(join(outDir, name), Buffer.from(data)));
  ipcMain.on('done', () => app.exit(0));
  ipcMain.on('fail', (_e, message) => {
    console.error(message);
    app.exit(1);
  });
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
  void win.loadFile(join(__dirname, 'page.html'));
});
