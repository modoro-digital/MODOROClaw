const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('splash', {
  onProgress: (cb) => ipcRenderer.on('splash-progress', (_e, data) => cb(data)),
  onError: (cb) => ipcRenderer.on('splash-error', (_e, msg) => cb(msg)),
});
