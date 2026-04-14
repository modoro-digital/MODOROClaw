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
  getOverviewData: () => ipcRenderer.invoke('get-overview-data'),
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
  onZaloCacheRefreshed: (cb) => ipcRenderer.on('zalo-cache-refreshed', cb),
  getZaloManagerConfig: () => ipcRenderer.invoke('get-zalo-manager-config'),
  saveZaloManagerConfig: (config) => ipcRenderer.invoke('save-zalo-manager-config', config),
  getZaloGroupSummaries: () => ipcRenderer.invoke('get-zalo-group-summaries'),

  // Personalization
  savePersonalization: (opts) => ipcRenderer.invoke('save-personalization', opts),
  saveBusinessProfile: (opts) => ipcRenderer.invoke('save-business-profile', opts),

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

  // App version
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // Zalo owner identification
  getZaloOwner: () => ipcRenderer.invoke('get-zalo-owner'),
  saveZaloOwner: (payload) => ipcRenderer.invoke('save-zalo-owner', payload),

  // Dashboard PIN (Security Layer 4)
  getPinStatus: () => ipcRenderer.invoke('get-pin-status'),
  setupPin: (pin) => ipcRenderer.invoke('setup-pin', { pin }),
  verifyPin: (pin) => ipcRenderer.invoke('verify-pin', { pin }),
  resetPin: (telegramUserId, newPin) => ipcRenderer.invoke('reset-pin', { telegramUserId, newPin }),
  changePin: (oldPin, newPin) => ipcRenderer.invoke('change-pin', { oldPin, newPin }),

  // Zalo per-user memory
  listZaloUserMemories: () => ipcRenderer.invoke('list-zalo-user-memories'),
  readZaloUserMemory: (senderId) => ipcRenderer.invoke('read-zalo-user-memory', { senderId }),
  resetZaloUserMemory: (senderId) => ipcRenderer.invoke('reset-zalo-user-memory', { senderId }),
  appendZaloUserNote: (senderId, note) => ipcRenderer.invoke('append-zalo-user-note', { senderId, note }),
  deleteZaloUserNote: (senderId, noteTimestamp) => ipcRenderer.invoke('delete-zalo-user-note', { senderId, noteTimestamp }),

  // Knowledge tab
  uploadKnowledgeFile: (category, filepath, originalName) => ipcRenderer.invoke('upload-knowledge-file', { category, filepath, originalName }),
  listKnowledgeFiles: (category) => ipcRenderer.invoke('list-knowledge-files', { category }),
  deleteKnowledgeFile: (category, filename) => ipcRenderer.invoke('delete-knowledge-file', { category, filename }),
  getKnowledgeCounts: () => ipcRenderer.invoke('get-knowledge-counts'),
  pickKnowledgeFile: () => ipcRenderer.invoke('pick-knowledge-file'),
  listKnowledgeFolders: () => ipcRenderer.invoke('list-knowledge-folders'),
  createKnowledgeFolder: (name) => ipcRenderer.invoke('create-knowledge-folder', { name }),
  deleteKnowledgeFolder: (id) => ipcRenderer.invoke('delete-knowledge-folder', { id }),

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

  // Appointments (local calendar)
  listAppointments: () => ipcRenderer.invoke('list-appointments'),
  createAppointment: (data) => ipcRenderer.invoke('create-appointment', data),
  updateAppointment: (id, patch) => ipcRenderer.invoke('update-appointment', { id, patch }),
  deleteAppointment: (id) => ipcRenderer.invoke('delete-appointment', { id }),
  resolveZaloTarget: (query, type) => ipcRenderer.invoke('resolve-zalo-target', { query, type }),

  // Google Calendar
  gcalConnect: () => ipcRenderer.invoke('gcal-connect'),
  gcalDisconnect: () => ipcRenderer.invoke('gcal-disconnect'),
  gcalGetStatus: () => ipcRenderer.invoke('gcal-get-status'),
  gcalListEvents: (opts) => ipcRenderer.invoke('gcal-list-events', opts || {}),
  gcalGetFreeSlots: (opts) => ipcRenderer.invoke('gcal-get-free-slots', opts),
  gcalCreateEvent: (opts) => ipcRenderer.invoke('gcal-create-event', opts),
  gcalGetFreeBusy: (opts) => ipcRenderer.invoke('gcal-get-freebusy', opts),
  gcalGetConfig: () => ipcRenderer.invoke('gcal-get-config'),
  gcalSaveConfig: (cfg) => ipcRenderer.invoke('gcal-save-config', cfg),

  // Channel pause/resume (symmetric for Telegram + Zalo)
  pauseTelegram: (minutes) => ipcRenderer.invoke('pause-telegram', { minutes }),
  resumeTelegram: () => ipcRenderer.invoke('resume-telegram'),
  getTelegramPauseStatus: () => ipcRenderer.invoke('get-telegram-pause-status'),
  pauseZalo: (minutes) => ipcRenderer.invoke('pause-zalo', { minutes }),
  resumeZalo: () => ipcRenderer.invoke('resume-zalo'),
  getZaloPauseStatus: () => ipcRenderer.invoke('get-zalo-pause-status'),

  // App preferences (start minimized, etc.)
  getAppPrefs: () => ipcRenderer.invoke('get-app-prefs'),
  setAppPrefs: (partial) => ipcRenderer.invoke('set-app-prefs', partial),

  // Diagnostic log export — lets Dashboard grab main.log without DevTools
  getDiagnosticLog: (opts) => ipcRenderer.invoke('get-diagnostic-log', opts || {}),
  openLogFolder: () => ipcRenderer.invoke('open-log-folder'),

  // Factory reset — wipe all user data (Dashboard button, not installer)
  factoryReset: () => ipcRenderer.invoke('factory-reset'),

  // Export / import workspace — backup to tar file and restore from tar
  exportWorkspace: () => ipcRenderer.invoke('export-workspace'),
  importWorkspace: () => ipcRenderer.invoke('import-workspace'),

  // Shop state — "Tình trạng hôm nay" (real-time context for bot)
  getShopState: () => ipcRenderer.invoke('get-shop-state'),
  setShopState: (state) => ipcRenderer.invoke('set-shop-state', state),

  // Persona mix — Dashboard re-edit after wizard
  getPersonaMix: () => ipcRenderer.invoke('get-persona-mix'),
  savePersonaMix: (mix) => ipcRenderer.invoke('save-persona-mix', mix),

  // Events
  onBotStatus: (callback) => {
    ipcRenderer.removeAllListeners('bot-status');
    ipcRenderer.on('bot-status', (_, data) => callback(data));
  },
});
