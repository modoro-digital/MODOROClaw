'use strict';
const path = require('path');

const ctx = {
  mainWindow: null,
  tray: null,
  HOME: process.env.HOME || process.env.USERPROFILE || '',
  resourceDir: path.join(__dirname, '..', '..'),
  userDataDir: path.join(__dirname, '..', '..'),
  openclawProcess: null,
  botRunning: false,
  restartCount: 0,
  lastCrash: 0,
  appIsQuitting: false,
  ipcInFlightCount: 0,
  startOpenClawInFlight: false,
  wizardCompleteInFlight: false,
  gatewayRestartInFlight: false,
  gatewayLastStartedAt: 0,
};

module.exports = ctx;
