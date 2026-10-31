import { contextBridge, ipcRenderer } from 'electron';
import type { MediaBridge, MediaJob } from '@shared/media-jobs';

const bridge: MediaBridge = {
  onJob: (listener) => {
    ipcRenderer.on('media:job', (_e, id: number, job: MediaJob) => listener(id, job));
  },
  done: (id, value) => ipcRenderer.send('media:done', id, value),
  fail: (id, message) => ipcRenderer.send('media:fail', id, message),
  progress: (id, value) => ipcRenderer.send('media:progress', id, value),
  size: (handle) => ipcRenderer.invoke('media:size', handle),
  read: (handle, start, end) => ipcRenderer.invoke('media:read', handle, start, end),
  write: (handle, position, data) => ipcRenderer.invoke('media:write', handle, position, data),
  ready: () => ipcRenderer.send('media:ready'),
};

contextBridge.exposeInMainWorld('mediaBridge', bridge);
