import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { EchoBridge } from '@shared/api';

const bridge: EchoBridge = {
  call: (method, ...args) => ipcRenderer.invoke(`api:${method}`, ...args),
  on: (event, listener) => {
    const handler = (_: unknown, payload: Parameters<typeof listener>[0]) => listener(payload);
    ipcRenderer.on(event, handler);
    return () => ipcRenderer.removeListener(event, handler);
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
  closeAfterRecording: () => ipcRenderer.send('recorder:closed'),
  platform: process.platform,
};

contextBridge.exposeInMainWorld('echomind', bridge);
