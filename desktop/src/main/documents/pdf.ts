import { BrowserWindow } from 'electron';
import { escapeHtml, MARGIN_MM, type DocumentSettings } from '@shared/documents';

const MM_PER_INCH = 25.4;

function running(text: string, pageNumbers: boolean, side: 'header' | 'footer', inset: number): string {
  const numbers = pageNumbers && side === 'footer' ? '<span><span class="pageNumber"></span> / <span class="totalPages"></span></span>' : '<span></span>';
  return `<div style="width:100%;display:flex;justify-content:space-between;gap:12px;padding:0 ${inset}in;font-family:'Segoe UI',sans-serif;font-size:8px;color:#777;"><span dir="auto">${escapeHtml(text)}</span>${numbers}</div>`;
}

/**
 * Prints a document page to PDF with Chromium, which shapes Urdu and other complex scripts correctly
 * and embeds the fonts. The page has no script of its own; the window is hidden and sandboxed.
 */
export async function renderPdf(url: string, settings: DocumentSettings): Promise<Buffer> {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await win.loadURL(url);
    // Embedded fonts load asynchronously; printing earlier could fall back to system fonts.
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
    const margin = MARGIN_MM[settings.margins] / MM_PER_INCH;
    const withRunning = settings.pageNumbers || !!settings.header || !!settings.footer;
    return await win.webContents.printToPDF({
      pageSize: settings.pageSize,
      printBackground: true,
      margins: { top: margin, bottom: margin, left: margin, right: margin },
      displayHeaderFooter: withRunning,
      headerTemplate: running(settings.header, false, 'header', margin / 2),
      footerTemplate: running(settings.footer, settings.pageNumbers, 'footer', margin / 2),
      generateDocumentOutline: true,
      generateTaggedPDF: true,
    });
  } finally {
    win.destroy();
  }
}
