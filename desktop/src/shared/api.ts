import type { AppInfo, Settings } from './models';

/**
 * Everything the UI may ask of the main process. The preload bridge exposes exactly this surface
 * (see `src/preload/index.ts`); the renderer has no other access to Node, files or the database.
 */
export interface EchoApi {
  getSettings(): Settings;
  updateSettings(patch: Partial<Settings>): Settings;
  getAppInfo(): AppInfo;
  openDataFolder(): void;
}

/** Events pushed from the main process to the UI. */
export interface EchoEvents {
  /** Stored data changed; screens re-read what they show. The value names the area. */
  'data:changed': 'settings' | 'library' | 'imports';
}

export type ApiMethod = keyof EchoApi;

export interface EchoBridge {
  call<M extends ApiMethod>(method: M, ...args: Parameters<EchoApi[M]>): Promise<Awaited<ReturnType<EchoApi[M]>>>;
  on<E extends keyof EchoEvents>(event: E, listener: (payload: EchoEvents[E]) => void): () => void;
  platform: string;
}
