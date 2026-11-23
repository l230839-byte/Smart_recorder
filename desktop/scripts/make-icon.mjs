// Renders the EchoMind mark (the "Level E": an E of three audio-level bars with an echo dot, the same
// drawing as the app's BrandMark) to build/icon.png and a multi-size build/icon.ico for Windows.
// Every size is drawn at its own pixel size, and the smallest get heavier strokes, so the taskbar and
// Explorer show a sharp icon instead of a blurred downscale.
// Run with: node scripts/run.mjs electron scripts/make-icon.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';

const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

const GRADIENT = '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5146e5"/><stop offset="1" stop-color="#3a2fb8"/></linearGradient></defs>';

/**
 * Hand-placed versions for the smallest sizes, in whole pixels: a scaled drawing puts every bar between
 * two pixels and the E turns grey. [x, y, width, height] for the spine, three bars and the dot.
 */
const PIXEL_MARKS = {
  16: { radius: 3.5, bars: [[4, 3, 2, 10], [4, 3, 7, 2], [4, 7, 5, 2], [4, 11, 6, 2]], dot: [11, 7, 2, 2] },
  20: { radius: 4.5, bars: [[5, 4, 2, 12], [5, 4, 9, 2], [5, 9, 6, 2], [5, 14, 8, 2]], dot: [13, 9, 2, 2] },
  24: { radius: 5, bars: [[6, 5, 3, 15], [6, 5, 11, 3], [6, 11, 8, 3], [6, 17, 10, 3]], dot: [16, 11, 3, 3] },
  32: { radius: 8, bars: [[9, 8, 3, 17], [9, 8, 13, 3], [9, 15, 9, 3], [9, 22, 12, 3]], dot: [21, 15, 3, 3] },
};

function svg(size) {
  const pixel = PIXEL_MARKS[size];
  if (pixel) {
    const rect = ([x, y, w, h], fill) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${GRADIENT}
  <rect width="${size}" height="${size}" rx="${pixel.radius}" fill="url(#g)"/>
  <g shape-rendering="crispEdges">${pixel.bars.map((b) => rect(b, '#fff')).join('')}${rect(pixel.dot, '#c9c5ff')}</g>
</svg>`;
  }
  const stroke = 5.5;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">${GRADIENT}
  <rect width="64" height="64" rx="16" fill="url(#g)"/>
  <path d="M20 17v30M20 17h24M20 32h15M20 47h21" fill="none" stroke="#fff" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="45" cy="32" r="3.2" fill="#c9c5ff"/>
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
