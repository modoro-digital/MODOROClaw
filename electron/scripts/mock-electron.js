
'use strict';
module.exports = {
  app: {
    getPath: (name) => {
      if (name === 'userData') return require('path').join(require('os').homedir(), 'AppData', 'Roaming', '9bizclaw');
      return require('os').tmpdir();
    },
    getName: () => '9bizclaw',
    isPackaged: false,
    whenReady: () => Promise.resolve(),
    on: () => {},
    requestSingleInstanceLock: () => true,
    quit: () => {},
    exit: () => {},
  },
  BrowserWindow: class BrowserWindow { constructor() {} loadFile() {} },
  ipcMain: { handle: () => {}, on: () => {} },
  shell: { openExternal: () => {} },
  dialog: { showOpenDialog: () => Promise.resolve({}) },
  powerSaveBlocker: { start: () => 0, stop: () => {}, isStarted: () => false },
  powerMonitor: { on: () => {} },
  session: { defaultSession: { webRequest: { onHeadersReceived: () => {} } }, fromPartition: () => ({ webRequest: { onHeadersReceived: () => {} } }) },
  nativeTheme: { themeSource: 'system' },
  Tray: class Tray { constructor() {} setContextMenu() {} setToolTip() {} },
  Menu: { buildFromTemplate: () => ({}) },
};
