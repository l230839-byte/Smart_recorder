// Renders the EchoMind mark (the "echo quote": a quotation mark and its fainter echo, the same drawing as the
// app's BrandMark) to build/icon.png and a multi-size build/icon.ico for Windows. Every size is drawn at its
// own pixel size, so the taskbar and Explorer show a sharp icon instead of a blurred downscale.
// Run with: node scripts/run.mjs electron scripts/make-icon.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';

const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

const GRADIENT = '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5146e5"/><stop offset="1" stop-color="#3a2fb8"/></linearGradient></defs>';

/** One quotation mark: a round head and a curved tail (the same path as QUOTE_PATH in Shell.tsx). */
const QUOTE = 'M21 19.5a7.5 7.5 0 1 1 0 15 7.5 7.5 0 0 1 0-15zM28.5 27c0 10.5-5.6 17-14 19.5l-1.4-4.2c5-1.9 7.9-5.6 8.4-10.8z';

function svg(size) {
  // Below 32 px the marks are drawn a little larger, so they keep their shape in so few pixels.
  const grow = size < 32 ? 'transform="translate(32 33) scale(1.12) translate(-32 -33)"' : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">${GRADIENT}
  <rect width="64" height="64" rx="${size < 32 ? 14 : 16}" fill="url(#g)"/>
  <g ${grow}>
    <path d="${QUOTE}" fill="#fff"/>
    <path d="${QUOTE}" fill="#c9c5ff" opacity="0.8" transform="translate(20 0)"/>
  </g>
</svg>`;
}

async function render(win, size) {
  const html = `<html><body style="margin:0;background:transparent">${svg(size)}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 150));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  return image.resize({ width: size, height: size, quality: 'best' }).toPNG();
}

/** An .ico holding PNG images, which Windows has read since Vista. */
function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = 6 + 16 * pngs.length;
  const entries = pngs.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false, width: 512, height: 512, transparent: true, frame: false, webPreferences: { offscreen: true } });
    const out = join(import.meta.dirname, '..', 'build');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'icon.png'), await render(win, 512));
    const pngs = [];
    for (const size of ICO_SIZES) pngs.push({ size, data: await render(win, size) });
    writeFileSync(join(out, 'icon.ico'), ico(pngs));
    console.log(`Wrote build/icon.png and build/icon.ico (${ICO_SIZES.join(', ')} px)`);
    app.quit();
  } catch (e) {
    // An error must end Electron, or it would wait forever with no window.
    console.error(e);
    app.exit(1);
  }
});
