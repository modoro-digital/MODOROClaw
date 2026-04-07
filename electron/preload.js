const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('claw', {
  // Config
  saveWizardConfig: (configs) => ipcRenderer.invoke('save-wizard-config', configs),
  setBatchConfig: (ops) => ipcRenderer.invoke('set-batch-config', ops),

  // Cron
  addCron: (opts) => ipcRenderer.invoke('add-cron', opts),

  // Telegram
  testTelegram: (token, chatId) => ipcRenderer.invoke('test-telegram', { token, chatId }),

  // Wizard
  wizardComplete: () => ipcRenderer.invoke('wizard-complete'),

  // Dashboard
  getDashboard: () => ipcRenderer.invoke('get-dashboard'),
  checkAllChannels: () => ipcRenderer.invoke('check-all-channels'),
  getBotStatus: () => ipcRenderer.invoke('get-bot-status'),
  toggleBot: () => ipcRenderer.invoke('toggle-bot'),

  // 9Router
  start9Router: () => ipcRenderer.invoke('start-9router'),
  setup9RouterAuto: (opts) => ipcRenderer.invoke('setup-9router-auto', opts),

  // Zalo
  setupZalo: () => ipcRenderer.invoke('setup-zalo'),
  findZaloQR: () => ipcRenderer.invoke('find-zalo-qr'),
  checkZaloLogin: () => ipcRenderer.invoke('check-zalo-login'),
  saveZaloMode: (mode) => ipcRenderer.invoke('save-zalo-mode', mode),
  getZaloMode: () => ipcRenderer.invoke('get-zalo-mode'),
  listZaloFriends: () => ipcRenderer.invoke('list-zalo-friends'),
  listZaloGroups: () => ipcRenderer.invoke('list-zalo-groups'),
  refreshZaloCache: () => ipcRenderer.invoke('refresh-zalo-cache'),
  getZaloManagerConfig: () => ipcRenderer.invoke('get-zalo-manager-config'),
  saveZaloManagerConfig: (config) => ipcRenderer.invoke('save-zalo-manager-config', config),

  // Personalization
  savePersonalization: (opts) => ipcRenderer.invoke('save-personalization', opts),

  // Google
  setupGoogle: () => ipcRenderer.invoke('setup-google'),

  // OpenClaw installation
  installOpenClaw: (onProgress) => {
    ipcRenderer.removeAllListeners('install-progress');
    ipcRenderer.on('install-progress', (_, step) => onProgress(step));
    return ipcRenderer.invoke('install-openclaw');
  },
  relaunch: () => ipcRenderer.invoke('relaunch'),

  // Open external URL
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getGatewayToken: () => ipcRenderer.invoke('get-gateway-token'),

  // Schedules
  getSchedules: () => ipcRenderer.invoke('get-schedules'),
  saveSchedules: (schedules) => ipcRenderer.invoke('save-schedules', schedules),
  getCustomCrons: () => ipcRenderer.invoke('get-custom-crons'),
  saveCustomCrons: (crons) => ipcRenderer.invoke('save-custom-crons', crons),
  onCustomCronsUpdated: (cb) => ipcRenderer.on('custom-crons-updated', (_e, data) => cb(data)),
  onSchedulesUpdated: (cb) => ipcRenderer.on('schedules-updated', (_e, data) => cb(data)),
  testCron: (type, id) => ipcRenderer.invoke('test-cron', { type, id }),

  // Knowledge tab
  uploadKnowledgeFile: (category, filepath, originalName) => ipcRenderer.invoke('upload-knowledge-file', { category, filepath, originalName }),
  listKnowledgeFiles: (category) => ipcRenderer.invoke('list-knowledge-files', { category }),
  deleteKnowledgeFile: (category, filename) => ipcRenderer.invoke('delete-knowledge-file', { category, filename }),
  getKnowledgeCounts: () => ipcRenderer.invoke('get-knowledge-counts'),
  pickKnowledgeFile: () => ipcRenderer.invoke('pick-knowledge-file'),

  // Document Library
  indexDocument: (opts) => ipcRenderer.invoke('index-document', opts),
  searchDocuments: (query) => ipcRenderer.invoke('search-documents', query),
  listDocuments: () => ipcRenderer.invoke('list-documents'),
  deleteDocument: (filename) => ipcRenderer.invoke('delete-document', filename),

  // Channel readiness probes — real proof channels can receive messages
  checkTelegramReady: () => ipcRenderer.invoke('check-telegram-ready'),
  checkZaloReady: () => ipcRenderer.invoke('check-zalo-ready'),
  telegramSelfTest: () => ipcRenderer.invoke('telegram-self-test'),
  onChannelStatus: (callback) => {
    ipcRenderer.removeAllListeners('channel-status');
    ipcRenderer.on('channel-status', (_, data) => callback(data));
  },

  // Events
  onBotStatus: (callback) => {
    ipcRenderer.removeAllListeners('bot-status');
    ipcRenderer.on('bot-status', (_, data) => callback(data));
  },
});
