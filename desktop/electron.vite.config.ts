import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import type { Plugin } from 'vite';

const alias = { '@shared': resolve(__dirname, 'src/shared') };

/** The production CSP is strict. Dev only adds what Vite's hot reload needs. */
function contentSecurityPolicy(): Plugin {
  return {
    name: 'echomind-csp',
    transformIndexHtml(html, ctx) {
      const dev = ctx.server != null;
      const policy = [
        "default-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "font-src 'self'",
        "img-src 'self' data:",
        'media-src echomind-media:',
        dev ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'",
        dev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
        dev ? "connect-src 'self' ws: echomind-media:" : "connect-src 'self' echomind-media:",
      ].join('; ');
      return html.replace('%CSP%', policy);
    },
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          media: resolve(__dirname, 'src/preload/media.ts'),
        },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    resolve: { alias },
    plugins: [react(), contentSecurityPolicy()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          media: resolve(__dirname, 'src/renderer/media.html'),
        },
      },
    },
  },
});
