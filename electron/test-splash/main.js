const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const ROOT = path.join(__dirname, '..');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 540, height: 400,
    minWidth: 540, minHeight: 400,
    frame: false, resizable: true, movable: true,
    backgroundColor: '#0a0a0c',
    webPreferences: {
      preload: path.join(ROOT, 'splash-preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  ipcMain.on('splash-minimize', () => { try { win.minimize(); } catch {} });
  ipcMain.on('splash-resize-error', () => {
    try { win.setMinimumSize(540, 580); win.setSize(540, 580, true); win.center(); } catch {}
  });
  ipcMain.on('splash-retry', () => app.quit());
  ipcMain.on('splash-quit', () => app.quit());
  ipcMain.on('splash-cancel', () => app.quit());

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(ROOT, 'ui', 'splash.html'));
  win.show();

  setTimeout(() => win.webContents.send('splash-progress', { step: 'check' }), 500);
  setTimeout(() => win.webContents.send('splash-progress', { step: 'node', message: 'Downloading Node.js v22.22.2...', percent: 5 }), 1000);
  setTimeout(() => win.webContents.send('splash-progress', { step: 'node-done' }), 2000);
  setTimeout(() => win.webContents.send('splash-progress', { step: 'packages', subStep: 'npm install openclaw 9router openzca', percent: 30 }), 2500);
  setTimeout(() => win.webContents.send('splash-error',
    'npm ERR! code ETIMEDOUT\nnpm ERR! errno ETIMEDOUT\n' +
    'npm ERR! network request to https://registry.npmjs.org/openclaw failed, reason: connect ETIMEDOUT 104.16.19.35:443\n' +
    'npm ERR! network This is a problem related to network connectivity.\n\n' +
    'Exit code: 1\nDuration: 45123ms\nAttempt 3/4 failed.'
  ), 4000);
});
