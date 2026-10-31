import { app, session, shell, type WebContents } from 'electron';

/** Only the microphone is ever granted, and only to the app's own pages. */
export function hardenSession(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const types = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
    callback(permission === 'media' && types.every((t) => t === 'audio'));
  });
  ses.setPermissionCheckHandler((_wc, permission, _origin, details) => permission === 'media' && (details as { mediaType?: string }).mediaType !== 'video');
}

/** The app is one local page. Nothing may navigate it elsewhere or open new windows inside it. */
export function hardenContents(): void {
  app.on('web-contents-created', (_e, contents: WebContents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://')) void shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (url !== contents.getURL() && !process.env.ELECTRON_RENDERER_URL) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}
