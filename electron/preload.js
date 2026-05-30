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
  onZaloCacheRefreshed: (cb) => {
    ipcRenderer.removeAllListeners('zalo-cache-refreshed');
    ipcRenderer.on('zalo-cache-refreshed', cb);
  },
  getZaloManagerConfig: () => ipcRenderer.invoke('get-zalo-manager-config'),
  saveZaloManagerConfig: (config) => ipcRenderer.invoke('save-zalo-manager-config', config),
  getZaloGroupSummaries: () => ipcRenderer.invoke('get-zalo-group-summaries'),
  getZaloGroupMemory: (groupId) => ipcRenderer.invoke('get-zalo-group-memory', groupId),
  seedGroupHistoryNow: (groupId, threadName, opts) => ipcRenderer.invoke('seed-group-history-now', groupId, threadName, opts),
  getZaloMenuCatalog: () => ipcRenderer.invoke('get-zalo-menu-catalog'),
  saveZaloMenuCatalog: (catalog) => ipcRenderer.invoke('save-zalo-menu-catalog', catalog),
  dryRunZaloMenuCommand: (command, catalog) => ipcRenderer.invoke('dry-run-zalo-menu-command', { command, catalog }),
  downloadZaloMenuTemplate: () => ipcRenderer.invoke('download-zalo-menu-template'),
  pickZaloMenuImport: () => ipcRenderer.invoke('pick-zalo-menu-import'),
  previewZaloMenuImport: (token) => ipcRenderer.invoke('preview-zalo-menu-import', token),
  applyZaloMenuImport: (token) => ipcRenderer.invoke('apply-zalo-menu-import', token),

  // Personalization
  savePersonalization: (opts) => ipcRenderer.invoke('save-personalization', opts),
  saveBusinessProfile: (opts) => ipcRenderer.invoke('save-business-profile', opts),

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
  deleteOpenclawCron: (jobId) => ipcRenderer.invoke('delete-openclaw-cron', jobId),
  // CRIT #10: Always removeAllListeners before re-registering so renderer
  // hot-reloads don't stack N listeners that all fire per event.
  onCustomCronsUpdated: (cb) => {
    ipcRenderer.removeAllListeners('custom-crons-updated');
    ipcRenderer.on('custom-crons-updated', (_e, data) => cb(data));
  },
  onSchedulesUpdated: (cb) => {
    ipcRenderer.removeAllListeners('schedules-updated');
    ipcRenderer.on('schedules-updated', (_e, data) => cb(data));
  },
  testCron: (type, id) => ipcRenderer.invoke('test-cron', { type, id }),

  // App version
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // Zalo per-user memory
  listZaloUserMemories: () => ipcRenderer.invoke('list-zalo-user-memories'),
  readZaloUserMemory: (senderId) => ipcRenderer.invoke('read-zalo-user-memory', { senderId }),
  resetZaloUserMemory: (senderId) => ipcRenderer.invoke('reset-zalo-user-memory', { senderId }),
  appendZaloUserNote: (senderId, note) => ipcRenderer.invoke('append-zalo-user-note', { senderId, note }),
  deleteZaloUserNote: (senderId, noteTimestamp) => ipcRenderer.invoke('delete-zalo-user-note', { senderId, noteTimestamp }),

  // Knowledge tab
  uploadKnowledgeFile: (category, filepath, originalName, visibility = 'public') => ipcRenderer.invoke('upload-knowledge-file', { category, filepath, originalName, visibility }),
  listKnowledgeFiles: (category) => ipcRenderer.invoke('list-knowledge-files', { category }),
  deleteKnowledgeFile: (category, filename) => ipcRenderer.invoke('delete-knowledge-file', { category, filename }),
  getKnowledgeCounts: () => ipcRenderer.invoke('get-knowledge-counts'),
  pickKnowledgeFile: () => ipcRenderer.invoke('pick-knowledge-file'),
  listKnowledgeFolders: () => ipcRenderer.invoke('list-knowledge-folders'),
  setKnowledgeVisibility: (docId, visibility) => ipcRenderer.invoke('set-knowledge-visibility', { docId, visibility }),
  setKnowledgeEnabled: (docId, enabled) => ipcRenderer.invoke('set-knowledge-enabled', { docId, enabled }),
  createKnowledgeFolder: (name) => ipcRenderer.invoke('create-knowledge-folder', { name }),
  deleteKnowledgeFolder: (id) => ipcRenderer.invoke('delete-knowledge-folder', { id }),
  knowledgeSearch: (query, category, limit) => ipcRenderer.invoke('knowledge-search', { query, category, limit }),
  openKnowledgeFolder: (category) => ipcRenderer.invoke('open-knowledge-folder', { category }),
  onKnowledgeUpdated: (cb) => { ipcRenderer.removeAllListeners('knowledge-updated'); ipcRenderer.on('knowledge-updated', cb); },
  getRagConfig: () => ipcRenderer.invoke('get-rag-config'),
  setRagConfig: (cfg) => ipcRenderer.invoke('set-rag-config', cfg),

  // CEO Memory
  getCeoMemories: () => ipcRenderer.invoke('get-ceo-memories'),
  deleteCeoMemory: (id) => ipcRenderer.invoke('delete-ceo-memory', { id }),
  writeCeoMemory: (type, content, source) => ipcRenderer.invoke('write-ceo-memory', { type, content, source }),
  searchCeoMemories: (query, limit) => ipcRenderer.invoke('search-ceo-memories', { query, limit }),
  updateCeoMemoryStatus: (id, status) => ipcRenderer.invoke('update-ceo-memory-status', { id, status }),
  prioritizeCeoMemory: (id, delta) => ipcRenderer.invoke('prioritize-ceo-memory', { id, delta }),
  supersedeCeoMemory: (id, supersededById) => ipcRenderer.invoke('supersede-ceo-memory', { id, supersededById }),
  getCeoMemoryEvents: (opts) => ipcRenderer.invoke('get-ceo-memory-events', opts || {}),
  getCeoMemoryCount: () => ipcRenderer.invoke('get-ceo-memory-count'),

  // Document Library
  indexDocument: (opts) => ipcRenderer.invoke('index-document', opts),
  searchDocuments: (query) => ipcRenderer.invoke('search-documents', query),
  listDocuments: () => ipcRenderer.invoke('list-documents'),
  deleteDocument: (filename) => ipcRenderer.invoke('delete-document', filename),

  // Telegram config (Dashboard settings)
  getTelegramConfig: () => ipcRenderer.invoke('get-telegram-config'),
  saveTelegramConfig: (botToken, userId) => ipcRenderer.invoke('save-telegram-config', { botToken, userId }),

  // Telegram behavior settings (mirrors Zalo behavior pattern)
  getTelegramBehavior: () => ipcRenderer.invoke('get-telegram-behavior'),
  saveTelegramBehavior: (behavior) => ipcRenderer.invoke('save-telegram-behavior', behavior),

  // Channel readiness probes — real proof channels can receive messages
  checkTelegramReady: () => ipcRenderer.invoke('check-telegram-ready'),
  checkZaloReady: () => ipcRenderer.invoke('check-zalo-ready'),
  telegramSelfTest: () => ipcRenderer.invoke('telegram-self-test'),
  getInboundDebounce: () => ipcRenderer.invoke('get-inbound-debounce'),
  setInboundDebounce: (channel, ms) => ipcRenderer.invoke('set-inbound-debounce', { channel, ms }),
  onChannelStatus: (callback) => {
    ipcRenderer.removeAllListeners('channel-status');
    ipcRenderer.on('channel-status', (_, data) => callback(data));
  },
  onZaloFriendsRefreshed: (callback) => {
    ipcRenderer.removeAllListeners('zalo-friends-refreshed');
    ipcRenderer.on('zalo-friends-refreshed', () => callback());
  },
  onZaloManagerConfigChanged: (callback) => {
    ipcRenderer.removeAllListeners('zalo-manager-config-changed');
    ipcRenderer.on('zalo-manager-config-changed', (_, data) => callback(data));
  },

  // Appointments (local calendar)
  listAppointments: () => ipcRenderer.invoke('list-appointments'),
  createAppointment: (data) => ipcRenderer.invoke('create-appointment', data),
  updateAppointment: (id, patch) => ipcRenderer.invoke('update-appointment', { id, patch }),
  deleteAppointment: (id) => ipcRenderer.invoke('delete-appointment', { id }),
  resolveZaloTarget: (query, type) => ipcRenderer.invoke('resolve-zalo-target', { query, type }),

  // First-time channel guide
  checkGuideNeeded: (channel) => ipcRenderer.invoke('check-guide-needed', { channel }),
  markGuideComplete: (channel) => ipcRenderer.invoke('mark-guide-complete', { channel }),

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

  // User Skills
  listAllSkills: () => ipcRenderer.invoke('list-all-skills'),
  getSkillDetail: (id, source) => ipcRenderer.invoke('get-skill-detail', id, source),
  createUserSkill: (data) => ipcRenderer.invoke('create-user-skill', data),
  updateUserSkill: (id, data) => ipcRenderer.invoke('update-user-skill', id, data),
  deleteUserSkill: (id) => ipcRenderer.invoke('delete-user-skill', id),
  toggleUserSkill: (id, enabled) => ipcRenderer.invoke('toggle-user-skill', id, enabled),
  checkSkillConflict: (data) => ipcRenderer.invoke('check-skill-conflict', data),
  restoreUserSkill: (id) => ipcRenderer.invoke('restore-user-skill', id),
  onSkillUpdated: (callback) => {
    ipcRenderer.removeAllListeners('skill-updated');
    ipcRenderer.on('skill-updated', (_, data) => callback(data));
  },

  // Brand Assets
  listBrandAssets: () => ipcRenderer.invoke('list-brand-assets'),
  uploadBrandAsset: (filePath, name) => ipcRenderer.invoke('upload-brand-asset', filePath, name),
  deleteBrandAsset: (name) => ipcRenderer.invoke('delete-brand-asset', name),
  pickBrandAssetFile: () => ipcRenderer.invoke('pick-brand-asset-file'),
  listMediaAssets: (filters) => ipcRenderer.invoke('list-media-assets', filters || {}),
  uploadMediaAsset: (opts) => ipcRenderer.invoke('upload-media-asset', opts || {}),
  describeMediaAsset: (id) => ipcRenderer.invoke('describe-media-asset', id),
  deleteMediaAsset: (id) => ipcRenderer.invoke('delete-media-asset', id),
  pickMediaAssetFile: () => ipcRenderer.invoke('pick-media-asset-file'),

  // Events
  onBotStatus: (callback) => {
    ipcRenderer.removeAllListeners('bot-status');
    ipcRenderer.on('bot-status', (_, data) => callback(data));
  },
  // Auto-update
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadAndInstallUpdate: () => ipcRenderer.invoke('download-and-install-update'),
  onUpdateAvailable: (cb) => {
    ipcRenderer.removeAllListeners('update-available');
    ipcRenderer.on('update-available', (_event, data) => cb(data));
  },
  onUpdateDownloadProgress: (cb) => {
    ipcRenderer.removeAllListeners('update-download-progress');
    ipcRenderer.on('update-download-progress', (_event, data) => cb(data));
  },
  onUpdateInstallStatus: (cb) => {
    ipcRenderer.removeAllListeners('update-install-status');
    ipcRenderer.on('update-install-status', (_event, data) => cb(data));
  },
  // CEO Backup
  createBackup: (password) => ipcRenderer.invoke('create-backup', { password }),
  restoreBackupPreview: (filePath, password) => ipcRenderer.invoke('restore-backup-preview', { filePath, password }),
  restoreBackupApply: (filePath, password) => ipcRenderer.invoke('restore-backup-apply', { filePath, password }),
  openBackupFileDialog: () => ipcRenderer.invoke('open-backup-file-dialog'),

  // Generic channel API
  channelConfigGet: (ch) => ipcRenderer.invoke('channel:config:get', { ch }),
  channelConfigSave: (ch, config) => ipcRenderer.invoke('channel:config:save', { ch, config }),
  channelPause: (ch, minutes) => ipcRenderer.invoke('channel:pause', { ch, minutes }),
  channelResume: (ch) => ipcRenderer.invoke('channel:resume', { ch }),
  channelPauseStatus: (ch) => ipcRenderer.invoke('channel:pause-status', { ch }),
});
