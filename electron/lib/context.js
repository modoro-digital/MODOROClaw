'use strict';
const path = require('path');

/**
 * Global shared context — singleton state object passed between all lib/ modules.
 * @typedef {Object} AppContext
 * @property {Electron.BrowserWindow|null} mainWindow - Main dashboard window
 * @property {Electron.Tray|null} tray - System tray icon
 * @property {string} HOME - User home directory
 * @property {string} resourceDir - Electron resources directory (app root in dev)
 * @property {string} userDataDir - Electron userData directory (app root in dev)
 * @property {import('child_process').ChildProcess|null} openclawProcess - Gateway child process
 * @property {boolean} botRunning - Whether gateway is confirmed alive on :18789
 * @property {number} restartCount - Gateway crash counter (used by watchdog rate limiter)
 * @property {number} lastCrash - Timestamp of last gateway crash (for restart backoff)
 * @property {boolean} appIsQuitting - Set by before-quit handler to suppress auto-restart
 * @property {number} ipcInFlightCount - Count of mutating IPC handlers currently executing
 * @property {boolean} startOpenClawInFlight - Re-entrant guard for startOpenClaw()
 * @property {boolean} wizardCompleteInFlight - Guard for wizard-complete IPC
 * @property {boolean} gatewayRestartInFlight - Guard for watchdog-triggered restart
 * @property {number} gatewayLastStartedAt - Timestamp of last successful gateway start
 */
const ctx = {
  mainWindow: null,
  tray: null,
  HOME: process.env.HOME || process.env.USERPROFILE || '',
  resourceDir: path.join(__dirname, '..', '..'),
  userDataDir: path.join(__dirname, '..', '..'),
  openclawProcess: null,
  botRunning: false,
  restartCount: 0,   // used by watchdog rate limiter
  lastCrash: 0,      // timestamp for restart backoff calculation
  appIsQuitting: false,
  ipcInFlightCount: 0,
  startOpenClawInFlight: false,
  wizardCompleteInFlight: false,
  gatewayRestartInFlight: false,
  gatewayLastStartedAt: 0,
};

module.exports = ctx;
