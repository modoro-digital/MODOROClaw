'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const execFilePromise = promisify(execFile);

let ipcMain, dialog, shell, app, BrowserWindow;
try { ({ ipcMain, dialog, shell, app, BrowserWindow } = require('electron')); } catch {}

const ELECTRON_DIR = path.join(__dirname, '..');

const ctx = require('./context');
const { isPathSafe, writeJsonAtomic, sanitizeZaloText, stripTelegramMarkdown } = require('./util');
const {
  getWorkspace, invalidateWorkspaceCache, getWorkspaceTemplateRoot,
  getOpenclawAgentWorkspace, seedWorkspace, purgeAgentSessions,
  getBrandAssetsDir, getFbConfigPath, readFbConfig, writeFbConfig,
  getSetupCompletePath, hasCompletedOnboarding, markOnboardingComplete,
  isOpenClawConfigured, getAppPrefsPath, loadAppPrefs, saveAppPrefs,
  auditLog, backupWorkspace,
  DEFAULT_SCHEDULES_JSON, BRAND_ASSET_FORMATS, BRAND_ASSET_MAX_SIZE,
} = require('./workspace');
const {
  getBundledVendorDir, getBundledNodeBin, augmentPathWithBundledNode,
  appDataDir, findOpenClawBin, findOpenClawBinSync, findNodeBin, findOpenClawCliJs,
  spawnOpenClawSafe, runOpenClaw,
  bootDiagRunFullCheck,
  npmGlobalModules, findGlobalPackageFile,
} = require('./boot');
const {
  healOpenClawConfigInline,
  withOpenClawConfigLock,
  writeOpenClawConfigIfChanged,
} = require('./config');
const {
  ensure9RouterDefaultPassword, saveProviderKey, ensure9RouterProviderKeys,
  start9Router, stop9Router, nineRouterApi, autoFix9RouterSqlite,
  waitFor9RouterReady, validateOllamaKeyDirect,
  call9Router, call9RouterVision, detectChatgptPlusOAuth,
  getRouterProcess,
} = require('./nine-router');
const {
  extractConversationHistoryRaw, extractConversationHistory,
  writeDailyMemoryJournal, appendPerCustomerSummaries, trimZaloMemoryFile,
  withMemoryFileLock,
} = require('./conversation');
const {
  compareVersions, checkForUpdates, downloadUpdate, installDmgUpdate, openGitHubUrl,
  getLatestRelease, getUpdateDownloadInFlight, setUpdateDownloadInFlight,
} = require('./updates');
const {
  getTelegramConfig, getTelegramConfigWithRecovery,
  getGatewayAuthToken, getCeoSessionKey, sendToGatewaySession,
  filterSensitiveOutput,
  setChannelPermanentPause, clearChannelPermanentPause,
  isZaloChannelEnabled, setZaloChannelEnabled,
  isChannelPaused, pauseChannel, resumeChannel, getChannelPauseStatus,
  sendTelegram, sendTelegramPhoto, sendZalo, sendZaloTo, sendCeoAlert,
  probeTelegramReady, probeZaloReady,
  broadcastChannelStatusOnce, startChannelStatusBroadcast,
  registerTelegramCommands,
} = require('./channels');
const {
  getAppointmentsPath, readAppointments, writeAppointments,
  newAppointmentId, mutateAppointments,
  vnHHMM, vnDDMM, normalizeAppointment,
  substituteApptTemplate, defaultApptPushTemplate, buildApptReminderText,
  fireApptPushTarget, startAppointmentDispatcher, apptDispatcherTick,
} = require('./appointments');
const mediaLibrary = require('./media-library');
const {
  getZcaProfile, getZcaCacheDir, getZcaCacheDirForProfile,
  readZaloChannelState, isZaloTargetAllowed, isKnownZaloTarget,
  invalidateZaloFriendsCache, getZaloFriendsCached, setZaloFriendsCached,
  runZaloCacheRefresh, startZaloCacheAutoRefresh,
  getZaloUsersDir, ensureZaloUsersDir, sanitizeZaloUserId, parseZaloUserMemoryMeta,
  getZaloGroupsDir, getZaloBlocklistPath, cleanBlocklist,
} = require('./zalo-memory');
const { normalizeZaloBlocklist, resolveZaloBlocklistSave } = require('./zalo-settings');
const {
  cleanupOrphanZaloListener, ensureModoroZaloNodeModulesLink,
  ensureZaloPlugin, seedZaloCustomersFromCache,
  findOpenzcaCliJs, seedGroupHistorySummary, seedAllGroupHistories,
  checkZaloCookieAge, isZaloReady, getZaloPluginVersion,
} = require('./zalo-plugin');
const {
  compilePersonaMix, syncPersonaToBootstrap,
  syncShopStateToBootstrap, syncAllBootstrapData,
} = require('./persona');
const {
  processEscalationQueue, startEscalationChecker,
} = require('./escalation');
const {
  getFollowUpQueuePath, readFollowUpQueue, writeFollowUpQueue,
  queueFollowUpSafe, startFollowUpChecker,
} = require('./follow-up');
const {
  killPort, killAllOpenClawProcesses,
  isGatewayAlive, rejectIfBooting,
  startOpenClaw, stopOpenClaw,
  ensureVisionFix, ensureVisionCatalogFix, ensureVisionSerializationFix,
  ensureWebFetchLocalhostFix, ensureOpenzcaFriendEventFix,
  ensureOpenclawPricingFix, ensureOpenclawPrewarmFix,
  startFastWatchdog, triggerGatewayMessage,
} = require('./gateway');
const {
  getDocumentsDir, ensureDocumentsDir, getDocumentsDb, autoFixBetterSqlite3,
  KNOWLEDGE_CATEGORIES, DEFAULT_KNOWLEDGE_CATEGORIES, KNOWLEDGE_LABELS,
  getKnowledgeCategories, getKnowledgeDir,
  insertDocumentRow, ensureKnowledgeFolders, backfillKnowledgeFromDisk,
  resolveUniqueFilename, describeImageForKnowledge, summarizeKnowledgeContent,
  sanitizeKnowledgeContentForIndex, rewriteKnowledgeIndex, listKnowledgeFilesFromDisk,
  searchKnowledge, searchKnowledgeFTS5, getRagConfig,
  extractTextFromFile, expandSearchQuery, rerankSearchResults,
  indexDocumentChunks,
  embedText, vecToBlob,
} = require('./knowledge');
const {
  runCronAgentPrompt,
  runCronViaSessionOrFallback,
  getSchedulesPath, getCustomCronsPath,
  loadSchedules, loadCustomCrons,
  loadDailySummaries, generateWeeklySummary, loadWeeklySummaries,
  loadPromptTemplate,
  buildMorningBriefingPrompt, buildEveningSummaryPrompt,
  buildWeeklyReportPrompt, buildMonthlyReportPrompt,
  scanZaloFollowUpCandidates, buildZaloFollowUpPrompt,
  buildMeditationPrompt, buildMemoryCleanupPrompt,
  healCustomCronEntries, watchCustomCrons,
  startCronJobs, stopCronJobs, restartCronJobs,
  _withCustomCronLock, _removeCustomCronById, surfaceCronConfigError,
  _readJsonlTail, _readCeoNameFromIdentity, _readRecentZaloCustomers, _nextFireTime,
  _OVERVIEW_EVENT_LABELS,
  setSaveZaloManagerInFlightGetter,
  getAgentFlagProfile, getAgentCliHealthy,
} = require('./cron');
const { startCronApi, getCronApiToken, getCronApiPort } = require('./cron-api');

// ============================================
//  GOOGLE CALENDAR
// ============================================


// ── Module-level state (used across IPC handlers) ──
let _zaloLoginStartedAt = 0;
let _saveZaloManagerInFlight = false;

// Wire _saveZaloManagerInFlight getter into cron.js
setSaveZaloManagerInFlightGetter(() => _saveZaloManagerInFlight);

function startRuntimeSidecars(source) {
  const prefix = source ? `[${source}]` : '[runtime-sidecars]';
  try { startCronApi(); } catch (e) { console.error(prefix, 'startCronApi error:', e?.message || e); }
  try { startCronJobs(); } catch (e) { console.error(prefix, 'startCronJobs error:', e?.message || e); }
  try { startFollowUpChecker(); } catch (e) { console.error(prefix, 'startFollowUpChecker error:', e?.message || e); }
  try { startEscalationChecker(); } catch (e) { console.error(prefix, 'startEscalationChecker error:', e?.message || e); }
  try { watchCustomCrons(); } catch (e) { console.error(prefix, 'watchCustomCrons error:', e?.message || e); }
  try { startZaloCacheAutoRefresh(); } catch (e) { console.error(prefix, 'startZaloCacheAutoRefresh error:', e?.message || e); }
  try { startAppointmentDispatcher(); } catch (e) { console.error(prefix, 'startAppointmentDispatcher error:', e?.message || e); }
}

function registerAllIpcHandlers() {

// ============================================
//  IPC HANDLERS
// ============================================

// Start 9Router and open dashboard in browser
ipcMain.handle('start-9router', async () => {
  try {
    start9Router();
    await new Promise(r => setTimeout(r, 2000));
    const { shell } = require('electron');
    shell.openExternal('http://127.0.0.1:20128');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('setup-9router-auto', async (_event, opts = {}) => {
  try {
    if (opts.ollamaKey) {
      const trimmedKey = String(opts.ollamaKey).trim();
      if (trimmedKey.length < 20) {
        return { success: false, error: 'Ollama API key quá ngắn — kiểm tra lại đã paste đủ chưa.' };
      }
    }

    // FAST PATH: use 9router HTTP API for create+test+models. ~3-5 seconds
    // total instead of the old write-file-and-restart approach (~30s).
    //
    // Steps:
    //   1. Ensure 9router is running + reachable
    //   2. POST /api/providers (create Ollama connection)
    //   3. POST /api/providers/{id}/test (instant validate)
    //   4. If invalid: DELETE the connection + return clear error
    //   5. If valid: GET /api/providers/{id}/models, pick first
    //   6. Update or create combo "main" with picked model via /api/combos
    //   7. Ensure an API key exists (GET/POST /api/keys)
    //
    // No restart, no db.json writes — 9router persists everything itself.
    // If the API is unreachable (vendor broken, 9router won't start), fall
    // back to the legacy file-based approach below.
    if (opts.ollamaKey) {
      try {
        // 1. Make sure 9router is running
        if (!getRouterProcess()) {
          console.log('[setup-9router-auto] 9router not running — starting');
          start9Router();
        }
        let ready = await waitFor9RouterReady(10000);
        if (!ready) {
          // Distinguish crash (5xx = native module broken) from not-started (ECONNREFUSED)
          const ping = await nineRouterApi('GET', '/api/settings', null, 1500);
          if (ping.statusCode && ping.statusCode >= 500) {
            // Native module crash (e.g. better-sqlite3 arch mismatch on Mac).
            // Attempt runtime rebuild — takes up to ~60s but wizard shows spinner.
            console.log('[setup-9router-auto] 9router crash (HTTP', ping.statusCode, ') — attempting native module auto-fix');
            const fixed = await autoFix9RouterSqlite();
            if (fixed) {
              stop9Router();
              // Wait > 1500ms (Mac SIGKILL grace period) so old process releases
              // port 20128 before we restart. Also force-clear any lingering process
              // on the port as belt-and-braces.
              await new Promise(r => setTimeout(r, 2500));
              try { killPort(20128); } catch {}
              start9Router();
              ready = await waitFor9RouterReady(30000);
              if (ready) {
                console.log('[setup-9router-auto] 9router ready after native module auto-fix');
              } else {
                // BUG-A fix: return directly so we don't fall through to legacy
                // file mode (which also fails with 500 when 9router is broken).
                return { success: false, error: '9router vẫn không khởi động được sau khi tự sửa native module. Mở thư mục log (9router.log) để xem chi tiết.' };
              }
            } else {
              // BUG-A fix: return directly, same reason as above.
              return { success: false, error: '9router gặp lỗi khởi động (HTTP 500) và không thể tự sửa native module. Mở thư mục log (9router.log) để xem chi tiết.' };
            }
          } else {
            throw new Error('9router không khởi động được trong 10 giây — fallback file mode');
          }
        }
        console.log('[setup-9router-auto] 9router API reachable');

        // Advisory-only direct validation against ollama.com/api/ps.
        // Previously this was FAIL-CLOSED on 401/403 but ollama.com's /api/ps
        // endpoint behavior is brittle: Cloudflare challenge pages, regional
        // firewall, new key-format changes, or rate-limit can return 401 even
        // for valid keys. 9router's own test against ollama.com is the
        // authoritative source — we trust its result, not ours. Log for debug
        // but never block on direct check.
        if (opts.ollamaKey && typeof opts.ollamaKey === 'string') {
          try {
            const directCheck = await validateOllamaKeyDirect(opts.ollamaKey.trim());
            if (!directCheck.valid) {
              console.warn('[setup-9router-auto] direct-check advisory:', directCheck.statusCode, directCheck.error, '— proceeding via 9router');
            } else {
              console.log('[setup-9router-auto] direct-check PASSED (ollama.com 200)');
            }
          } catch (e) {
            console.warn('[setup-9router-auto] direct-check threw (non-fatal):', e?.message);
          }
        }

        // 2. Look for existing Ollama provider — if exists, delete it first
        //    so we don't accumulate dupes when user re-runs wizard
        const listRes = await nineRouterApi('GET', '/api/providers');
        if (listRes.success) {
          const existing = (listRes.data?.connections || []).filter(c => c.provider === 'ollama');
          for (const old of existing) {
            await nineRouterApi('DELETE', `/api/providers/${old.id}`);
            console.log('[setup-9router-auto] removed old Ollama provider', old.id);
          }
        }

        // 3. Create new Ollama provider — DO NOT set baseUrl.
        // 9Router knows the correct Ollama cloud endpoint internally for
        // provider type 'ollama'. Setting baseUrl: 'https://ollama.com'
        // previously overrode the default → requests hit wrong URL → 401.
        const createRes = await nineRouterApi('POST', '/api/providers', {
          provider: 'ollama',
          name: 'Ollama',
          apiKey: opts.ollamaKey.trim(),
        });
        if (!createRes.success) {
          throw new Error('Không tạo được provider: ' + (createRes.error || 'unknown'));
        }
        const providerId = createRes.data?.id || createRes.data?.connection?.id;
        if (!providerId) {
          throw new Error('9router không trả về provider ID');
        }
        console.log('[setup-9router-auto] created Ollama provider', providerId);
        // Save key in our own file so we can re-inject if 9Router UI wipes it
        saveProviderKey('ollama', opts.ollamaKey.trim());

        // 4. Test it (THIS is the fast validator — usually 1-3 seconds)
        const testRes = await nineRouterApi('POST', `/api/providers/${providerId}/test`, null, 8000);
        const testErrMsg = testRes.data?.error || testRes.error || 'Ollama key không hợp lệ';
        const testValid = testRes.success && (testRes.data?.valid !== false);

        if (!testValid) {
          console.warn('[setup-9router-auto] provider test failed:', testErrMsg);

          // HTTP 5xx = 9router internal unhandled exception (NOT a key validation failure).
          // Root cause: testConnection() in 9router writes the test result to SQLite AFTER
          // the fetch completes, and that write throws without a try/catch → propagates to
          // the route handler catch → 500. This is a 9router bug, not an invalid key.
          //
          // Key was already validated directly via validateOllamaKey() in wizard.html
          // before this IPC was called, so we KNOW the key is valid.
          // Skip the test result, do NOT delete the provider, fall through to models.
          // 5xx OR transient network errors (ECONNRESET, EPIPE, ETIMEDOUT,
          // socket hang up) = NOT a key validation failure. Bypass test,
          // proceed to models. If models lookup later also fails, we'll
          // surface the real error there.
          if (
            /^HTTP [5]\d{2}$/.test(String(testErrMsg)) ||
            /ECONNRESET|EPIPE|socket hang up|ETIMEDOUT|read ETIMEDOUT|network/i.test(String(testErrMsg))
          ) {
            console.warn('[setup-9router-auto] transient test error — proceeding (key trusted):', testErrMsg);
          } else {
            // Non-5xx = genuine key/network failure (401, ENOTFOUND, etc.)
            // Delete the bad provider so it doesn't pollute db.json
            await nineRouterApi('DELETE', `/api/providers/${providerId}`);
            let viError = testErrMsg;
            if (/401|unauthor/i.test(testErrMsg)) {
              viError = 'Ollama trả về 401. Nếu key chắc chắn đúng, có thể do Cloudflare/firewall chặn — thử đổi mạng (4G, VPN khác) rồi thử lại.';
            } else if (/ENOTFOUND|DNS/i.test(testErrMsg)) {
              viError = 'Không kết nối được ollama.com. Kiểm tra Internet hoặc thử đổi mạng.';
            } else if (/429|rate/i.test(testErrMsg)) {
              viError = 'Ollama trả về 429 (rate limit). Đợi 1 phút rồi thử lại.';
            } else if (/\b5\d{2}\b|internal.server.error/i.test(testErrMsg)) {
              viError = 'Ollama đang gặp sự cố tạm thời (HTTP 5xx). Thử lại sau vài phút hoặc kiểm tra status.ollama.com.';
            }
            return { success: false, error: viError, validationFailed: true };
          }
        }
        console.log('[setup-9router-auto] provider test PASSED (or bypassed — key pre-validated)');

        // 5. Get models for this provider
        const modelsRes = await nineRouterApi('GET', `/api/providers/${providerId}/models`);
        const modelIds = Array.isArray(modelsRes.data?.models)
          ? modelsRes.data.models.map(m => typeof m === 'string' ? m : (m?.id || m?.name)).filter(Boolean)
          : [];
        console.log('[setup-9router-auto] models:', modelIds.slice(0, 5));
        if (modelIds.length === 0) {
          await nineRouterApi('DELETE', `/api/providers/${providerId}`);
          return {
            success: false,
            error: 'Ollama key hợp lệ nhưng không có model nào. Tài khoản Ollama có thể chưa subscribe gói nào.',
            validationFailed: true,
          };
        }

        // Smart model selection: pick the best model for demo/daily use.
        // Priority: large capable models first, avoid tiny/quantized variants.
        const PREFERRED_MODELS = [
          'qwen3.5:397b', 'qwen3.5', 'deepseek-v3.2', 'deepseek-v3.1:671b',
          'glm-5.1', 'glm-5', 'mistral-large-3:675b', 'kimi-k2.5', 'kimi-k2:1t',
          'minimax-m2.7', 'minimax-m2.5', 'minimax-m2.1', 'minimax-m2',
          'gemma4:31b', 'gemma3:27b', 'gemma3:12b',
          'qwen3-coder:480b', 'qwen3-coder-next', 'cogito-2.1:671b',
          'nemotron-3-super', 'devstral-2:123b',
        ];
        // Strip ollama/ prefix for matching, then re-add
        const bareIds = modelIds.map(id => id.replace(/^ollama\//, ''));
        let pickedBare = null;
        for (const pref of PREFERRED_MODELS) {
          const match = bareIds.find(id => id === pref || id.startsWith(pref + ':'));
          if (match) { pickedBare = match; break; }
        }
        if (!pickedBare) pickedBare = bareIds[0]; // fallback to first
        let picked = modelIds.find(id => id.endsWith(pickedBare)) || modelIds[0];
        // 9router model IDs may not have ollama/ prefix in the response; add it
        if (!picked.startsWith('ollama/')) picked = 'ollama/' + picked;
        console.log('[setup-9router-auto] smart pick:', picked, '(from', modelIds.length, 'models)');

        // 6. Get or create combo 'main'
        const combosRes = await nineRouterApi('GET', '/api/combos');
        const combos = combosRes.data?.combos || combosRes.data || [];
        let mainCombo = (Array.isArray(combos) ? combos : []).find(c => c.name === 'main');
        if (mainCombo) {
          // Update existing
          const upRes = await nineRouterApi('PUT', `/api/combos/${mainCombo.id}`, {
            name: 'main',
            models: [picked],
          });
          if (!upRes.success) console.warn('[setup-9router-auto] combo update failed:', upRes.error);
        } else {
          // Create new
          const createCombo = await nineRouterApi('POST', '/api/combos', {
            name: 'main',
            models: [picked],
          });
          if (!createCombo.success) console.warn('[setup-9router-auto] combo create failed:', createCombo.error);
        }
        console.log('[setup-9router-auto] combo "main" set to model:', picked);

        // 7. Get or create API key
        const keysRes = await nineRouterApi('GET', '/api/keys');
        const keys = keysRes.data?.keys || keysRes.data || [];
        let apiKeyValue = null;
        const activeKey = (Array.isArray(keys) ? keys : []).find(k => k.isActive !== false && k.key);
        if (activeKey) {
          apiKeyValue = activeKey.key;
        } else {
          const createKey = await nineRouterApi('POST', '/api/keys', { name: '9BizClaw' });
          apiKeyValue = createKey.data?.key?.key || createKey.data?.key || null;
        }

        if (!apiKeyValue) {
          // Last resort: read from db.json directly
          try {
            const dbCheck = JSON.parse(fs.readFileSync(path.join(appDataDir(), '9router', 'db.json'), 'utf-8'));
            const k = (dbCheck.apiKeys || []).find(k => k.isActive);
            if (k) apiKeyValue = k.key;
          } catch {}
        }

        return {
          success: true,
          apiKey: apiKeyValue || '(see 9router web UI)',
          selectedModel: picked,
        };
      } catch (apiErr) {
        // Fall through to legacy file-based approach if API path fails
        console.warn('[setup-9router-auto] API path failed, falling back to file mode:', apiErr.message);
      }
    }
    // (legacy file-based approach continues below as fallback)

    const { randomUUID, randomBytes } = require('crypto');
    const dbPath = path.join(appDataDir(), '9router', 'db.json');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    // Read existing or create fresh
    let db = {};
    if (fs.existsSync(dbPath)) {
      try { db = JSON.parse(fs.readFileSync(dbPath, 'utf-8')); } catch {}
    }
    if (!Array.isArray(db.providerConnections)) db.providerConnections = [];
    if (!Array.isArray(db.combos)) db.combos = [];
    if (!Array.isArray(db.apiKeys)) db.apiKeys = [];
    if (!db.settings) db.settings = {};
    if (!Array.isArray(db.providerNodes)) db.providerNodes = [];
    if (!db.proxyPools) db.proxyPools = [];
    if (!db.modelAliases) db.modelAliases = {};
    if (!db.mitmAlias) db.mitmAlias = {};
    if (!db.pricing) db.pricing = {};

    // 1. Add Ollama provider — ONLY if user supplied a key. Don't touch
    //    existing providers the user may have configured directly via 9router
    //    web UI (ChatGPT Plus OAuth, Claude, Gemini, local Ollama, etc.).
    if (opts.ollamaKey) {
      db.providerConnections = db.providerConnections.filter(p => p.provider !== 'ollama');
      db.providerConnections.push({
        id: randomUUID(),
        provider: 'ollama',
        authType: 'apikey',
        name: 'Ollama',
        apiKey: opts.ollamaKey.trim(),
        priority: 1,
        isActive: true,
        testStatus: 'unknown',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      saveProviderKey('ollama', opts.ollamaKey.trim());
    }

    // 2. Combo 'main' handling — create if missing, leave existing alone.
    //    We'll auto-populate models below by querying 9router /v1/models AFTER
    //    restart, so whatever model the connected provider actually exposes
    //    gets picked. No hardcoding, no guessing model names that might be typos
    //    or stale (the old 'ollama/qwen3.5' hardcode failed this way).
    let combo = db.combos.find(c => c.name === 'main');
    let createdCombo = false;
    if (!combo) {
      combo = {
        id: randomUUID(),
        name: 'main',
        models: [], // Populated below from /v1/models
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      db.combos.push(combo);
      createdCombo = true;
    }

    // 3. Create API key
    let apiKey = db.apiKeys.find(k => k.isActive);
    if (!apiKey) {
      const machineId = randomBytes(8).toString('hex');
      const keyValue = `sk-${machineId}-modoro-${randomBytes(4).toString('hex')}`;
      apiKey = { id: randomUUID(), name: '9BizClaw', key: keyValue, machineId, isActive: true, createdAt: new Date().toISOString() };
      db.apiKeys.push(apiKey);
    }

    db.settings.comboStrategy = 'fallback';

    // Write db.json
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf-8');
    console.log('9Router db.json written:', db.providerConnections.length, 'providers,', db.combos.length, 'combos');

    // Restart 9Router to pick up new provider config
    stop9Router();
    await new Promise(r => setTimeout(r, 500));
    start9Router();

    // AUTO-DETECT MODELS: wait for 9Router to be ready, then query /v1/models
    // with our API key to see what models the connected providers actually
    // expose. Pick the first one and populate combo 'main' if it's empty.
    //
    // Why this instead of hardcoding (e.g. 'ollama/qwen3.5'):
    // - Hardcoded model names may not exist on the provider (CEO hit this
    //   with 'ollama/qwen3.5' which was a typo / stale name → 9router
    //   fallback → 404 openai)
    // - /v1/models returns the actual connected models, source of truth
    // - Respects whatever provider the user already has configured —
    //   if they had ChatGPT Plus OAuth before wizard, that provider's
    //   models get picked; if they pasted Ollama key now, Ollama models
    //   get picked. Provider-agnostic.
    //
    // If the query or pick fails, combo stays empty and user is directed
    // to the 9Router web UI to configure manually.
    let autoSelectedModel = null;
    let autoDetectError = null;
    if (createdCombo || !combo.models || combo.models.length === 0) {
      try {
        // Wait up to 15s for 9router to respond to /v1/models after restart.
        // Windows cold-start of 9router can take 10-12s on slower machines;
        // 8s was cutting it close and occasionally returned timeout → empty
        // combo → bot 404 on first real message.
        let modelsList = null;
        for (let i = 0; i < 15; i++) {
          await new Promise(r => setTimeout(r, 1000));
          try {
            modelsList = await new Promise((resolve, reject) => {
              const req = require('http').request({
                hostname: '127.0.0.1', port: 20128, path: '/v1/models',
                method: 'GET',
                headers: { 'Authorization': `Bearer ${apiKey.key}` },
                timeout: 3000,
              }, (res) => {
                let buf = '';
                res.setEncoding('utf8');
                res.on('data', (c) => { buf += c; });
                res.on('end', () => {
                  if (res.statusCode !== 200) {
                    reject(new Error(`/v1/models returned ${res.statusCode}: ${buf.slice(0, 200)}`));
                    return;
                  }
                  try { resolve(JSON.parse(buf)); }
                  catch (e) { reject(new Error('invalid JSON from /v1/models: ' + e.message)); }
                });
              });
              req.on('error', reject);
              req.on('timeout', () => { req.destroy(new Error('timeout')); });
              req.end();
            });
            break; // got a response
          } catch (e) {
            if (i === 14) throw e;
            // else keep retrying
          }
        }

        const modelIds = Array.isArray(modelsList?.data)
          ? modelsList.data.map(m => m && m.id).filter(Boolean)
          : [];
        console.log('[setup-9router-auto] /v1/models returned', modelIds.length, 'models:', modelIds.slice(0, 10));

        if (modelIds.length > 0) {
          // Smart model selection (same priority list as API path above)
          const PREFERRED_MODELS_FB = [
            'qwen3.5:397b', 'qwen3.5', 'deepseek-v3.2', 'deepseek-v3.1:671b',
            'glm-5.1', 'glm-5', 'mistral-large-3:675b', 'kimi-k2.5', 'kimi-k2:1t',
            'minimax-m2.7', 'minimax-m2.5', 'minimax-m2.1', 'minimax-m2',
            'gemma4:31b', 'gemma3:27b', 'gemma3:12b',
          ];
          let picked = null;
          for (const pref of PREFERRED_MODELS_FB) {
            picked = modelIds.find(id => id === pref || id.endsWith('/' + pref) || id.startsWith(pref));
            if (picked) break;
          }
          if (!picked && opts.ollamaKey) picked = modelIds.find(id => id.startsWith('ollama/'));
          if (!picked) picked = modelIds[0];

          // Re-read db.json in case 9router rewrote it during restart
          let currentDb;
          try { currentDb = JSON.parse(fs.readFileSync(dbPath, 'utf-8')); }
          catch { currentDb = db; }
          const currentCombo = currentDb.combos.find(c => c.name === 'main');
          if (currentCombo) {
            if (!currentCombo.models || currentCombo.models.length === 0) {
              currentCombo.models = [picked];
              currentCombo.updatedAt = new Date().toISOString();
              fs.writeFileSync(dbPath, JSON.stringify(currentDb, null, 2), 'utf-8');
              // VERIFY: re-read db.json to confirm the write really persisted.
              // Zero-risk guarantee: if the file got rewritten by a racing
              // 9router process without our combo update, we want to know now,
              // not at first user message.
              let verified = false;
              try {
                const reRead = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
                const reCombo = reRead.combos?.find(c => c.name === 'main');
                verified = Array.isArray(reCombo?.models) && reCombo.models.includes(picked);
              } catch {}
              if (!verified) {
                autoDetectError = 'combo write verification failed — 9router may have overwritten our update';
                console.error('[setup-9router-auto]', autoDetectError);
              } else {
                autoSelectedModel = picked;
                console.log('[setup-9router-auto] auto-populated combo "main" with model:', picked, '(verified)');
                // Restart 9router one more time so it picks up the new combo
                stop9Router();
                await new Promise(r => setTimeout(r, 500));
                start9Router();
              }
            } else {
              autoSelectedModel = currentCombo.models[0];
              console.log('[setup-9router-auto] combo "main" already has models, leaving alone:', currentCombo.models);
            }
          } else {
            autoDetectError = 'combo "main" not found after restart';
          }
        } else {
          autoDetectError = 'no models returned by /v1/models — provider may have failed to connect';
        }
      } catch (e) {
        autoDetectError = 'auto-detect failed: ' + (e.message || String(e));
        console.warn('[setup-9router-auto]', autoDetectError);
      }
    }

    return {
      success: true,
      apiKey: apiKey.key,
      selectedModel: autoSelectedModel,
      autoDetectError,
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// → cleanupOrphanZaloListener, ensureModoroZaloNodeModulesLink, ensureZaloPlugin,
// → seedZaloCustomersFromCache, findOpenzcaCliJs, seedGroupHistorySummary,
// → seedAllGroupHistories, checkZaloCookieAge, _ensureZaloPluginImpl
// → extracted to lib/zalo-plugin.js
// Setup Zalo — only runs QR login (fast), plugin already installed
ipcMain.handle('setup-zalo', async () => {
  try {
    _zaloLoginStartedAt = Date.now();

    // Delete old QR files
    for (const qr of [path.join(ctx.userDataDir, 'qr.png'), path.join(ELECTRON_DIR, 'qr.png'), path.join(ctx.resourceDir, 'qr.png'), path.join(process.cwd(), 'qr.png')]) {
      try { fs.unlinkSync(qr); } catch {}
    }

    // Run openzca auth login hidden — QR saved to known path
    const logsDir = path.join(ctx.userDataDir, 'logs');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    const qrSavePath = path.join(ctx.userDataDir, 'qr.png');
    const zaloLogFd = fs.openSync(path.join(logsDir, 'openzca.log'), 'a');
    // Spawn node directly — no CMD window. findGlobalPackageFile searches ALL
    // Node-manager lib dirs, not just the first existing one (the npmGlobalModules
    // shortcut breaks on mixed nvm/system Node setups).
    const zcaScript = findGlobalPackageFile('openzca', 'dist/cli.js');
    let zcaCmd, zcaArgs;
    if (zcaScript) {
      zcaCmd = findNodeBin() || 'node';
      zcaArgs = [zcaScript, 'auth', 'login', '--qr-path', qrSavePath];
    } else {
      // Fallback to PATH lookup. Use shell=true on Windows so .cmd shim resolves.
      zcaCmd = process.platform === 'win32' ? 'openzca.cmd' : 'openzca';
      zcaArgs = ['auth', 'login', '--qr-path', qrSavePath];
    }
    // Prevent openzca from auto-opening QR image in external viewer
    const zcaEnv = { ...process.env, OPENZCA_QR_OPEN: '0', OPENZCA_QR_AUTO_OPEN: '0' };
    const zaloProc = spawn(zcaCmd, zcaArgs, {
      stdio: ['ignore', zaloLogFd, zaloLogFd],
      detached: true,
      windowsHide: true,
      shell: process.platform === 'win32' && zcaCmd.endsWith('.cmd'),
      env: zcaEnv,
    });
    zaloProc.on('exit', () => { try { fs.closeSync(zaloLogFd); } catch {} });
    zaloProc.unref();
    return { success: true };
  } catch (e) {
    try { if (typeof zaloLogFd === 'number') fs.closeSync(zaloLogFd); } catch {}
    return { success: false, error: e.message };
  }
});

// Find QR image and return as base64 data URL (avoids CSP file:// issues)
ipcMain.handle('find-zalo-qr', async () => {
  const candidates = [
    path.join(ctx.userDataDir, 'qr.png'),
    path.join(ELECTRON_DIR, 'qr.png'),
    path.join(ctx.resourceDir, 'qr.png'),
    path.join(process.cwd(), 'qr.png'),
    path.join(ctx.HOME, 'qr.png'),
    path.join(ctx.HOME, '.openzca', 'qr.png'),
    path.join(ctx.HOME, '.openclaw', 'qr.png'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const data = fs.readFileSync(p);
      return 'data:image/png;base64,' + data.toString('base64');
    }
  }
  return null;
});

// Check if Zalo login succeeded (openzca stores session)
ipcMain.handle('check-zalo-login', async () => {
  try {
    const home = ctx.HOME;
    const sessionPaths = [
      path.join(home, '.openzca', 'profiles', 'default', 'credentials.json'),
      path.join(home, '.openzca', 'profiles', 'default', 'creds.json'),
      path.join(home, '.openzca', 'profiles', 'default', 'session.json'),
      path.join(home, '.openzca', 'default', 'credentials.json'),
    ];
    for (const p of sessionPaths) {
      if (fs.existsSync(p)) {
        // Count as logged in if file was modified AFTER login started OR within
        // 5s tolerance (clock precision, filesystem timestamp rounding).
        const mtime = fs.statSync(p).mtimeMs;
        if (_zaloLoginStartedAt && mtime < _zaloLoginStartedAt - 5000) continue;
        return { loggedIn: true };
      }
    }
    // Also try openzca status command — use direct node path for reliability
    // (execFile with shell=false on Mac can't resolve PATH-based commands).
    try {
      const zcaScript = findGlobalPackageFile('openzca', 'dist/cli.js');
      if (zcaScript) {
        const nodeBin = findNodeBin() || 'node';
        const { stdout } = await execFilePromise(nodeBin, [zcaScript, 'auth', 'status'], { timeout: 5000, encoding: 'utf-8', stdio: 'pipe', windowsHide: true });
        if (stdout.toLowerCase().includes('logged in') || stdout.toLowerCase().includes('authenticated')) return { loggedIn: true };
      }
    } catch {}
    return { loggedIn: false };
  } catch { return { loggedIn: false }; }
});

// Get current Zalo mode
ipcMain.handle('get-zalo-mode', async () => {
  try {
    const configPath = path.join(getWorkspace(), 'config', 'zalo-mode.txt');
    if (fs.existsSync(configPath)) return fs.readFileSync(configPath, 'utf-8').trim();
    return 'auto';
  } catch { return 'auto'; }
});

// Save Zalo mode to workspace config (read by AGENTS.md)
// ================================
// Shop State — "Tình trạng hôm nay"
// ================================
// CEO updates via Dashboard. Bot reads workspace/shop-state.json before each
// reply to know real-time shop state (out of stock, staff absent, shipping
// delay, active promotions, early closing, special notes).
// Note: no daily auto-reset cron — CEO clears fields manually via Dashboard
// "Xoá hết (bình thường)" button. May add cron in a later release.
ipcMain.handle('get-shop-state', async () => {
  try {
    const ws = getWorkspace();
    if (!ws) return null;
    const p = path.join(ws, 'shop-state.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    console.error('[get-shop-state] error:', e?.message);
    return null;
  }
});
ipcMain.handle('set-shop-state', async (_event, state) => {
  try {
    const ws = getWorkspace();
    if (!ws) return { ok: false, error: 'no workspace' };
    const p = path.join(ws, 'shop-state.json');
    const payload = {
      updatedAt: new Date().toISOString(),
      updatedBy: 'CEO via Dashboard',
      ...(state || {}),
    };
    writeJsonAtomic(p, payload);
    syncShopStateToBootstrap();
    try { auditLog('shop_state_updated', { fields: Object.keys(state || {}).length }); } catch {}
    return { ok: true };
  } catch (e) {
    console.error('[set-shop-state] error:', e?.message);
    return { ok: false, error: e.message };
  }
});

// ================================
// Persona Mix — Dashboard re-edit (post-wizard)
// ================================
// Dashboard has a "Tính cách bot" page where CEO can edit persona mix after
// wizard. These handlers bridge between Dashboard UI state and the 2 workspace
// files (active-persona.json + active-persona.md).
ipcMain.handle('get-persona-mix', async () => {
  try {
    const ws = getWorkspace();
    if (!ws) return null;
    const p = path.join(ws, 'active-persona.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    console.error('[get-persona-mix] error:', e?.message);
    return null;
  }
});
ipcMain.handle('save-persona-mix', async (_event, mix) => {
  try {
    const ws = getWorkspace();
    if (!ws) return { ok: false, error: 'no workspace' };
    if (!mix || typeof mix !== 'object') return { ok: false, error: 'invalid mix' };
    const normalized = {
      voice: mix.voice || 'em-nu-tre',
      customer: mix.customer || 'anh-chi',
      traits: Array.isArray(mix.traits) ? mix.traits.slice(0, 5) : [],
      formality: Math.max(1, Math.min(10, parseInt(mix.formality, 10) || 5)),
      greeting: (mix.greeting || '').toString().slice(0, 300),
      closing: (mix.closing || '').toString().slice(0, 300),
      phrases: (mix.phrases || '').toString().slice(0, 1000),
    };
    const jsonPath = path.join(ws, 'active-persona.json');
    const mdPath = path.join(ws, 'active-persona.md');
    writeJsonAtomic(jsonPath, normalized);
    fs.writeFileSync(mdPath, compilePersonaMix(normalized), 'utf-8');
    syncPersonaToBootstrap();
    try { auditLog('persona_mix_updated', { voice: normalized.voice, traits: normalized.traits.length, formality: normalized.formality }); } catch {}
    console.log('[save-persona-mix] updated via Dashboard');
    return { ok: true };
  } catch (e) {
    console.error('[save-persona-mix] error:', e?.message);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('save-zalo-mode', async (_event, mode) => {
  try {
    const ws = getWorkspace();
    const configPath = path.join(ws, 'config', 'zalo-mode.txt');
    fs.mkdirSync(path.join(ws, 'config'), { recursive: true });
    fs.writeFileSync(configPath, mode, 'utf-8');

    // Also update AGENTS.md Zalo section based on mode
    const agentsPath = path.join(ws, 'AGENTS.md');
    if (fs.existsSync(agentsPath)) {
      let content = fs.readFileSync(agentsPath, 'utf-8');
      // Replace Zalo mode marker if exists, or add after Zalo section header
      const modeText = mode === 'auto'
        ? '**Chế độ: Tự động trả lời.** Trợ lý tự reply khách hàng. Vấn đề phức tạp escalate qua Telegram.'
        : mode === 'read'
        ? '**Chế độ: Chỉ đọc.** KHÔNG tự trả lời trên Zalo. Đọc tin nhắn và báo qua Telegram cho CEO. CEO quyết định trả lời.'
        : '**Chế độ: Tóm tắt cuối ngày.** KHÔNG tự trả lời. Đọc tất cả tin nhắn trong ngày, gửi bản tổng hợp qua Telegram 1 lần vào cuối ngày.';

      if (content.includes('**Chế độ:')) {
        content = content.replace(/\*\*Chế độ:.*?\*\*/s, modeText.split('**')[1] ? modeText : modeText);
        // Simpler: replace the whole mode line
        content = content.replace(/\*\*Chế độ:.*$/m, modeText);
      } else if (content.includes('### Zalo (kênh khách hàng/nhân viên)')) {
        content = content.replace(
          '### Zalo (kênh khách hàng/nhân viên)\n',
          `### Zalo (kênh khách hàng/nhân viên)\n\n${modeText}\n`
        );
      }
      fs.writeFileSync(agentsPath, content, 'utf-8');
    }
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

// ============================================
//  ZALO MANAGER — Group whitelist + User blacklist
// ============================================
// getZcaProfile, getZcaCacheDir, getZcaCacheDirForProfile,
// readZaloChannelState, isZaloTargetAllowed, isKnownZaloTarget
// → extracted to lib/zalo-memory.js


// Friends cache state + invalidateZaloFriendsCache → extracted to lib/zalo-memory.js
ipcMain.handle('list-zalo-friends', async () => {
  try {
    const now = Date.now();
    const { cache, cacheAt, ttl } = getZaloFriendsCached();
    if (cache && (now - cacheAt) < ttl) {
      return cache;
    }
    const p = path.join(getZcaCacheDir(), 'friends.json');
    if (!fs.existsSync(p)) return [];
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    // Normalize — only return fields the UI needs
    const result = (Array.isArray(data) ? data : []).map(f => ({
      userId: String(f.userId || f.userKey || ''),
      displayName: f.displayName || f.zaloName || f.username || '(không tên)',
      avatar: f.avatar || '',
      phoneNumber: f.phoneNumber || '',
      isFriend: f.isFr === 1,
      isBlocked: f.isBlocked === 1,
    })).filter(f => f.userId);
    setZaloFriendsCached(result);
    return result;
  } catch (e) {
    console.error('[zalo] list friends error:', e.message);
    return [];
  }
});

// runZaloCacheRefresh + cache refresh state → extracted to lib/zalo-memory.js
// startZaloCacheAutoRefresh + _zaloCacheInterval → extracted to lib/zalo-memory.js

// Trigger openzca to refresh its cache from live Zalo server (manual)
ipcMain.handle('refresh-zalo-cache', async () => {
  const result = await runZaloCacheRefresh({ source: 'manual' });
  return {
    success: !!result?.ok,
    skipped: !!result?.skipped,
    rateLimited: !!result?.rateLimited,
    retryAfterSec: result?.retryAfterSec || 0,
    error: result?.error || null,
  };
});

ipcMain.handle('list-zalo-groups', async () => {
  try {
    const p = path.join(getZcaCacheDir(), 'groups.json');
    if (!fs.existsSync(p)) return [];
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return (Array.isArray(data) ? data : []).map(g => ({
      groupId: String(g.groupId || g.id || ''),
      name: g.name || g.groupName || '(không tên)',
      avatar: g.avatar || g.groupAvatar || g.avt || g.fullAvt || '',
      memberCount: g.totalMember || g.memberCount || (g.memberIds?.length) || (g.memVerList?.length) || 0,
      desc: g.desc || '',
      createdTime: g.createdTime || 0,
    })).filter(g => g.groupId);
  } catch (e) {
    console.error('[zalo] list groups error:', e.message);
    return [];
  }
});

// === Zalo per-user memory ===
// getZaloUsersDir, ensureZaloUsersDir, sanitizeZaloUserId, parseZaloUserMemoryMeta
// → extracted to lib/zalo-memory.js

ipcMain.handle('list-zalo-user-memories', async () => {
  try {
    const dir = getZaloUsersDir();
    if (!dir || !fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md') && !f.startsWith('.'));
    const out = [];
    for (const f of files) {
      try {
        const senderId = f.replace(/\.md$/, '');
        const filePath = path.join(dir, f);
        const stat = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, 'utf-8');
        const meta = parseZaloUserMemoryMeta(content);
        out.push({
          senderId,
          name: meta.name,
          lastSeen: meta.lastSeen || stat.mtime.toISOString(),
          msgCount: meta.msgCount,
          gender: meta.gender,
          summary: meta.summary,
          mtimeMs: stat.mtimeMs,
        });
      } catch {}
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return out;
  } catch (e) {
    console.error('[zalo-user-memory] list error:', e?.message);
    return [];
  }
});

ipcMain.handle('read-zalo-user-memory', async (_event, { senderId }) => {
  try {
    const id = sanitizeZaloUserId(senderId);
    if (!id) return { exists: false, content: '' };
    const dir = getZaloUsersDir();
    if (!dir) return { exists: false, content: '' };
    const filePath = path.join(dir, id + '.md');
    if (!fs.existsSync(filePath)) return { exists: false, content: '' };
    const content = fs.readFileSync(filePath, 'utf-8');
    const meta = parseZaloUserMemoryMeta(content);
    return { exists: true, content, meta };
  } catch (e) {
    console.error('[zalo-user-memory] read error:', e?.message);
    return { exists: false, content: '', error: e.message };
  }
});

ipcMain.handle('reset-zalo-user-memory', async (_event, { senderId }) => {
  try {
    const id = sanitizeZaloUserId(senderId);
    if (!id) return { success: false, error: 'invalid id' };
    const dir = getZaloUsersDir();
    if (!dir) return { success: false, error: 'no workspace' };
    const filePath = path.join(dir, id + '.md');
    if (!fs.existsSync(filePath)) return { success: true };
    // Move to .archive/<id>-<ts>.md instead of deleting (audit trail)
    const archDir = path.join(dir, '.archive');
    fs.mkdirSync(archDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const archPath = path.join(archDir, id + '-' + ts + '.md');
    fs.renameSync(filePath, archPath);
    return { success: true };
  } catch (e) {
    console.error('[zalo-user-memory] reset error:', e?.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('append-zalo-user-note', async (_event, { senderId, note }) => {
  try {
    const id = sanitizeZaloUserId(senderId);
    if (!id) return { success: false, error: 'invalid id' };
    const cleanNote = String(note || '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 2000);
    if (!cleanNote) return { success: false, error: 'empty note' };
    const dir = ensureZaloUsersDir();
    if (!dir) return { success: false, error: 'no workspace' };
    const filePath = path.join(dir, id + '.md');
    return await withMemoryFileLock(filePath, () => {
      let content = '';
      if (fs.existsSync(filePath)) {
        content = fs.readFileSync(filePath, 'utf-8');
      } else {
        content = `---\nname: \nlastSeen: ${new Date().toISOString()}\nmsgCount: 0\ngender: unknown\n---\n# Khách Zalo ${id}\n\n## Tóm tắt\n(Chưa có dữ liệu)\n\n## CEO notes\n`;
      }
      if (!content.includes('## CEO notes')) {
        content = content.replace(/$/, '\n\n## CEO notes\n');
      }
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      content = content.replace(/(## CEO notes\s*\n)/, `$1- **${stamp}** — ${cleanNote}\n`);
      fs.writeFileSync(filePath, content, 'utf-8');
      return { success: true };
    });
  } catch (e) {
    console.error('[zalo-user-memory] append note error:', e?.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('delete-zalo-user-note', async (_event, { senderId, noteTimestamp }) => {
  try {
    if (!senderId || !noteTimestamp) return { success: false, error: 'missing params' };
    const id = sanitizeZaloUserId(senderId);
    if (!id) return { success: false, error: 'invalid senderId' };
    const dir = getZaloUsersDir();
    if (!dir) return { success: false, error: 'workspace not ready' };
    const filePath = path.join(dir, id + '.md');
    if (!fs.existsSync(filePath)) return { success: false, error: 'file not found' };
    return await withMemoryFileLock(filePath, () => {
      const content = fs.readFileSync(filePath, 'utf-8');
      const escapedTs = noteTimestamp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const lineRegex = new RegExp('^- \\*\\*' + escapedTs + '\\*\\*.*$\\n?', 'm');
      const newContent = content.replace(lineRegex, '');
      if (newContent === content) return { success: false, error: 'note not found' };
      fs.writeFileSync(filePath, newContent, 'utf-8');
      return { success: true };
    });
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// === Zalo group memory ===
// getZaloGroupsDir → extracted to lib/zalo-memory.js

ipcMain.handle('get-zalo-group-summaries', async () => {
  try {
    const dir = getZaloGroupsDir();
    if (!dir || !fs.existsSync(dir)) return {};
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    const summaries = {};
    for (const f of files) {
      const groupId = f.replace('.md', '');
      try {
        const content = fs.readFileSync(path.join(dir, f), 'utf-8');
        // Extract key sections from the group memory file
        const lines = content.split('\n');
        let topics = '', members = '', decisions = '';
        let currentSection = '';
        for (const line of lines) {
          if (line.startsWith('## Chủ đề thường thảo luận')) { currentSection = 'topics'; continue; }
          if (line.startsWith('## Thành viên key')) { currentSection = 'members'; continue; }
          if (line.startsWith('## Quyết định/thông báo')) { currentSection = 'decisions'; continue; }
          if (line.startsWith('## ') || line.startsWith('---')) { currentSection = ''; continue; }
          const trimmed = line.trim();
          if (!trimmed || trimmed === '(chưa có)') continue;
          if (currentSection === 'topics') topics += (topics ? ', ' : '') + trimmed.replace(/^[-*]\s*/, '');
          if (currentSection === 'members') members += (members ? ', ' : '') + trimmed.replace(/^[-*]\s*/, '');
          if (currentSection === 'decisions') decisions += (decisions ? ', ' : '') + trimmed.replace(/^[-*]\s*/, '');
        }
        summaries[groupId] = {
          topics: topics.slice(0, 120) || '',
          members: members.slice(0, 120) || '',
          decisions: decisions.slice(0, 120) || '',
          hasContent: !!(topics || members || decisions),
        };
      } catch {}
    }
    return summaries;
  } catch (e) {
    console.error('[zalo-group-memory] error:', e?.message);
    return {};
  }
});

// Read full group memory file for display in Dashboard modal.
ipcMain.handle('get-zalo-group-memory', async (_evt, groupId) => {
  try {
    if (!groupId || typeof groupId !== 'string' || /[\/\\.]/.test(groupId)) return { content: '', exists: false };
    const dir = getZaloGroupsDir();
    if (!dir) return { content: '', exists: false };
    const fp = path.join(dir, groupId + '.md');
    if (!fs.existsSync(fp)) return { content: '', exists: false };
    return { content: fs.readFileSync(fp, 'utf-8'), exists: true };
  } catch (e) {
    return { content: '', exists: false, error: e?.message };
  }
});

// Manually re-seed a single group's history summary (dashboard "refresh context").
// Returns { ok, reason, msgCount? }.
ipcMain.handle('seed-group-history-now', async (_evt, groupId, threadName) => {
  try {
    if (!groupId || typeof groupId !== 'string') return { ok: false, reason: 'invalid-groupId' };
    return await seedGroupHistorySummary(groupId, threadName || groupId);
  } catch (e) {
    return { ok: false, reason: 'exception: ' + (e && e.message ? e.message : String(e)) };
  }
});

// Manually trigger batch re-seed across all groups (CEO "refresh all group context").
// Fire-and-forget: returns immediately with started=true, run continues in background.
ipcMain.handle('seed-group-history-all', async () => {
  try {
    // Kick off in background, return immediately so dashboard isn't blocked.
    // seedAllGroupHistories has its own in-flight guard internally.
    seedAllGroupHistories({ source: 'ipc-manual' }).catch(e => {
      console.warn('[group-history-seed] manual run error:', e && e.message ? e.message : String(e));
    });
    return { started: true };
  } catch (e) {
    return { started: false, reason: 'exception: ' + (e && e.message ? e.message : String(e)) };
  }
});

// REMOVED: Zalo owner identification — owner/chủ nhân feature fully removed.
// All Zalo messages are treated as customer messages uniformly.


// === Security Layer 1 (scoped) — File permission hardening ===
// Real Layer 1 (DPAPI/Keychain encryption) is high-risk because decryption
// failure = bot can't boot. Until we have a battle-tested decryption shim,
// scoped Layer 1 protects sensitive files at the FILESYSTEM level only:
// chmod 600 (owner-only read/write) on Unix. Windows NTFS already inherits
// per-user ACL from `C:\Users\<user>\` so no additional work needed there.
//
// Files protected:
// getZaloBlocklistPath + cleanBlocklist → extracted to lib/zalo-memory.js

ipcMain.handle('get-zalo-manager-config', async () => {
  try {
    const configPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
    let zalo = {};
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      zalo = cfg?.channels?.['modoro-zalo'] || cfg?.channels?.openzalo || {};
    }
    let blocklist = [];
    const bp = getZaloBlocklistPath();
    if (fs.existsSync(bp)) {
      try { blocklist = JSON.parse(fs.readFileSync(bp, 'utf-8')); } catch {}
    }
    let groupSettings = {};
    try {
      const gsPath = path.join(getWorkspace(), 'zalo-group-settings.json');
      if (fs.existsSync(gsPath)) groupSettings = JSON.parse(fs.readFileSync(gsPath, 'utf-8'));
    } catch {}
    let strangerPolicy = 'ignore';
    try {
      const spPath = path.join(getWorkspace(), 'zalo-stranger-policy.json');
      if (fs.existsSync(spPath)) strangerPolicy = JSON.parse(fs.readFileSync(spPath, 'utf-8')).mode || 'ignore';
    } catch {}
    return {
      enabled: zalo.enabled !== false,
      groupPolicy: zalo.groupPolicy || 'open',
      groupAllowFrom: Array.isArray(zalo.groupAllowFrom) ? zalo.groupAllowFrom.filter(x => x !== '*') : [],
      dmPolicy: zalo.dmPolicy || 'open',
      userBlocklist: normalizeZaloBlocklist(blocklist),
      groupSettings,
      strangerPolicy,
    };
  } catch (e) {
    return { enabled: false, groupPolicy: 'open', groupAllowFrom: [], dmPolicy: 'open', userBlocklist: [] };
  }
});

function saveZaloRealtimeManagerFiles({ userBlocklist, userBlocklistTouched, groupSettings, strangerPolicy }) {
  const bp = getZaloBlocklistPath();
  let existingBl = [];
  try {
    if (bp && fs.existsSync(bp)) existingBl = JSON.parse(fs.readFileSync(bp, 'utf-8'));
  } catch {}

  const blocklistSave = resolveZaloBlocklistSave({
    existingBlocklist: existingBl,
    incomingBlocklist: userBlocklist,
    userBlocklistTouched: userBlocklistTouched === true,
  });

  if (bp && blocklistSave.preservedExisting) {
    console.warn(`[save-zalo-manager] incoming blocklist empty while file has ${blocklistSave.blocklist.length} entries; preserving existing friend settings`);
    try { fs.copyFileSync(bp, bp + '.bak'); } catch {}
  } else if (bp && (blocklistSave.shouldWrite || !fs.existsSync(bp))) {
    writeJsonAtomic(bp, blocklistSave.blocklist);
  }

  if (groupSettings && typeof groupSettings === 'object') {
    const gsPath = path.join(getWorkspace(), 'zalo-group-settings.json');
    let existing = {};
    try {
      if (fs.existsSync(gsPath)) existing = JSON.parse(fs.readFileSync(gsPath, 'utf-8')) || {};
      if (typeof existing !== 'object' || Array.isArray(existing)) existing = {};
    } catch {}
    let oldExisting = {};
    try { oldExisting = JSON.parse(JSON.stringify(existing)); } catch {}
    for (const [gid, gs] of Object.entries(groupSettings)) {
      if (!gs || !gs.mode) continue;
      if (!['off', 'mention', 'all'].includes(gs.mode)) continue;
      const sanitized = { mode: gs.mode };
      if (gs.internal === true) sanitized.internal = true;
      existing[gid] = sanitized;
    }
    try {
      for (const gid of Object.keys(existing)) {
        const wasInternal = oldExisting[gid]?.internal === true;
        const isInternal = existing[gid]?.internal === true;
        if (wasInternal !== isInternal) {
          auditLog('group-internal-change', { groupId: gid, internal: isInternal, ts: Date.now() });
        }
      }
    } catch {}
    if (Object.keys(existing).length > 0) {
      writeJsonAtomic(gsPath, existing);
    }
  }

  if (strangerPolicy !== undefined) {
    const spPath = path.join(getWorkspace(), 'zalo-stranger-policy.json');
    if (strangerPolicy) {
      writeJsonAtomic(spPath, { mode: strangerPolicy });
    } else if (fs.existsSync(spPath)) {
      try { fs.unlinkSync(spPath); } catch {}
    }
  }

  return { blocklistLength: blocklistSave.blocklist.length };
}

async function forceDisableZaloFailClosed(source = 'manager-disabled') {
  const pauseOk = setChannelPermanentPause('zalo', source);
  let configOk = false;
  let stickyOk = false;
  try {
    await withOpenClawConfigLock(async () => {
      const openclawDir = path.join(ctx.HOME, '.openclaw');
      try { fs.mkdirSync(openclawDir, { recursive: true }); } catch {}
      try {
        writeJsonAtomic(path.join(openclawDir, 'modoroclaw-sticky-zalo-enabled.json'), {
          enabled: false,
          ts: Date.now(),
          source,
        });
        stickyOk = true;
      } catch (e) {
        console.warn('[zalo] fail-closed sticky write error:', e?.message);
      }

      const configPath = path.join(openclawDir, 'openclaw.json');
      if (!fs.existsSync(configPath)) return;
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (!cfg.channels) cfg.channels = {};
      if (!cfg.channels['modoro-zalo'] || typeof cfg.channels['modoro-zalo'] !== 'object') cfg.channels['modoro-zalo'] = {};
      cfg.channels['modoro-zalo'].enabled = false;
      if (!cfg.plugins) cfg.plugins = {};
      if (!cfg.plugins.entries) cfg.plugins.entries = {};
      if (!cfg.plugins.entries['modoro-zalo'] || typeof cfg.plugins.entries['modoro-zalo'] !== 'object') cfg.plugins.entries['modoro-zalo'] = {};
      cfg.plugins.entries['modoro-zalo'].enabled = false;
      writeOpenClawConfigIfChanged(configPath, cfg);
      configOk = true;
    });
  } catch (e) {
    console.error('[zalo] fail-closed disable error:', e?.message || e);
  }
  try { auditLog('zalo_fail_closed_disabled', { source, pauseOk, configOk, stickyOk }); } catch {}
  return { pauseOk, configOk, stickyOk };
}

ipcMain.handle('save-zalo-manager-config', async (_event, { enabled, groupPolicy, groupAllowFrom, userBlocklist, userBlocklistTouched, groupSettings, strangerPolicy }) => {
  invalidateZaloFriendsCache(); // PERF: bust friends cache on config save
  const booting = rejectIfBooting('save-zalo-manager-config');
  if (booting) {
    if (enabled === false) {
      ctx.ipcInFlightCount++;
      try {
        const realtime = saveZaloRealtimeManagerFiles({ userBlocklist, userBlocklistTouched, groupSettings, strangerPolicy });
        const off = await forceDisableZaloFailClosed('manager-disabled-while-booting');
        return {
          success: off.pauseOk || off.configOk || off.stickyOk,
          booting: true,
          pendingRestart: true,
          blocklistLength: realtime.blocklistLength,
          message: 'Đã tắt Zalo ngay. App đang khởi động nên gateway sẽ áp dụng đầy đủ sau khi xong.',
        };
      } finally {
        ctx.ipcInFlightCount--;
      }
    }
    if (userBlocklistTouched === true || groupSettings || strangerPolicy !== undefined) {
      if (enabled !== false && isZaloChannelEnabled() === false) return booting;
      ctx.ipcInFlightCount++;
      try {
        const realtime = saveZaloRealtimeManagerFiles({ userBlocklist, userBlocklistTouched, groupSettings, strangerPolicy });
        return {
          success: true,
          booting: true,
          realtimeOnly: true,
          blocklistLength: realtime.blocklistLength,
          message: 'Đã lưu danh sách Zalo. Bot đang khởi động nên phần bật/tắt kênh sẽ áp dụng sau.',
        };
      } finally {
        ctx.ipcInFlightCount--;
      }
    }
    return booting;
  }
  // Double-click guard: a rapid 2nd save before the 1st completes would
  // read the same prev snapshot, both compute identical diffs, both try
  // to restart gateway → two concurrent stopOpenClaw calls racing.
  if (_saveZaloManagerInFlight) {
    return { success: false, error: 'Lưu đang chạy — thử lại sau 1-2 giây' };
  }
  _saveZaloManagerInFlight = true;
  ctx.ipcInFlightCount++;
  // [A2] Serialize concurrent openclaw.json writers with config mutex.
  try {
  return await withOpenClawConfigLock(async () => {
    console.log('[config-lock] save-zalo-manager-config acquired');
    // Detect whether `channels['modoro-zalo'].enabled` actually changes. Only this
    // field needs a hard gateway restart (stop+wait+start) because it
    // controls whether openclaw loads the modoro-zalo plugin + spawns the
    // openzca listener subprocess at all. All other fields (blocklist,
    // groupSettings, strangerPolicy) are read realtime by inbound.ts patches
    // so zero restart is needed for them.
    let prevEnabled = null;
    try {
      const configPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
      if (fs.existsSync(configPath)) {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        prevEnabled = (cfg?.channels?.['modoro-zalo'] || cfg?.channels?.openzalo)?.enabled !== false;
      }
    } catch {}
    const newEnabled = enabled !== false;
    const enabledChanged = (prevEnabled !== null) && (prevEnabled !== newEnabled);

    // 1. Update openclaw.json (groups handled natively by OpenZalo)
    const configPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (!cfg.channels) cfg.channels = {};
      if (!cfg.channels['modoro-zalo']) cfg.channels['modoro-zalo'] = {};
      cfg.channels['modoro-zalo'].enabled = enabled !== false;
      // ALWAYS keep native gate open — let code-level patch in inbound.ts
      // handle group filtering via zalo-group-settings.json (realtime, no restart).
      // Setting allowlist here blocks groups at the native gate BEFORE our
      // patches run, making Dashboard group toggle useless.
      cfg.channels['modoro-zalo'].groupPolicy = 'open';
      cfg.channels['modoro-zalo'].groupAllowFrom = ['*'];
      // CRITICAL: modoro-zalo plugin defaults dmPolicy to "pairing" → unknown DM
      // sender → "OpenClaw: access not configured." pairing reply. We always
      // want CEO + their contacts to DM the bot directly without pairing dance.
      // Force dmPolicy="open" + allowFrom=["*"] every save so wizard/manager
      // never leaves these unset (which would re-trigger pairing on next boot).
      cfg.channels['modoro-zalo'].dmPolicy = 'open';
      if (!Array.isArray(cfg.channels['modoro-zalo'].allowFrom)) {
        cfg.channels['modoro-zalo'].allowFrom = ['*'];
      }
      // CRIT #5: zalo-group-settings.json is single source of truth —
      // inbound.ts GROUP-SETTINGS PATCH v3 handles off/mention/all modes
      // realtime. Purge any legacy groups[gid] entries from openclaw.json.
      if (cfg.channels['modoro-zalo'].groups) delete cfg.channels['modoro-zalo'].groups;
      // Also sync plugins.entries['modoro-zalo'].enabled with channels['modoro-zalo'].enabled
      // so "Tắt Zalo" is a real hard-off (gateway won't even load plugin
      // on next boot). ensureDefaultConfig syncs this too but doing it here
      // ensures the in-memory flip propagates immediately.
      if (!cfg.plugins) cfg.plugins = {};
      if (!cfg.plugins.entries) cfg.plugins.entries = {};
      if (!cfg.plugins.entries['modoro-zalo'] || typeof cfg.plugins.entries['modoro-zalo'] !== 'object') {
        cfg.plugins.entries['modoro-zalo'] = {};
      }
      cfg.plugins.entries['modoro-zalo'].enabled = newEnabled;
      writeOpenClawConfigIfChanged(configPath, cfg);
    }
    let gateOk = true;
    if (enabled === false) gateOk = setChannelPermanentPause('zalo', 'manager-disabled');
    else {
      gateOk = clearChannelPermanentPause('zalo');
      markOnboardingComplete('zalo-manager-enable');
    }
    // 2. Workspace files are read realtime by inbound.ts patches. The helper
    // preserves an existing friend blocklist when autosave sends an untouched [].
    saveZaloRealtimeManagerFiles({ userBlocklist, userBlocklistTouched, groupSettings, strangerPolicy });
    // 3. CRIT #5: Persist ALL explicit modes (off/mention/all) — zalo-group-settings.json
    // is the single source of truth used by GROUP-SETTINGS PATCH v2. If user
    // sets 'mention' in Dashboard we must persist it so the patch enforces
    // @mention gating (not modoro-zalo native which we bypassed above).
    //
    // CRITICAL FIX (user report 2026-04-17): Previously this REPLACED the
    // whole file on every save, and DELETED it if incoming groupSettings was
    // empty. That caused settings to be wiped whenever Dashboard sent partial
    // or empty state (e.g., user saves with only stranger policy changed →
    // groupSettings unchanged in UI but sent as-is → wiped other modes).
    //
    // New behavior: MERGE incoming into existing. Never delete file on empty
    // input. User's only way to reset a mode is to change it explicitly via
    // the dropdown.
    if (groupSettings && typeof groupSettings === 'object') {
      const gsPath = path.join(getWorkspace(), 'zalo-group-settings.json');
      let existing = {};
      try {
        if (fs.existsSync(gsPath)) existing = JSON.parse(fs.readFileSync(gsPath, 'utf-8')) || {};
        if (typeof existing !== 'object' || Array.isArray(existing)) existing = {};
      } catch {}
      // Read old file for audit diff before mutating
      let oldExisting = {};
      try { oldExisting = JSON.parse(JSON.stringify(existing)); } catch {}
      for (const [gid, gs] of Object.entries(groupSettings)) {
        if (!gs || !gs.mode) continue;
        if (!['off', 'mention', 'all'].includes(gs.mode)) continue;
        const sanitized = { mode: gs.mode };
        if (gs.internal === true) sanitized.internal = true;
        existing[gid] = sanitized;
      }
      // Audit log internal flag changes
      try {
        for (const gid of Object.keys(existing)) {
          const wasInternal = oldExisting[gid]?.internal === true;
          const isInternal = existing[gid]?.internal === true;
          if (wasInternal !== isInternal) {
            auditLog('group-internal-change', { groupId: gid, internal: isInternal, ts: Date.now() });
          }
        }
      } catch {}
      if (Object.keys(existing).length > 0) {
        writeJsonAtomic(gsPath, existing);
      }
    }
    // 4. Write stranger policy to workspace — mirror groupSettings pattern:
    // if no explicit strangerPolicy provided, REMOVE file so patch falls back
    // to plugin default (prevents stale policy file leaking after CEO clears
    // the field in Dashboard).
    if (strangerPolicy !== undefined) {
      const spPath = path.join(getWorkspace(), 'zalo-stranger-policy.json');
      if (strangerPolicy) {
        writeJsonAtomic(spPath, { mode: strangerPolicy });
      } else if (fs.existsSync(spPath)) {
        try { fs.unlinkSync(spPath); } catch {}
      }
    }
    // 5. Hard gateway restart ONLY when modoro-zalo enabled flag actually flipped.
    // This is the only field that requires full gateway reload — the plugin
    // loader decides at boot whether to register modoro-zalo + spawn openzca
    // listener subprocess. Toggling it without a restart means:
    //   disable → plugin still loaded, listener still running (memory leak)
    //   enable  → plugin NOT loaded (it was disabled at boot), no listener
    //             → Dashboard shows green but customers get silence
    // Proper restart pattern: stopOpenClaw + wait + startOpenClaw.
    // startOpenClaw alone is a no-op when ctx.botRunning=true, so we MUST stop first.
    //
    // [restart-guard A1] Set ctx.gatewayRestartInFlight BEFORE the IIFE starts so
    // the heartbeat watchdog (which also polls every N minutes) will skip its
    // own restart attempt if it fires while we're mid-sequence. Clear in the
    // IIFE's finally only.
    if (enabledChanged) {
      // [zalo-watchdog rearm] CEO toggling Zalo enabled/disabled rearms the
      // listener watchdog. Config flip means CEO has deliberately changed
      // channel state — prior gave-up / restart streak is stale. Reset all 3.
      global._zaloListenerGaveUp = false;
      global._zaloListenerRestartHistory = [];
      global._zaloListenerMissStreak = 0;
      console.log('[zalo-watchdog] reset gave-up / streak by CEO action');
      if (ctx.startOpenClawInFlight) {
        console.log(`[save-zalo-manager] channels.modoro-zalo.enabled ${prevEnabled}→${newEnabled} — gateway spawn in progress, skip restart (will read new config)`);
      } else if (ctx.gatewayRestartInFlight) {
        console.log('[restart-guard] save-zalo-manager: restart already in-flight — skipping duplicate');
      } else {
        ctx.gatewayRestartInFlight = true;
        console.log(`[save-zalo-manager] channels.modoro-zalo.enabled ${prevEnabled}→${newEnabled} — hard-restart gateway (bg)`);
        // Fire-and-forget so IPC returns fast — UI sidebar dots will flip
        // to checking→ready via channel-status broadcast as gateway boots.
        (async () => {
          try {
            console.log('[restart-guard] save-zalo-manager: hard-restart begin');
            try { await stopOpenClaw(); } catch (e1) { console.warn('[save-zalo-manager] stop failed:', e1?.message); }
            await new Promise(r => setTimeout(r, 2000));
            try { await startOpenClaw({ ignoreCooldown: true }); } catch (e2) { console.warn('[save-zalo-manager] start failed:', e2?.message); }
            global._zaloListenerMissStreak = 0;
            console.log('[restart-guard] save-zalo-manager: hard-restart end');
          } finally {
            ctx.gatewayRestartInFlight = false;
          }
        })();
      }
    } else {
      console.log('[save-zalo-manager] no enable/disable flip — skipping restart (realtime patches apply)');
    }
    return { success: gateOk };
  });
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    _saveZaloManagerInFlight = false;
    ctx.ipcInFlightCount--;
  }
});

// Save personalization (industry, tone, pronouns)
ipcMain.handle('save-personalization', async (_event, { industry, tone, pronouns, ceoTitle, botName, personaMix, selectedPersona }) => {
  try {
    // Validate inputs
    const VALID_INDUSTRIES = ['bat-dong-san', 'fnb', 'thuong-mai', 'dich-vu', 'giao-duc', 'cong-nghe', 'san-xuat', 'tong-quat'];
    if (!VALID_INDUSTRIES.includes(industry)) return { success: false, error: 'Invalid industry' };
    const VALID_TONES = ['professional', 'friendly', 'concise'];
    if (!VALID_TONES.includes(tone)) tone = 'friendly';
    const VALID_PRONOUNS = ['em-anh-chi', 'toi-quy-khach', 'minh-ban'];
    if (!VALID_PRONOUNS.includes(pronouns)) pronouns = 'em-anh-chi';
    ceoTitle = (ceoTitle || '').replace(/[\n\r]/g, '').substring(0, 50).trim();
    // Bot name is optional — if provided, replace the placeholder in IDENTITY.md.
    // If empty, the bot self-refers as "em" (from pronouns config) without a personal name.
    botName = (botName || '').replace(/[\n\r]/g, '').substring(0, 30).trim();
    // Empty ceoTitle is a wizard bug — IDENTITY.md would end up with literal
    // "gọi chủ nhân là " with no name → bot falls back to template default
    // (which used to be hardcoded "thầy Huy" — see IDENTITY.md template fix).
    // Refuse to write a broken file: surface error so wizard can re-prompt.
    if (!ceoTitle) {
      console.error('[save-personalization] empty ceoTitle — refusing to write IDENTITY.md');
      return { success: false, error: 'ceoTitle bắt buộc — vui lòng nhập "Trợ lý gọi bạn là" trong wizard' };
    }
    console.log('[save-personalization] industry=' + industry + ' tone=' + tone + ' pronouns=' + pronouns + ' ceoTitle="' + ceoTitle + '" botName="' + botName + '"');

    // Industry name map for display
    const INDUSTRY_NAMES = {
      'bat-dong-san': 'Bất động sản',
      'fnb': 'F&B (Nhà hàng, Quán cà phê)',
      'thuong-mai': 'Thương mại / Bán lẻ',
      'dich-vu': 'Dịch vụ (Spa, Salon, Phòng khám)',
      'giao-duc': 'Giáo dục / Đào tạo',
      'cong-nghe': 'Công nghệ / IT',
      'san-xuat': 'Sản xuất',
      'tong-quat': 'Tổng quát',
    };

    const ws = getWorkspace();
    // 1. Copy skill file -> skills/active.md
    const skillSrc = path.join(ws, 'skills', `${industry}.md`);
    const skillDst = path.join(ws, 'skills', 'active.md');
    if (fs.existsSync(skillSrc)) fs.copyFileSync(skillSrc, skillDst);

    // 2. Copy industry workflow -> industry/active.md
    const indSrc = path.join(ws, 'industry', `${industry}.md`);
    const indDst = path.join(ws, 'industry', 'active.md');
    if (fs.existsSync(indSrc)) fs.copyFileSync(indSrc, indDst);

    // 3. Copy SOP templates -> prompts/sop/active.md
    const sopDir = path.join(ws, 'prompts', 'sop');
    if (!fs.existsSync(sopDir)) fs.mkdirSync(sopDir, { recursive: true });
    const sopSrc = path.join(sopDir, `${industry}.md`);
    const sopDst = path.join(sopDir, 'active.md');
    if (fs.existsSync(sopSrc)) fs.copyFileSync(sopSrc, sopDst);

    // 4. Copy training guide -> prompts/training/active.md
    const trainDir = path.join(ws, 'prompts', 'training');
    if (!fs.existsSync(trainDir)) fs.mkdirSync(trainDir, { recursive: true });
    const trainSrc = path.join(trainDir, `${industry}.md`);
    const trainDst = path.join(trainDir, 'active.md');
    if (fs.existsSync(trainSrc)) fs.copyFileSync(trainSrc, trainDst);

    // 5. Update IDENTITY.md with tone, pronouns, industry
    const identityPath = path.join(ws, 'IDENTITY.md');
    if (!fs.existsSync(identityPath)) {
      // seedWorkspace should have created this. If missing, the bot would
      // fall back to whatever stale copy is in the bundle (with hardcoded
      // example name). Log loudly and try to seed it now from the template.
      console.error('[save-personalization] IDENTITY.md missing at ' + identityPath + ' — re-seeding');
      try { seedWorkspace(); } catch (e) { console.error('[save-personalization] re-seed failed:', e.message); }
    }
    if (fs.existsSync(identityPath)) {
      let content = fs.readFileSync(identityPath, 'utf-8');
      const pronounMap = {
        'em-anh-chi': 'em — gọi ' + ceoTitle,
        'toi-quy-khach': 'tôi — gọi ' + ceoTitle,
        'minh-ban': 'mình — gọi ' + ceoTitle,
      };
      const toneMap = {
        'professional': 'Chuyên nghiệp, lịch sự, rõ ràng. Phù hợp giao tiếp doanh nghiệp.',
        'friendly': 'Thân thiện, gần gũi, nhiệt tình. Phù hợp ngành dịch vụ, bán lẻ.',
        'concise': 'Ngắn gọn, hiệu quả, đi thẳng vào vấn đề. Không dài dòng.',
      };
      const xunghoLine = `- **Cách xưng hô:** ${pronounMap[pronouns] || pronounMap['em-anh-chi']}`;
      const phongcachLine = `- **Phong cách:** ${toneMap[tone] || toneMap['friendly']}`;
      const nganhLine = `- **Ngành:** ${INDUSTRY_NAMES[industry] || industry}`;
      const before = content;
      // Bot name — replace the "[Tên trợ lý của bạn]" placeholder or update
      // an existing name. If botName is empty, write a sensible default so the
      // template placeholder doesn't show up in bot introductions.
      const botNameLine = `- **Tên:** ${botName || 'Trợ lý 9BizClaw'}`;
      content = content.replace(/- \*\*Tên:\*\* .*/, botNameLine);
      content = content.replace(/- \*\*Cách xưng hô:\*\* .*/, xunghoLine);
      content = content.replace(/- \*\*Phong cách:\*\* .*/, phongcachLine);
      content = content.replace(/- \*\*Ngành:\*\* .*/, nganhLine);
      if (content === before) {
        // Replace did nothing — IDENTITY.md is missing the expected lines.
        // Append them so bot still gets the right ceoTitle even on a malformed
        // template.
        console.warn('[save-personalization] IDENTITY.md missing expected lines — appending');
        content = content.trimEnd() + '\n\n' + xunghoLine + '\n' + phongcachLine + '\n' + nganhLine + '\n';
      }
      fs.writeFileSync(identityPath, content, 'utf-8');
      // Read back to confirm the write actually persisted (catches silent
      // permission failures on packaged Windows installs where workspace
      // happens to be the install dir).
      const verify = fs.readFileSync(identityPath, 'utf-8');
      if (!verify.includes(ceoTitle)) {
        console.error('[save-personalization] write verification FAILED — ceoTitle not in file after write');
        return { success: false, error: 'IDENTITY.md write verification failed — file does not contain ceoTitle after write. Có thể workspace không writable.' };
      }
      console.log('[save-personalization] IDENTITY.md updated OK at ' + identityPath);
    } else {
      console.error('[save-personalization] IDENTITY.md still missing after re-seed attempt');
      return { success: false, error: 'IDENTITY.md không tồn tại — workspace bị hỏng' };
    }

    // Save persona mix config from wizard. Bot reads compiled active-persona.md
    // on bootstrap. JSON config saved separately for Dashboard settings edit.
    // personaMix format: { region, voice, customer, traits:[], formality:1-10,
    //                      greeting, closing, phrases }
    // Legacy: `selectedPersona` (archetype id) still accepted for backwards
    // compat — if present and personaMix missing, map to default mix.
    try {
      let mix = personaMix;
      if (!mix || typeof mix !== 'object') {
        // Legacy fallback: single archetype id → default mix
        mix = { voice: 'em-nu-tre', customer: 'anh-chi', traits: ['am-ap', 'chu-dao'], formality: 5, greeting: '', closing: '', phrases: '' };
      }
      // Write structured JSON for Dashboard settings editor
      const mixJsonPath = path.join(ws, 'active-persona.json');
      writeJsonAtomic(mixJsonPath, mix);
      // Write compiled Markdown for bot bootstrap read
      const compiledPath = path.join(ws, 'active-persona.md');
      fs.writeFileSync(compiledPath, compilePersonaMix(mix), 'utf-8');
      // Clean up legacy active-persona.txt if present (from v2.2.35)
      try {
        const legacyPath = path.join(ws, 'active-persona.txt');
        if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath);
      } catch {}
      console.log('[save-personalization] persona mix saved: voice=' + mix.voice + ' traits=' + (mix.traits || []).length + ' formality=' + mix.formality);
      syncPersonaToBootstrap();
    } catch (e) { console.warn('[save-personalization] persona mix write failed:', e?.message); }

    // Delete BOOTSTRAP.md — it's single-use, wizard completion means bot is
    // bootstrapped. Leaving it wastes ~1.5k chars per session-bootstrap read.
    // The file itself says "Sau lần chạy đầu: Xoá file này" — we enforce that
    // here so the bot doesn't need to remember to do it.
    try {
      const bootstrapPath = path.join(ws, 'BOOTSTRAP.md');
      if (fs.existsSync(bootstrapPath)) {
        fs.unlinkSync(bootstrapPath);
        console.log('[save-personalization] BOOTSTRAP.md deleted (wizard complete)');
      }
    } catch (e) { console.warn('[save-personalization] BOOTSTRAP.md cleanup failed:', e?.message); }

    return { success: true };
  } catch (e) {
    console.error('[save-personalization] error:', e?.message || e);
    return { success: false, error: e.message };
  }
});

// =====================================================================
//  Save business profile (wizard step 1+1c) — enterprise onboarding
// =====================================================================
// Collects high-impact business context and writes:
//   - COMPANY.md      → company name + description (bot uses to reply Zalo customers
//                       with real context, not generic boilerplate)
//   - IDENTITY.md     → team size note (bot knows when to escalate vs decide alone)
//   - schedules.json  → morning cron time = workStart, evening cron time = workEnd
//                       (instead of hardcoded 07:30 / 21:00)
//   - memory/projects/business-goals.md → list of selected goals (bot reads on session
//                       start to know focus area)
ipcMain.handle('save-business-profile', async (_event, payload) => {
  try {
    const {
      companyName = '',
      companyDesc = '',
      teamSize = 'small',
      workStart = '07:30',
      workEnd = '21:00',
      goals = [],
      ceoName = '',
      bizProduct = '',
      bizAudience = '',
      bizHighlight = '',
      bizPhone = '',
      bizAddress = '',
    } = payload || {};

    // Sanitize inputs (file content goes into Markdown templates → strip control chars)
    const sanitize = (s, maxLen = 500) => String(s || '').replace(/[\u0000-\u001F\u007F]/g, ' ').substring(0, maxLen).trim();
    const cName = sanitize(companyName, 100);
    const cDesc = sanitize(companyDesc, 500);
    const ceoN = sanitize(ceoName, 100);
    const bProduct = sanitize(bizProduct, 300);
    const bAudience = sanitize(bizAudience, 300);
    const bHighlight = sanitize(bizHighlight, 500);
    const bPhone = sanitize(bizPhone, 20);
    const bAddress = sanitize(bizAddress, 200);
    const VALID_TEAM = ['solo', 'small', 'medium', 'large'];
    const tSize = VALID_TEAM.includes(teamSize) ? teamSize : 'small';
    const VALID_GOALS = ['zalo-auto-reply', 'daily-reports', 'schedule-mgmt', 'staff-reminders', 'customer-followup', 'competitor-watch'];
    const gList = Array.isArray(goals) ? goals.filter(g => VALID_GOALS.includes(g)) : [];
    // Validate HH:MM format
    const validTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || ''));
    const wStart = validTime(workStart) ? workStart : '07:30';
    const wEnd = validTime(workEnd) ? workEnd : '21:00';

    console.log('[save-business-profile]', { cName, tSize, wStart, wEnd, goalCount: gList.length });

    const ws = getWorkspace();
    if (!ws) return { success: false, error: 'Workspace không tồn tại' };

    // 1. Update COMPANY.md (overwrite "Thông tin chung" section if exists, else append)
    const companyPath = path.join(ws, 'COMPANY.md');
    if (!fs.existsSync(companyPath)) {
      try { seedWorkspace(); } catch {}
    }
    if (fs.existsSync(companyPath)) {
      let content = fs.readFileSync(companyPath, 'utf-8');
      const teamSizeLabel = {
        solo: 'Solo founder (chỉ 1 người)',
        small: '2-10 người',
        medium: '11-50 người',
        large: '51+ người',
      }[tSize];
      const profileBlock =
        '<!-- WIZARD AUTO-FILLED -->\n' +
        '## Thông tin chung\n\n' +
        '- **Tên:** ' + (cName || '[chưa điền]') + '\n' +
        (ceoN ? '- **Người đại diện:** ' + ceoN + '\n' : '') +
        '- **Quy mô:** ' + teamSizeLabel + '\n' +
        '- **Giờ làm việc:** ' + wStart + ' - ' + wEnd + '\n' +
        (bPhone ? '- **SĐT:** ' + bPhone + '\n' : '') +
        (bAddress ? '- **Địa chỉ:** ' + bAddress + '\n' : '') +
        (cDesc ? '\n## Giới thiệu\n\n' + cDesc + '\n' : '') +
        '<!-- /WIZARD AUTO-FILLED -->\n';
      // Replace block if marker present, else inject after first H1 or at top
      if (content.includes('<!-- WIZARD AUTO-FILLED -->')) {
        content = content.replace(/<!-- WIZARD AUTO-FILLED -->[\s\S]*?<!-- \/WIZARD AUTO-FILLED -->\n?/, profileBlock);
      } else {
        // First run: strip the empty template "## Thông tin chung" section so we
        // don't end up with duplicate headings (template has placeholder fields,
        // wizard has real ones — wizard wins). Match from "## Thông tin chung"
        // to next "## " heading or end of file.
        content = content.replace(/## Thông tin chung[\s\S]*?(?=\n## |\n*$)/, '');
        // Inject wizard block right after H1 + blockquote
        const lines = content.split('\n');
        const h1Idx = lines.findIndex(l => l.startsWith('# '));
        if (h1Idx >= 0) {
          let insertAt = h1Idx + 1;
          while (insertAt < lines.length && (lines[insertAt].trim() === '' || lines[insertAt].startsWith('>') || lines[insertAt].trim() === '---')) insertAt++;
          lines.splice(insertAt, 0, '', profileBlock);
          content = lines.join('\n');
        } else {
          content = profileBlock + '\n' + content;
        }
      }
      fs.writeFileSync(companyPath, content, 'utf-8');
      console.log('[save-business-profile] COMPANY.md updated');
    }

    // 1b. Update PRODUCTS.md — replace placeholder template with wizard-collected info.
    // Wizard asks "Bán gì" (product) + "Cho ai" (audience) + "Điểm khác biệt" (highlight).
    // Bot reads PRODUCTS.md to answer customer questions about products/services.
    // If user has already edited PRODUCTS.md manually (no marker), skip to preserve their edits.
    const productsPath = path.join(ws, 'PRODUCTS.md');
    if (fs.existsSync(productsPath) && (bProduct || bAudience || bHighlight)) {
      let productsContent = fs.readFileSync(productsPath, 'utf-8');
      const isTemplate = productsContent.includes('[Tên sản phẩm 1]') || productsContent.includes('<!-- WIZARD AUTO-FILLED -->');
      if (isTemplate) {
        const wizardBlock =
          '<!-- WIZARD AUTO-FILLED -->\n' +
          '## Sản phẩm / Dịch vụ chính\n\n' +
          (bProduct ? '**Bán gì:** ' + bProduct + '\n\n' : '') +
          (bAudience ? '**Khách hàng mục tiêu:** ' + bAudience + '\n\n' : '') +
          (bHighlight ? '**Điểm khác biệt / Lợi thế:** ' + bHighlight + '\n\n' : '') +
          '> Anh/chị bổ sung bảng giá chi tiết bên dưới khi có.\n' +
          '<!-- /WIZARD AUTO-FILLED -->\n\n';
        if (productsContent.includes('<!-- WIZARD AUTO-FILLED -->')) {
          productsContent = productsContent.replace(/<!-- WIZARD AUTO-FILLED -->[\s\S]*?<!-- \/WIZARD AUTO-FILLED -->\n?\n?/, wizardBlock);
        } else {
          // First run: strip placeholder product table (from "## Bảng sản phẩm" to next "## ")
          productsContent = productsContent.replace(/## Bảng sản phẩm[\s\S]*?(?=\n## |$)/, '');
          const lines = productsContent.split('\n');
          const h1Idx = lines.findIndex(l => l.startsWith('# '));
          if (h1Idx >= 0) {
            let insertAt = h1Idx + 1;
            while (insertAt < lines.length && (lines[insertAt].trim() === '' || lines[insertAt].startsWith('>') || lines[insertAt].trim() === '---')) insertAt++;
            lines.splice(insertAt, 0, '', wizardBlock);
            productsContent = lines.join('\n');
          } else {
            productsContent = wizardBlock + productsContent;
          }
        }
        fs.writeFileSync(productsPath, productsContent, 'utf-8');
        console.log('[save-business-profile] PRODUCTS.md updated');
      } else {
        console.log('[save-business-profile] PRODUCTS.md has custom edits — skipping wizard overwrite');
      }
    }

    // 2. Update schedules.json — set morning cron = workStart, evening cron = workEnd
    const schedPath = path.join(ws, 'schedules.json');
    let schedules = DEFAULT_SCHEDULES_JSON.map(s => ({ ...s }));
    if (fs.existsSync(schedPath)) {
      try { schedules = JSON.parse(fs.readFileSync(schedPath, 'utf-8')); } catch {}
    }
    let schedChanged = false;
    for (const s of schedules) {
      if (s.id === 'morning' && s.time !== wStart) { s.time = wStart; schedChanged = true; }
      if (s.id === 'evening' && s.time !== wEnd) { s.time = wEnd; schedChanged = true; }
    }
    if (schedChanged) {
      writeJsonAtomic(schedPath, schedules);
      console.log('[save-business-profile] schedules.json updated: morning=' + wStart + ' evening=' + wEnd);
    }

    // 3. Write business goals to memory/projects/business-goals.md
    // Bot reads memory on session start → knows focus area without CEO restating it
    if (gList.length > 0) {
      const GOAL_LABELS = {
        'zalo-auto-reply': 'Trả tin Zalo tự động cho khách hàng',
        'daily-reports': 'Báo cáo hàng ngày (doanh thu, KPI, vấn đề)',
        'schedule-mgmt': 'Quản lý lịch họp + nhắc lịch + follow-up',
        'staff-reminders': 'Nhắc nhở nhân viên (báo cáo, deadline, ca trực)',
        'customer-followup': 'Follow-up khách quan tâm chưa chốt',
        'competitor-watch': 'Theo dõi tin tức đối thủ + biến động thị trường',
      };
      const goalsDir = path.join(ws, 'memory', 'projects');
      try { fs.mkdirSync(goalsDir, { recursive: true }); } catch {}
      const goalsPath = path.join(goalsDir, 'business-goals.md');
      const goalsContent =
        '# Mục tiêu CEO khi dùng 9BizClaw\n\n' +
        '> Tự fill từ wizard onboarding. CEO chọn các việc trợ lý nên giúp nhiều nhất.\n' +
        '> Bot đọc file này MỖI session để biết focus area.\n\n' +
        '## Ưu tiên hỗ trợ\n\n' +
        gList.map((g, i) => (i + 1) + '. **' + GOAL_LABELS[g] + '**').join('\n') + '\n\n' +
        '---\n\n' +
        '_Cập nhật: ' + new Date().toISOString().slice(0, 10) + '_\n';
      fs.writeFileSync(goalsPath, goalsContent, 'utf-8');
      console.log('[save-business-profile] business-goals.md written with ' + gList.length + ' goals');
    }

    // 4. Add team-size hint to IDENTITY.md (bot knows when to escalate vs decide solo)
    const identityPath = path.join(ws, 'IDENTITY.md');
    if (fs.existsSync(identityPath)) {
      let content = fs.readFileSync(identityPath, 'utf-8');
      const teamHint = {
        solo: 'Solo founder — anh/chị tự quyết mọi việc, em báo trực tiếp, không cần hỏi ý kiến team.',
        small: '2-10 người — em có thể nhắc nhân viên qua Zalo, nhưng quyết định lớn phải hỏi anh/chị.',
        medium: '11-50 người — có nhiều phòng ban, em escalate đúng người chịu trách nhiệm khi cần.',
        large: '51+ người — quy mô lớn, em ưu tiên báo cáo cấp cao, không can thiệp vận hành chi tiết.',
      }[tSize];
      const teamLine = '- **Quy mô đội ngũ:** ' + teamHint;
      if (content.includes('- **Quy mô đội ngũ:**')) {
        content = content.replace(/- \*\*Quy mô đội ngũ:\*\* .*/, teamLine);
      } else {
        // Insert after the Cách xưng hô line
        content = content.replace(
          /(- \*\*Cách xưng hô:\*\* .*)/,
          '$1\n' + teamLine
        );
      }
      // Inject "## Em đang làm việc tại" block at top so bot ALWAYS sees company
      // context — bot reads IDENTITY.md first per AGENTS.md bootstrap chain. This
      // is critical: COMPANY.md is technically loaded but bot may skip reads on
      // short messages ("ping"). IDENTITY.md is small + highest-priority → never
      // skipped. Idempotent via marker.
      const bizMarkerStart = '<!-- WIZARD-BUSINESS-PROFILE -->';
      const bizMarkerEnd = '<!-- /WIZARD-BUSINESS-PROFILE -->';
      const bizLines = [bizMarkerStart, '## Em đang làm việc tại'];
      if (cName) bizLines.push('- **Công ty:** ' + cName);
      if (cDesc) bizLines.push('- **Mô tả:** ' + cDesc);
      bizLines.push(bizMarkerEnd, '');
      const bizBlock = bizLines.join('\n');
      if (cName || cDesc) {
        if (content.includes(bizMarkerStart)) {
          content = content.replace(
            new RegExp(bizMarkerStart + '[\\s\\S]*?' + bizMarkerEnd + '\\n?'),
            bizBlock
          );
        } else {
          // Insert AFTER the H1 title (# IDENTITY.md — Tôi Là Ai?) so it's the
          // first content block bot sees after the heading.
          const lines = content.split('\n');
          const h1Idx = lines.findIndex(l => l.startsWith('# '));
          const insertAt = h1Idx >= 0 ? h1Idx + 1 : 0;
          // Skip blank lines after H1
          let insertPos = insertAt;
          while (insertPos < lines.length && lines[insertPos].trim() === '') insertPos++;
          lines.splice(insertPos, 0, '', bizBlock);
          content = lines.join('\n');
        }
      }
      fs.writeFileSync(identityPath, content, 'utf-8');
    }

    // 5. Write business profile to memory/projects/business-profile.md so it
    // shows up in MEMORY.md projects index + bot can search/recall it via
    // memory_search("bán gì") etc. Stable file name → idempotent overwrite.
    try {
      const projDir = path.join(ws, 'memory', 'projects');
      fs.mkdirSync(projDir, { recursive: true });
      const profPath = path.join(projDir, 'business-profile.md');
      const profLines = [
        '# Hồ sơ doanh nghiệp',
        '',
        '> File này do wizard onboarding tự ghi. Bot dùng để biết "công ty làm gì, bán gì, bán cho ai".',
        '> Cập nhật bằng cách chạy lại wizard hoặc sửa tay file này.',
        '',
        '## Tổng quan',
        '',
      ];
      if (cName) profLines.push('- **Tên công ty:** ' + cName);
      if (ceoN) profLines.push('- **Người đại diện:** ' + ceoN);
      if (bPhone) profLines.push('- **SĐT:** ' + bPhone);
      if (bAddress) profLines.push('- **Địa chỉ:** ' + bAddress);
      const teamSizeLabel2 = {
        solo: 'Solo founder (1 người)',
        small: '2-10 người',
        medium: '11-50 người',
        large: '51+ người',
      }[tSize];
      profLines.push('- **Quy mô:** ' + teamSizeLabel2);
      profLines.push('- **Giờ làm việc:** ' + wStart + ' - ' + wEnd);
      if (cDesc) {
        profLines.push('');
        profLines.push('## Mô tả');
        profLines.push('');
        profLines.push(cDesc);
      }
      if (gList.length > 0) {
        profLines.push('');
        profLines.push('## Trợ lý dùng để');
        profLines.push('');
        const goalLabels = {
          'zalo-auto-reply': 'Trả tin Zalo tự động',
          'daily-reports': 'Báo cáo hàng ngày',
          'schedule-mgmt': 'Quản lý lịch họp',
          'staff-reminders': 'Nhắc nhân viên',
          'customer-followup': 'Follow-up khách',
          'competitor-watch': 'Theo dõi đối thủ',
        };
        for (const g of gList) profLines.push('- ' + (goalLabels[g] || g));
      }
      profLines.push('');
      profLines.push('---');
      profLines.push('Cập nhật lần cuối: ' + new Date().toISOString().slice(0, 10));
      profLines.push('');
      fs.writeFileSync(profPath, profLines.join('\n'), 'utf-8');
      console.log('[save-business-profile] memory/projects/business-profile.md written');
    } catch (e) {
      console.warn('[save-business-profile] business-profile.md write failed:', e?.message);
    }

    return { success: true };
  } catch (e) {
    console.error('[save-business-profile] error:', e?.message || e);
    return { success: false, error: e.message };
  }
});

// Google Calendar + Gmail integration via `gog-cli`.
//
// STATUS (2026-04-07): The `gog-cli` npm package referenced here does NOT
// currently exist on the public npm registry. Calling this handler used to
// silently fail in npm install (404), then crash with "command not found"
// when spawning `gog auth`. On Mac the failure is even louder because
// `npm install -g` requires write permission to /usr/local/lib/node_modules
// and pops a permission error.
//
// Until a working Google integration is shipped, this handler returns a
// graceful "not implemented" response so the wizard can show a clear message
// instead of throwing. The Dashboard's "Google" channel chip stays at
// `not_configured` (handled by check-all-channels which only looks for
// ~/.gog/token.json — won't exist).
// Batch config set (for complex nested objects like model providers)
// Batch config set — write JSON directly
ipcMain.handle('set-batch-config', async (_event, ops) => {
  const booting = rejectIfBooting('set-batch-config');
  if (booting) return booting;
  ctx.ipcInFlightCount++;
  try {
    return await withOpenClawConfigLock(async () => {
      try {
        console.log('[config-lock] set-batch-config acquired');
        const configPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        let config = {};
        if (fs.existsSync(configPath)) {
          try { config = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch {}
        }
        const UNSAFE_KEYS = ['__proto__', 'constructor', 'prototype'];
        for (const op of ops) {
          const parts = op.path.split('.');
          if (parts.some(p => UNSAFE_KEYS.includes(p))) continue;
          let obj = config;
          for (let i = 0; i < parts.length - 1; i++) {
            if (!obj[parts[i]] || typeof obj[parts[i]] !== 'object') obj[parts[i]] = {};
            obj = obj[parts[i]];
          }
          obj[parts[parts.length - 1]] = op.value;
        }
        writeOpenClawConfigIfChanged(configPath, config);
        return { success: true };
      } catch (e) { return { success: false, error: e.message }; }
    });
  } finally { ctx.ipcInFlightCount--; }
});

// Save config by writing openclaw.json directly — no CLI dependency
ipcMain.handle('save-wizard-config', async (_event, configs) => {
  // Not gated by rejectIfBooting — wizard runs before boot by design.
  ctx.ipcInFlightCount++;
  try {
    return await withOpenClawConfigLock(async () => {
      try {
        console.log('[config-lock] save-wizard-config acquired');
        const configPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        let config = {};
        if (fs.existsSync(configPath)) {
          try { config = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch {}
        }
        const UNSAFE_KEYS = ['__proto__', 'constructor', 'prototype'];
        for (const { key, value } of configs) {
          const parts = key.split('.');
          if (parts.some(p => UNSAFE_KEYS.includes(p))) continue;
          let obj = config;
          for (let i = 0; i < parts.length - 1; i++) {
            if (!obj[parts[i]] || typeof obj[parts[i]] !== 'object') obj[parts[i]] = {};
            obj = obj[parts[i]];
          }
          obj[parts[parts.length - 1]] = value;
        }

      // Auto-fix required fields OpenClaw expects
      if (config.channels?.telegram?.botToken && !config.channels.telegram.enabled) {
        config.channels.telegram.enabled = true;
      }
      // If wizard enabled modoro-zalo, ensure dmPolicy="open" + allowFrom=["*"] so
      // unknown DM senders don't get the "access not configured" pairing reply.
      // (modoro-zalo plugin defaults dmPolicy to "pairing" if missing.)
      if (config.channels?.['modoro-zalo']?.enabled) {
        if (config.channels['modoro-zalo'].dmPolicy !== 'open') {
          config.channels['modoro-zalo'].dmPolicy = 'open';
        }
        if (!Array.isArray(config.channels['modoro-zalo'].allowFrom)) {
          config.channels['modoro-zalo'].allowFrom = ['*'];
        }
      }
      // Create required dirs
      const sessDir = path.join(ctx.HOME, '.openclaw', 'agents', 'main', 'sessions');
      fs.mkdirSync(sessDir, { recursive: true });

        writeOpenClawConfigIfChanged(configPath, config);
        return { success: true };
      } catch (e) { return { success: false, error: e.message }; }
    });
  } finally { ctx.ipcInFlightCount--; }
});

// Add cron — save custom times to claw-schedules.json (bypasses broken CLI)
ipcMain.handle('add-cron', async (_event, { name, cron, tz, message, channel }) => {
  try {
    // Parse cron expression to extract time (e.g., "30 7 * * *" → "07:30")
    const parts = (cron || '').split(/\s+/);
    if (parts.length >= 2) {
      const m = parts[0].padStart(2, '0');
      const h = parts[1].padStart(2, '0');
      const time = `${h}:${m}`;
      const schedules = loadSchedules();
      // Map cron name to schedule ID
      if (name && name.toLowerCase().includes('sang') || name && name.toLowerCase().includes('morning')) {
        const s = schedules.find(x => x.id === 'morning');
        if (s) { s.time = time; s.enabled = true; }
      } else if (name && name.toLowerCase().includes('toi') || name && name.toLowerCase().includes('evening')) {
        const s = schedules.find(x => x.id === 'evening');
        if (s) { s.time = time; s.enabled = true; }
      }
      writeJsonAtomic(getSchedulesPath(), schedules);
      restartCronJobs();
      console.log('[add-cron] Saved custom time:', name, time);
    }
    return { success: true };
  } catch (e) {
    console.error('[add-cron] error:', e.message);
    return { success: false, error: e.message };
  }
});

// Schedule management — extracted to lib/cron.js (Task 19)
// getSchedulesPath, getCustomCronsPath, legacySchedulesPaths, legacyCustomCronsPaths,
// loadSchedules, loadDailySummaries, generateWeeklySummary, loadWeeklySummaries,
// loadPromptTemplate, buildMorningBriefingPrompt, buildEveningSummaryPrompt,
// buildWeeklyReportPrompt, buildMonthlyReportPrompt, scanZaloFollowUpCandidates,
// buildZaloFollowUpPrompt, buildMeditationPrompt, buildMemoryCleanupPrompt
// — all now imported from lib/cron.js
// (legacyCustomCronsPaths moved to lib/cron.js)

// loadSchedules — moved to lib/cron.js

ipcMain.handle('get-schedules', async () => {
  return loadSchedules();
});

ipcMain.handle('get-custom-crons', async () => {
  // Merge MODOROClaw custom-crons.json + OpenClaw built-in cron/jobs.json.
  // The bot creates crons via OpenClaw's `cron` tool (saved to
  // ~/.openclaw/cron/jobs.json), NOT to custom-crons.json. The Dashboard
  // previously only read custom-crons.json, so bot-created crons were
  // invisible to the CEO. Fix: read both, merge, dedupe by ID, label
  // OpenClaw crons with source:'openclaw' so Dashboard can distinguish.
  const modoroEntries = loadCustomCrons().map(c => ({ ...c, source: 'modoro' }));
  let openclawEntries = [];
  try {
    const ocJobsPath = path.join(ctx.HOME, '.openclaw', 'cron', 'jobs.json');
    if (fs.existsSync(ocJobsPath)) {
      const raw = JSON.parse(fs.readFileSync(ocJobsPath, 'utf-8'));
      const jobs = Array.isArray(raw?.jobs) ? raw.jobs : [];
      for (const j of jobs) {
        if (!j || !j.id) continue;
        // Map OpenClaw cron format → MODOROClaw display format
        const schedExpr = j.schedule?.expr || j.schedule?.at || '';
        const kind = j.schedule?.kind || 'cron';
        let displayTime = schedExpr;
        if (kind === 'at') {
          try {
            const d = new Date(j.schedule.at);
            displayTime = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} (một lần)`;
          } catch {}
        }
        openclawEntries.push({
          id: 'oc_' + j.id,
          label: j.name || 'OpenClaw cron',
          cronExpr: schedExpr,
          displayTime,
          prompt: j.payload?.text || j.payload?.message || '(hệ thống)',
          enabled: j.enabled !== false,
          createdAt: j.createdAtMs ? new Date(j.createdAtMs).toISOString() : '',
          source: 'openclaw',
          // Extra metadata for display
          lastStatus: j.state?.lastRunStatus || null,
          nextRunAt: j.state?.nextRunAtMs ? new Date(j.state.nextRunAtMs).toISOString() : null,
          deleteAfterRun: j.deleteAfterRun || false,
        });
      }
    }
  } catch (e) {
    console.warn('[get-custom-crons] failed to read OpenClaw cron/jobs.json:', e?.message);
  }
  // Merge: OpenClaw entries first (they're the ones bot created), then MODOROClaw
  return [...openclawEntries, ...modoroEntries];
});

ipcMain.handle('save-custom-crons', async (_event, crons) => {
  try {
    if (!Array.isArray(crons)) return { success: false, error: 'crons must be an array' };
    // CRIT #7: Dashboard `get-custom-crons` merges MODOROClaw crons with
    // OpenClaw-sourced entries (source:'openclaw' — bot-created crons read
    // from ~/.openclaw/agents/main/jobs.json). FE passes the merged array back
    // on any toggle/delete. If we wrote it verbatim, those OpenClaw entries
    // would get copied INTO our custom-crons.json and double-fire every day.
    // Strip anything not ours before persisting.
    const mine = crons.filter(c => c && c.source !== 'openclaw');
    // Validate cronExpr so a malformed entry doesn't crash the cron scheduler
    // on the watcher reload (which would then keep re-firing).
    const nodeCron = require('node-cron');
    for (const c of mine) {
      if (c && typeof c.cronExpr === 'string' && !nodeCron.validate(c.cronExpr)) {
        return { success: false, error: `Cron expression invalid: "${c.cronExpr}" (label: ${c.label || c.id || '?'})` };
      }
    }
    await _withCustomCronLock(async () => { writeJsonAtomic(getCustomCronsPath(), mine); });
    // CRITICAL: do NOT rely on the file watcher alone — fs.watch is unreliable
    // on Windows + atomic-replace editors. Explicitly reload cron jobs after
    // every write so the new schedule takes effect immediately, even if the
    // watcher missed the event. The watcher's debounce will dedupe the second
    // call if it does fire.
    try { restartCronJobs(); } catch (e) { console.error('[save-custom-crons] restartCronJobs error:', e.message); }
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('delete-openclaw-cron', async (_event, jobId) => {
  try {
    if (!jobId || typeof jobId !== 'string') return { success: false, error: 'jobId required' };
    const realId = jobId.startsWith('oc_') ? jobId.slice(3) : jobId;
    const ocJobsPath = path.join(ctx.HOME, '.openclaw', 'cron', 'jobs.json');
    if (!fs.existsSync(ocJobsPath)) return { success: false, error: 'jobs.json not found' };
    const raw = JSON.parse(fs.readFileSync(ocJobsPath, 'utf-8'));
    const before = Array.isArray(raw?.jobs) ? raw.jobs.length : 0;
    raw.jobs = (raw.jobs || []).filter(j => j && j.id !== realId);
    if (raw.jobs.length === before) return { success: false, error: 'job not found: ' + realId };
    writeJsonAtomic(ocJobsPath, raw);
    console.log('[delete-openclaw-cron] deleted job:', realId);
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('save-schedules', async (_event, schedules) => {
  try {
    writeJsonAtomic(getSchedulesPath(), schedules);
    restartCronJobs(); // Re-schedule with new settings
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

// Re-run boot diagnostic on demand (Dashboard exposes a "Diagnostic" button).
// Returns the latest diagnostic file content as a string the UI can render.
ipcMain.handle('cron-diagnostic', async () => {
  try {
    bootDiagRunFullCheck();
    const file = path.join(getWorkspace(), 'logs', 'boot-diagnostic.txt');
    const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
    return {
      success: true,
      file,
      content,
      summary: {
        platform: process.platform,
        arch: process.arch,
        nodeBin: findNodeBin() || null,
        openclawBin: findOpenClawBinSync() || null,
        openclawCli: findOpenClawCliJs() || null,
        agentProfile: getAgentFlagProfile(),
        agentHealthy: getAgentCliHealthy(),
        botRunning: ctx.botRunning,
      },
    };
  } catch (e) {
    return { success: false, error: e?.message || String(e) };
  }
});

// Manually trigger a cron handler (for "Test ngay" button in Dashboard).
// CRITICAL: test fires MUST be byte-identical to scheduled cron fires so the
// customer's test preview matches what they'll receive in production. No
// "[TEST]" preambles, no "(tin test thủ công)" footers — reuse the exact same
// prompt builders.
ipcMain.handle('test-cron', async (_event, { type, id }) => {
  try {
    if (type === 'fixed') {
      const schedules = loadSchedules();
      const s = schedules.find(x => x.id === id);
      if (!s) return { success: false, error: 'Schedule not found' };
      if (id === 'morning') {
        const prompt = buildMorningBriefingPrompt(s.time);
        const ok = await runCronViaSessionOrFallback(prompt, { label: 'TEST — morning-briefing' });
        return { success: ok, sent: ok };
      } else if (id === 'evening') {
        const prompt = buildEveningSummaryPrompt(s.time);
        const ok = await runCronViaSessionOrFallback(prompt, { label: 'TEST — evening-summary' });
        return { success: ok, sent: ok };
      } else if (id === 'heartbeat') {
        const sent = await sendTelegram(`*Heartbeat*\n\nHệ thống đang hoạt động bình thường.`);
        return { success: sent === true, sent };
      } else if (id === 'meditation') {
        const prompt = buildMeditationPrompt();
        const ok = await runCronAgentPrompt(prompt, { label: 'TEST — meditation' });
        return { success: ok, sent: ok };
      } else if (id === 'weekly') {
        const prompt = await buildWeeklyReportPrompt();
        const ok = await runCronViaSessionOrFallback(prompt, { label: 'TEST — weekly-report' });
        return { success: ok, sent: ok };
      } else if (id === 'monthly') {
        const prompt = buildMonthlyReportPrompt();
        const ok = await runCronViaSessionOrFallback(prompt, { label: 'TEST — monthly-report' });
        return { success: ok, sent: ok };
      } else if (id === 'zalo-followup') {
        const ws = getWorkspace();
        const candidates = ws ? scanZaloFollowUpCandidates(ws) : [];
        const prompt = buildZaloFollowUpPrompt(candidates);
        const ok = await runCronAgentPrompt(prompt, { label: 'TEST — zalo-followup' });
        return { success: ok, sent: ok };
      } else if (id === 'memory-cleanup') {
        const prompt = buildMemoryCleanupPrompt();
        const ok = await runCronAgentPrompt(prompt, { label: 'TEST — memory-cleanup' });
        return { success: ok, sent: ok };
      }
      return { success: false, error: 'Unknown schedule id' };
    } else if (type === 'custom') {
      const customs = loadCustomCrons();
      const c = customs.find(x => x.id === id);
      if (!c) return { success: false, error: 'Custom cron not found' };
      if (!c.prompt) return { success: false, error: 'Cron không có prompt' };
      const ok = !c.prompt.startsWith('exec:')
        ? await runCronViaSessionOrFallback(c.prompt, { label: `TEST — ${c.label || c.id}` })
        : await runCronAgentPrompt(c.prompt, { label: `TEST — ${c.label || c.id}` });
      return { success: ok, sent: ok };
    }
    return { success: false, error: 'Unknown type' };
  } catch (e) { return { success: false, error: e.message }; }
});

// ============================================
//  CRON SCHEDULER (node-cron + Telegram Bot API)
// ============================================

// cron, cronJobs, setGetTelegramConfig, runCronViaSessionOrFallback — moved to lib/cron.js

// skipFilter: bypass output filter for system alerts (cron errors, boot pings)
// that are OUR messages, not AI-generated. Blocking these would cause silent failures.
// R1: strip Telegram Markdown v1 syntax tokens so plain-text send doesn't
// leak raw `*` / backtick / triple-backtick into CEO's alert output.
// sendCeoAlert call sites use `*bold*` + ``` code fences historically.
// NOTE: Output filter patterns, pause functions, and send functions moved to lib/channels.js
// _outputFilterPatterns, filterSensitiveOutput, _getPausePath, setChannelPermanentPause,
// clearChannelPermanentPause, isZaloChannelEnabled, setZaloChannelEnabled,
// isChannelPaused, pauseChannel, resumeChannel, getChannelPauseStatus,
// sendTelegram, sendTelegramPhoto, sendZalo — all now in lib/channels.js

// getAppointmentsPath, readAppointments, writeAppointments, newAppointmentId,
// mutateAppointments, vnHHMM, vnDDMM, vnHHMMNow, vnDateKeyNow,
// normalizeAppointment, substituteApptTemplate, defaultApptPushTemplate,
// buildApptReminderText, fireApptPushTarget, startAppointmentDispatcher,
// apptDispatcherTick, cleanupAppointmentTimers — all now in lib/appointments.js

// --- IPC: appointments CRUD ---
ipcMain.handle('list-appointments', async () => {
  return readAppointments();
});

ipcMain.handle('create-appointment', async (_e, data) => {
  try {
    const apt = normalizeAppointment(data || {});
    if (!apt) return { ok: false, error: 'Dữ liệu không hợp lệ' };
    if (!apt.title) return { ok: false, error: 'Thiếu tiêu đề' };
    if (!apt.start) return { ok: false, error: 'Thiếu thời gian bắt đầu' };
    const startMs = new Date(apt.start).getTime();
    if (!Number.isFinite(startMs)) return { ok: false, error: 'Thời gian không hợp lệ' };
    const result = await mutateAppointments(async (list) => { list.push(apt); return list; });
    if (!Array.isArray(result)) return { ok: false, error: 'Không ghi được file appointments.json' };
    try { auditLog('appt_created', { id: apt.id, title: apt.title, start: apt.start }); } catch {}
    return { ok: true, appointment: apt };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('update-appointment', async (_e, payload) => {
  try {
    const { id, patch } = payload || {};
    if (!id) return { ok: false, error: 'Thiếu id' };
    const result = await mutateAppointments(async (list) => {
      const idx = list.findIndex(a => a.id === id);
      if (idx < 0) return null;
      const oldApt = list[idx];
      const newStart = (patch && patch.start) || oldApt.start;
      const newEnd = (patch && patch.end) || oldApt.end;
      const timeChanged = newStart !== oldApt.start || newEnd !== oldApt.end;
      const merged = { ...oldApt, ...(patch || {}), id };
      if (timeChanged) {
        // Time changed — reset delivery state so reminder/push fire for new time.
        merged.reminderFiredAt = null;
        merged.pushedAt = {};
      }
      list[idx] = normalizeAppointment(merged);
      return list;
    });
    if (!Array.isArray(result)) return { ok: false, error: 'Không tìm thấy hoặc không ghi được lịch hẹn' };
    const updated = result.find(a => a.id === id);
    if (!updated) return { ok: false, error: 'Lịch hẹn đã bị xóa trước khi cập nhật' };
    return { ok: true, appointment: updated };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('delete-appointment', async (_e, payload) => {
  try {
    const id = payload?.id;
    if (!id) return { ok: false, error: 'Thiếu id' };
    const result = await mutateAppointments(async (list) => list.filter(a => a.id !== id));
    if (!Array.isArray(result)) return { ok: false, error: 'Không ghi được file' };
    try { auditLog('appt_deleted', { id }); } catch {}
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Bot + UI helper: resolve Zalo target by name from openzca cache.
// Returns fuzzy matches (accent-insensitive substring) so bot can confirm with CEO.
ipcMain.handle('resolve-zalo-target', async (_e, payload) => {
  try {
    const query = payload?.query;
    const type = payload?.type || 'any'; // 'group' | 'user' | 'any'
    // NFD decomposes most Vietnamese diacritics, but đ/Đ are atomic (U+0111/U+0110)
    // and don't decompose. Map them explicitly so "Đội bán hàng" matches "doi ban hang".
    const normalize = (s) => String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'd');
    const q = normalize(query);
    if (!q) return { matches: [] };
    const results = [];
    if (type === 'group' || type === 'any') {
      const pg = path.join(getZcaCacheDir(), 'groups.json');
      if (fs.existsSync(pg)) {
        try {
          const data = JSON.parse(fs.readFileSync(pg, 'utf-8'));
          for (const g of (Array.isArray(data) ? data : [])) {
            const name = g.name || g.groupName || '';
            if (normalize(name).includes(q)) {
              results.push({
                type: 'zalo_group',
                toId: String(g.groupId || g.id || ''),
                toName: name,
                memberCount: g.totalMember || g.memberCount || (g.memberIds?.length) || 0,
              });
            }
          }
        } catch {}
      }
    }
    if (type === 'user' || type === 'any') {
      const pf = path.join(getZcaCacheDir(), 'friends.json');
      if (fs.existsSync(pf)) {
        try {
          const data = JSON.parse(fs.readFileSync(pf, 'utf-8'));
          for (const u of (Array.isArray(data) ? data : [])) {
            const name = u.displayName || u.zaloName || u.name || '';
            if (normalize(name).includes(q)) {
              results.push({
                type: 'zalo_user',
                toId: String(u.userId || u.id || ''),
                toName: name,
              });
            }
          }
        } catch {}
      }
    }
    return { matches: results.slice(0, 10) };
  } catch (e) { return { matches: [], error: e.message }; }
});

ipcMain.handle('get-telegram-config', async () => {
  try {
    const configPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const tg = config.channels?.telegram || {};
    const token = tg.botToken || '';
    return {
      botToken: token ? token.slice(0, 6) + '…' + token.slice(-4) : '',
      botTokenSet: !!token,
      allowFrom: tg.allowFrom || [],
    };
  } catch { return { botToken: '', botTokenSet: false, allowFrom: [] }; }
});

ipcMain.handle('save-telegram-config', async (_e, { botToken, userId }) => {
  const booting = rejectIfBooting('save-telegram-config');
  if (booting) return booting;
  ctx.ipcInFlightCount++;
  try {
    return await withOpenClawConfigLock(async () => {
      try {
        const configPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (!config.channels) config.channels = {};
        if (!config.channels.telegram) config.channels.telegram = {};
        if (botToken !== undefined) config.channels.telegram.botToken = botToken;
        if (userId !== undefined) {
          const uid = parseInt(userId, 10);
          if (!isNaN(uid) && uid > 0) config.channels.telegram.allowFrom = [uid];
        }
        writeOpenClawConfigIfChanged(configPath, config);
        return { success: true };
      } catch (e) { return { success: false, error: String(e) }; }
    });
  } finally { ctx.ipcInFlightCount--; }
});

ipcMain.handle('check-telegram-ready', async () => probeTelegramReady());
ipcMain.handle('check-zalo-ready', async () => probeZaloReady());

// Manual smoke test: send a real Telegram message to the CEO. The strongest
// possible proof — if this succeeds the channel is end-to-end working.
ipcMain.handle('telegram-self-test', async () => {
  // Self-test bypasses pause + filter — CEO explicitly clicked "Gửi tin test"
  const ok = await sendTelegram(
    'Test kết nối\n\nĐây là tin nhắn test từ Dashboard. Nếu thấy tin này,' +
    'channel Telegram đã sẵn sàng nhận lệnh.',
    { skipFilter: true, skipPauseCheck: true }
  );
  return { success: ok === true };
});

// --- Telegram behavior settings (mirrors Zalo behavior pattern) ---
ipcMain.handle('get-telegram-behavior', async () => {
  try {
    const ws = getWorkspace();
    if (!ws) return { strangerPolicy: 'ignore', defaultGroupMode: 'mention', historyLimit: 50 };

    // Stranger policy — file-based like Zalo
    let strangerPolicy = 'ignore';
    try {
      const spPath = path.join(ws, 'telegram-stranger-policy.json');
      if (fs.existsSync(spPath)) {
        const sp = JSON.parse(fs.readFileSync(spPath, 'utf-8'));
        if (['reply', 'greet-only', 'ignore'].includes(sp.policy)) strangerPolicy = sp.policy;
      }
    } catch {}

    // Default group mode — file-based
    let defaultGroupMode = 'mention';
    try {
      const gmPath = path.join(ws, 'telegram-group-defaults.json');
      if (fs.existsSync(gmPath)) {
        const gm = JSON.parse(fs.readFileSync(gmPath, 'utf-8'));
        if (['mention', 'all', 'off'].includes(gm.mode)) defaultGroupMode = gm.mode;
      }
    } catch {}

    // History limit — from openclaw.json
    let historyLimit = 50;
    try {
      const configPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
      if (fs.existsSync(configPath)) {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        historyLimit = cfg?.channels?.telegram?.historyLimit || 50;
      }
    } catch {}

    return { strangerPolicy, defaultGroupMode, historyLimit };
  } catch (e) {
    console.error('[get-telegram-behavior] error:', e.message);
    return { strangerPolicy: 'ignore', defaultGroupMode: 'mention', historyLimit: 50 };
  }
});

ipcMain.handle('save-telegram-behavior', async (_event, behavior) => {
  const booting = rejectIfBooting('save-telegram-behavior');
  if (booting) return booting;
  ctx.ipcInFlightCount++;
  try {
    const ws = getWorkspace();
    if (!ws) return { success: false, error: 'No workspace' };
    const { strangerPolicy, defaultGroupMode, historyLimit } = behavior || {};

    // Save stranger policy
    if (strangerPolicy && ['reply', 'greet-only', 'ignore'].includes(strangerPolicy)) {
      writeJsonAtomic(path.join(ws, 'telegram-stranger-policy.json'), {
        policy: strangerPolicy,
        updatedAt: new Date().toISOString(),
      });
    }

    // Save default group mode
    if (defaultGroupMode && ['mention', 'all', 'off'].includes(defaultGroupMode)) {
      writeJsonAtomic(path.join(ws, 'telegram-group-defaults.json'), {
        mode: defaultGroupMode,
        updatedAt: new Date().toISOString(),
      });
    }

    // Save history limit to openclaw.json
    if (historyLimit) {
      const limit = Math.min(Math.max(parseInt(historyLimit, 10) || 50, 5), 50);
      try {
        await withOpenClawConfigLock(async () => {
          const configPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
          if (fs.existsSync(configPath)) {
            const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            if (!cfg.channels) cfg.channels = {};
            if (!cfg.channels.telegram) cfg.channels.telegram = {};
            cfg.channels.telegram.historyLimit = limit;
            writeOpenClawConfigIfChanged(configPath, cfg);
          }
        });
      } catch (e) {
        console.warn('[save-telegram-behavior] historyLimit write error:', e.message);
      }
    }

    try { auditLog('telegram-behavior-changed', { strangerPolicy, defaultGroupMode, historyLimit }); } catch {}
    console.log('[save-telegram-behavior] saved:', { strangerPolicy, defaultGroupMode, historyLimit });
    return { success: true };
  } catch (e) {
    console.error('[save-telegram-behavior] error:', e.message);
    return { success: false, error: e.message };
  } finally { ctx.ipcInFlightCount--; }
});

// --- Channel pause/resume (symmetric for both Telegram + Zalo) ---
ipcMain.handle('pause-telegram', async (_e, { minutes } = {}) => {
  return { success: pauseChannel('telegram', minutes || 30) };
});
ipcMain.handle('resume-telegram', async () => {
  return { success: resumeChannel('telegram') };
});
ipcMain.handle('get-telegram-pause-status', async () => {
  return getChannelPauseStatus('telegram');
});
ipcMain.handle('pause-zalo', async (_e, { minutes } = {}) => {
  return { success: pauseChannel('zalo', minutes || 30) };
});
ipcMain.handle('resume-zalo', async () => {
  const booting = rejectIfBooting('resume-zalo');
  if (booting) return booting;
  ctx.ipcInFlightCount++;
  try {
    return await withOpenClawConfigLock(async () => {
      console.log('[config-lock] resume-zalo acquired');
      // [zalo-watchdog rearm] CEO's manual Resume rearms the listener watchdog.
      // Without this, once _zaloListenerGaveUp flipped true (3 restarts in 2h),
      // it stuck until app restart — CEO fixing the root cause + pressing
      // Resume wouldn't re-enable auto-restart. Reset all 3 counters.
      global._zaloListenerGaveUp = false;
      global._zaloListenerRestartHistory = [];
      global._zaloListenerMissStreak = 0;
      console.log('[zalo-watchdog] reset gave-up / streak by CEO action');
      // Detect if enabled was previously false — transitioning false→true needs
      // a hard gateway restart so openclaw loads the modoro-zalo plugin + spawns
      // openzca listener (both skipped at boot when enabled=false).
      let wasDisabled = false;
      try {
        const cfgPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
        if (fs.existsSync(cfgPath)) {
          const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
          wasDisabled = (cfg?.channels?.['modoro-zalo'] || cfg?.channels?.openzalo)?.enabled === false;
        }
      } catch {}
      const resumed = resumeChannel('zalo');
      // Inline config write — do NOT call setZaloChannelEnabled() here because
      // it acquires withOpenClawConfigLock internally, and we already hold it.
      let enabled = false;
      try {
        const cfgPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
        if (fs.existsSync(cfgPath)) {
          const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
          if (!cfg.channels) cfg.channels = {};
          if (!cfg.channels['modoro-zalo'] || typeof cfg.channels['modoro-zalo'] !== 'object') {
            cfg.channels['modoro-zalo'] = {};
          }
          cfg.channels['modoro-zalo'].enabled = true;
          if (!cfg.plugins) cfg.plugins = {};
          if (!cfg.plugins.entries) cfg.plugins.entries = {};
          if (!cfg.plugins.entries['modoro-zalo'] || typeof cfg.plugins.entries['modoro-zalo'] !== 'object') {
            cfg.plugins.entries['modoro-zalo'] = {};
          }
          cfg.plugins.entries['modoro-zalo'].enabled = true;
          writeOpenClawConfigIfChanged(cfgPath, cfg);
          enabled = true;
        }
      } catch (e) { console.error('[resume-zalo] inline config write error:', e.message); }
      const cleared = clearChannelPermanentPause('zalo');
      if (enabled && cleared) markOnboardingComplete('resume-zalo');
      // [restart-guard A1] Flipping enabled/permanent-pause doesn't reach the running
      // gateway (config is read at boot). Kick off a hard-restart in the
      // background so Zalo actually comes back. Only restart if disabled→enabled
      // transition (HEAD's smart check) AND not in-flight already (A1 guard).
      if (wasDisabled) {
        // Defer restart if gateway spawn is already in progress (wizard just
        // finished, boot path still spawning). Killing mid-spawn causes 240s
        // WS timeout → null.stdout crash → gateway dead permanently.
        if (ctx.startOpenClawInFlight) {
          console.log('[resume-zalo] gateway spawn in progress — skip restart, config change will apply on its own');
        } else if (ctx.gatewayRestartInFlight) {
          console.log('[restart-guard] resume-zalo: restart already in-flight — skipping duplicate');
        } else {
          ctx.gatewayRestartInFlight = true;
          console.log('[resume-zalo] transitioning disabled→enabled — hard-restart gateway (bg)');
          (async () => {
            try {
              console.log('[restart-guard] resume-zalo: hard-restart begin');
              try { await stopOpenClaw(); } catch (e1) { console.warn('[resume-zalo] stop failed:', e1?.message); }
              await new Promise(r => setTimeout(r, 5000));
              try { await startOpenClaw({ ignoreCooldown: true }); } catch (e2) { console.warn('[resume-zalo] start failed:', e2?.message); }
              // [zalo-watchdog rearm] Post-restart: wipe any pre-restart miss
              // streak so next heartbeat miss doesn't immediately re-trip cap.
              global._zaloListenerMissStreak = 0;
              console.log('[restart-guard] resume-zalo: hard-restart end');
            } finally {
              ctx.gatewayRestartInFlight = false;
            }
          })();
        }
      }
      return { success: resumed && enabled && cleared };
    });
  } finally { ctx.ipcInFlightCount--; }
});
ipcMain.handle('get-zalo-pause-status', async () => {
  return getChannelPauseStatus('zalo');
});

// Inbound debounce — how long bot waits to coalesce rapid messages from
// same customer into 1 turn. Openclaw has one global setting; we expose
// it via 2 sliders (Telegram + Zalo pages) that share the same backend
// so CEO can adjust from either page. Default 3000ms; 0 = no coalesce.
ipcMain.handle('get-inbound-debounce', async () => {
  try {
    const cfgPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
    if (!fs.existsSync(cfgPath)) return { telegram: 3000, zalo: 3000 };
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    const tgMs = cfg?.channels?.telegram?.messages?.inbound?.debounceMs;
    const zlMs = (cfg?.channels?.['modoro-zalo'] || cfg?.channels?.openzalo)?.messages?.inbound?.debounceMs;
    const globalMs = cfg?.messages?.inbound?.debounceMs ?? 3000;
    return {
      telegram: typeof tgMs === 'number' ? tgMs : globalMs,
      zalo: typeof zlMs === 'number' ? zlMs : globalMs,
    };
  } catch { return { telegram: 3000, zalo: 3000 }; }
});
ipcMain.handle('set-inbound-debounce', async (_e, { channel, ms } = {}) => {
  const booting = rejectIfBooting('set-inbound-debounce');
  if (booting) return booting;
  ctx.ipcInFlightCount++;
  try {
    if (!['telegram', 'zalo'].includes(channel)) return { success: false, error: 'channel must be telegram or zalo' };
    const clampedMs = Math.max(0, Math.min(10000, Number(ms) || 0));
    return await withOpenClawConfigLock(async () => {
      const cfgPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
      if (!fs.existsSync(cfgPath)) return { success: false, error: 'config not found' };
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      if (!cfg.channels) cfg.channels = {};
      const chanKey = channel === 'zalo' ? 'modoro-zalo' : 'telegram';
      if (!cfg.channels[chanKey]) cfg.channels[chanKey] = {};
      if (!cfg.channels[chanKey].messages) cfg.channels[chanKey].messages = {};
      if (!cfg.channels[chanKey].messages.inbound) cfg.channels[chanKey].messages.inbound = {};
      cfg.channels[chanKey].messages.inbound.debounceMs = clampedMs;
      const otherKey = chanKey === 'telegram' ? 'modoro-zalo' : 'telegram';
      const otherMs = cfg.channels?.[otherKey]?.messages?.inbound?.debounceMs;
      if (!cfg.messages) cfg.messages = {};
      if (!cfg.messages.inbound) cfg.messages.inbound = {};
      cfg.messages.inbound.debounceMs = typeof otherMs === 'number'
        ? Math.min(clampedMs, otherMs) : clampedMs;
      writeOpenClawConfigIfChanged(cfgPath, cfg);

      try {
        const cliJs = (typeof findOpenClawCliJs === 'function') ? findOpenClawCliJs() : null;
        const nodeBin = (typeof findNodeBin === 'function') ? findNodeBin() : null;
        if (cliJs && nodeBin) {
          const probe = require('child_process').spawnSync(nodeBin, [cliJs, '--help'], {
            timeout: 4000, encoding: 'utf-8', shell: false
          });
          const stderr = String(probe.stderr || '') + String(probe.stdout || '');
          if (probe.status !== 0 && /Config invalid|Unrecognized key/i.test(stderr)) {
            try { healOpenClawConfigInline(stderr); } catch {}
            const cfg2 = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
            if (cfg2?.channels?.[chanKey]?.messages?.inbound) {
              delete cfg2.channels[chanKey].messages.inbound.debounceMs;
              if (!cfg2.messages) cfg2.messages = {};
              if (!cfg2.messages.inbound) cfg2.messages.inbound = {};
              cfg2.messages.inbound.debounceMs = clampedMs;
              writeOpenClawConfigIfChanged(cfgPath, cfg2);
            }
            return { success: true, ms: clampedMs, scope: 'global-fallback' };
          }
        }
      } catch { /* non-fatal probe failure */ }

      return { success: true, ms: clampedMs };
    });
  } catch (e) {
    return { success: false, error: e?.message };
  } finally { ctx.ipcInFlightCount--; }
});

// App prefs (start minimized, etc.) — persisted in <userData>/app-prefs.json
ipcMain.handle('get-app-prefs', async () => {
  return loadAppPrefs();
});
ipcMain.handle('set-app-prefs', async (_e, partial) => {
  const next = saveAppPrefs(partial || {});
  return next || loadAppPrefs();
});

// ─── Brand Assets IPC ────────────────────────────────────────────
ipcMain.handle('list-brand-assets', async () => {
  try {
    mediaLibrary.backfillLegacyBrandAssets();
    return mediaLibrary.listMediaAssets({ type: 'brand' }).map(asset => {
      const filePath = asset.path;
      if (!filePath || !fs.existsSync(filePath)) return null;
      const stat = fs.statSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      let thumbDataUrl = '';
      try {
        if (stat.size < 10 * 1024 * 1024) {
          const buf = fs.readFileSync(filePath);
          thumbDataUrl = `data:${mime};base64,${buf.toString('base64')}`;
        }
      } catch {}
      return { id: asset.id, name: asset.filename, title: asset.title, size: stat.size, thumbDataUrl };
    }).filter(Boolean);
  } catch { return []; }
});

ipcMain.handle('upload-brand-asset', async (_event, filePath, name) => {
  try {
    const dir = getBrandAssetsDir();
    fs.mkdirSync(dir, { recursive: true });
    const safeName = String(name || path.basename(filePath)).replace(/[\\/:*?"<>|]/g, '_');
    if (!isPathSafe(dir, safeName)) return { success: false, error: 'invalid filename' };
    const ext = path.extname(safeName).toLowerCase();
    if (!BRAND_ASSET_FORMATS.includes(ext)) return { success: false, error: 'only png/jpg/webp allowed' };
    const buf = fs.readFileSync(filePath);
    if (buf.length > BRAND_ASSET_MAX_SIZE) return { success: false, error: 'file too large (max 10MB)' };
    const dst = path.join(dir, safeName);
    fs.writeFileSync(dst, buf);
    try {
      mediaLibrary.registerExistingMediaFile(dst, {
        type: 'brand',
        visibility: 'internal',
        source: 'dashboard-brand-upload',
        status: 'indexed',
      });
    } catch (e) { console.warn('[media] brand upload register failed:', e.message); }
    return { success: true, name: safeName };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('delete-brand-asset', async (_event, name) => {
  try {
    const dir = getBrandAssetsDir();
    const asset = mediaLibrary.findMediaAsset(name);
    if (asset) return mediaLibrary.deleteMediaAsset(asset.id);
    if (!isPathSafe(dir, name)) return { success: false };
    const fp = path.resolve(dir, name);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    return { success: true };
  } catch { return { success: false }; }
});

ipcMain.handle('pick-brand-asset-file', async () => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog({
    title: 'Chọn ảnh tài sản thương hiệu',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    properties: ['openFile', 'multiSelections']
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('list-media-assets', async (_event, filters = {}) => {
  try {
    mediaLibrary.backfillLegacyBrandAssets();
    return mediaLibrary.listMediaAssets(filters || {});
  } catch { return []; }
});

ipcMain.handle('upload-media-asset', async (_event, { filePath, type = 'product', title = '', tags = '', visibility } = {}) => {
  try {
    const asset = mediaLibrary.importMediaFile(filePath, { type, title, tags, visibility });
    if (!asset.description) {
      mediaLibrary.describeMediaAsset(asset.id).catch(e => {
        console.warn('[media] async describe failed:', e.message);
      });
    }
    return { success: true, asset };
  } catch (e) { return { success: false, error: mediaLibrary.localizeMediaError(e) }; }
});

ipcMain.handle('describe-media-asset', async (_event, id) => {
  try {
    const asset = await mediaLibrary.describeMediaAsset(id);
    return { success: true, asset };
  } catch (e) { return { success: false, error: mediaLibrary.localizeMediaError(e) }; }
});

ipcMain.handle('delete-media-asset', async (_event, id) => {
  try { return mediaLibrary.deleteMediaAsset(id); }
  catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('pick-media-asset-file', async () => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog({
    title: 'Chọn ảnh tài sản hình ảnh',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
    properties: ['openFile', 'multiSelections']
  });
  return result.canceled ? [] : result.filePaths;
});

// ─── Facebook IPC ────────────────────────────────────────────────
ipcMain.handle('get-fb-config', async () => {
  const cfg = readFbConfig();
  if (!cfg) return null;
  return { pageId: cfg.pageId, pageName: cfg.pageName, connectedAt: cfg.connectedAt };
});

ipcMain.handle('save-fb-config', async (_event, { accessToken }) => {
  try {
    const fbPub = require('./fb-publisher');
    const result = await fbPub.verifyToken(accessToken);
    if (!result.valid) return { success: false, error: result.error };
    const cfg = {
      pageId: result.pageId,
      pageName: result.pageName,
      accessToken: result.pageToken || accessToken,
      connectedAt: new Date().toISOString()
    };
    writeFbConfig(cfg);
    return { success: true, pageId: cfg.pageId, pageName: cfg.pageName };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('verify-fb-token', async () => {
  const cfg = readFbConfig();
  if (!cfg || !cfg.accessToken) return { valid: false, error: 'Chưa kết nối Facebook' };
  const fbPub = require('./fb-publisher');
  const result = await fbPub.verifyToken(cfg.accessToken);
  const { pageToken, ...safe } = result;
  return safe;
});

ipcMain.handle('get-fb-recent-posts', async () => {
  const cfg = readFbConfig();
  if (!cfg || !cfg.accessToken) return [];
  try {
    const fbPub = require('./fb-publisher');
    return await fbPub.getRecentPosts(cfg.pageId, cfg.accessToken, 5);
  } catch { return []; }
});


// -> fastWatchdog, triggerGatewayMessage extracted to lib/gateway.js

// ============================================================================
// handleTimCommand, handleThongkeCommand, handleBaocaoCommand, handleTelegramBuiltinCommand — moved to lib/cron.js
// healCustomCronEntries, loadCustomCrons, customCronWatcher/state, watchCustomCrons — moved to lib/cron.js
// ─── Local Cron API (port 20200) — moved to lib/cron-api.js ────────────────
// startCronApi, getCronApiToken, getCronApiPort, cleanupCronApi imported above.
// _cronApiServer, _cronApiPort, _cronApiToken are module-level state in cron-api.js.
// Legacy marker (do not remove — used by grep/audit tooling):
// function startCronApi() {

// IPC: bot or dashboard can queue a follow-up.
// Race safety: processFollowUpQueue holds _followUpQueueLock for the entire async duration
// (up to 600s while runCronAgentPrompt executes). A 150ms yield was insufficient.
// Instead, processFollowUpQueue re-reads the queue file before its final write (see above),
// so any IPC-written entries that arrived during the long await are merged back in.
// The IPC handler itself simply writes immediately — it only appends, never overwrites.
ipcMain.handle('queue-follow-up', async (_event, { channel, recipientId, recipientName, question, prompt, delayMinutes }) => {
  try {
    const id = 'fu_' + Date.now();
    const fireAt = new Date(Date.now() + (delayMinutes || 15) * 60 * 1000).toISOString();
    await queueFollowUpSafe({ id, channel: channel || 'zalo', recipientId, recipientName, question, prompt, fireAt });
    console.log('[follow-up] Queued:', id, 'fire at', fireAt);
    return { success: true, id, fireAt };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// _startCronJobsInFlight, startCronJobs, _startCronJobsInner, _customCronWriteChain, _withCustomCronLock, _removeCustomCronById, surfaceCronConfigError, stopCronJobs, restartCronJobs — moved to lib/cron.js
// ============================================
//  DOCUMENT LIBRARY (Telegram file → FTS5 index)
// ============================================

ipcMain.handle('upload-knowledge-file', async (_event, { category, filepath, originalName, visibility = 'public' }) => {
  if (!['public', 'internal', 'private'].includes(visibility)) {
    return { success: false, error: 'Chế độ hiển thị không hợp lệ. Vui lòng chọn Công khai, Nội bộ hoặc Chỉ CEO.' };
  }
  try {
    if (!KNOWLEDGE_CATEGORIES.includes(category)) {
      return { success: false, error: 'Loại không hợp lệ' };
    }
    if (!fs.existsSync(filepath)) return { success: false, error: 'File không tồn tại' };
    const stat = fs.statSync(filepath);
    // 100MB cap: CEO brochures/catalogs/handbooks routinely 20-80MB. pdf-parse 1.1.1 loads full buffer in memory,
    // but 100MB peak is fine on 8GB-RAM laptop (parsed briefly, GC'd after). summarizeKnowledgeContent slices
    // content before LLM + DB row, so steady-state memory footprint remains small.
    if (stat.size > 100 * 1024 * 1024) return { success: false, error: 'File quá lớn (tối đa 100MB). Vui lòng tách PDF thành nhiều phần nhỏ hơn.' };

    ensureKnowledgeFolders();
    const filesDir = path.join(getKnowledgeDir(category), 'files');
    const safeName = (originalName || path.basename(filepath)).replace(/[\\/:*?"<>|]/g, '_');
    const finalName = resolveUniqueFilename(filesDir, safeName);
    const dst = path.join(filesDir, finalName);
    fs.copyFileSync(filepath, dst);

    const content = await extractTextFromFile(dst, finalName, { visibility, category });
    if (content && /^\[(PDF|DOCX|Excel) extract failed: /.test(content)) {
      try { fs.unlinkSync(dst); } catch {}
      const errMsg = content.replace(/^\[/, '').replace(/\]$/, '');
      const prettyErr = errMsg.replace(/^(PDF|DOCX|Excel) extract failed:\s*/i, '').trim();
      return {
        success: false,
        error: `Không đọc được file "${finalName}": ${prettyErr}. Vui lòng kiểm tra 9Router/model vision hoặc thử export lại PDF rồi upload lại.`,
      };
    }
    // R3-F7: reject mostly-binary / OCR-garbage content. Scanned receipts
    // extracted by pdf-parse often return strings like "¶▶Ω≈∑ I p h O N e"
    // — embedding that pollutes the vector corpus. Require ≥30% printable
    // ASCII chars (digits/letters/punct/space) OR Vietnamese letter chars.
    // Skip for images — vision descriptions are always clean text.
    const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(path.extname(finalName).toLowerCase());
    if (content && content.length > 50 && !isImage) {
      // R4-F1: tighten OCR-garbage regex. Previous range \u00C0-\u1EF9 covers
      // ~8000 chars incl. Greek/Cyrillic/Arabic/Armenian/Hebrew — an Arabic
      // product catalog would pass the 30% gate. Narrow to Latin + Latin
      // Extended-A/B + Latin Extended Additional (VN range = \u1E00-\u1EFF).
      const printable = (content.match(/[\x20-\x7E\u00C0-\u024F\u1E00-\u1EFF]/g) || []).length;
      const ratio = printable / content.length;
      if (ratio < 0.30) {
        try { fs.unlinkSync(dst); } catch {}
        return {
          success: false,
          error: `File có vẻ là scan/ảnh chưa OCR (chỉ ${Math.round(ratio * 100)}% ký tự đọc được). Vui lòng OCR trước khi upload.`,
        };
      }
    }
    const wordCount = content ? content.split(/\s+/).length : 0;
    const filetype = path.extname(finalName).toLowerCase().replace('.', '');
    const summary = await summarizeKnowledgeContent(content, finalName);
    const isKnowledgeImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(filetype);
    let mediaAsset = null;
    if (isKnowledgeImage) {
      try {
        mediaAsset = mediaLibrary.registerExistingMediaFile(dst, {
          type: 'knowledge_image',
          visibility,
          title: path.basename(finalName, path.extname(finalName)),
          description: content || '',
          source: 'knowledge-upload',
          status: content ? 'ready' : 'needs_vision',
          metadata: {
            knowledgeCategory: category,
            knowledgeFilename: finalName,
            knowledgeFilepath: dst,
          },
        });
      } catch (e) {
        console.warn('[knowledge] media register failed:', e.message);
      }
    }

    let dbWarning = null;
    const db = getDocumentsDb();
    if (db) {
      let insertedDocId = null;
      try {
        const insertBoth = db.transaction(() => {
          const info = insertDocumentRow(db, {
            filename: finalName, filepath: dst, content,
            filetype, filesize: stat.size, wordCount,
            category, summary, visibility
          });
          insertedDocId = Number(info.lastInsertRowid);
          db.prepare('INSERT INTO documents_fts (filename, content) VALUES (?, ?)').run(finalName, content);
        });
        insertBoth();
        if (mediaAsset && insertedDocId) {
          try {
            mediaAsset = mediaLibrary.updateMediaAsset(mediaAsset.id, {
              metadata: {
                ...(mediaAsset.metadata || {}),
                documentId: insertedDocId,
              },
            });
          } catch (e) { console.warn('[knowledge] media document link failed:', e.message); }
        }
      } catch (e) {
        console.error('[knowledge] db insert error:', e.message);
        dbWarning = 'DB insert failed (file vẫn lưu trên disk): ' + e.message;
      }
      // K1: chunk + index for Vietnamese FTS5 search. Non-fatal if it fails —
      // the full document is still in documents_fts, just not snippet-retrievable.
      if (insertedDocId && content) {
        try {
          const res = indexDocumentChunks(db, insertedDocId, category, content);
          if (res && res.chunks > 0) {
            console.log(`[knowledge] indexed ${res.chunks} chunks for ${finalName}`);
          }
        } catch (e) { console.error('[knowledge] chunk index error:', e.message); }

        // RAG: embed every chunk for vector search (Tier 1). ~13ms/chunk sync —
        // for a 200-chunk doc (~100-page PDF) adds ~3s to upload. Non-fatal:
        // upload still succeeds on failure; boot-time backfill catches missed
        // rows. Skip rows with too-short text (noise, boilerplate).
        try {
          const chunkRows = db.prepare(
            'SELECT id, chunk_index, char_start, char_end FROM documents_chunks WHERE document_id = ? ORDER BY chunk_index'
          ).all(insertedDocId);
          const upsert = db.prepare(
            'UPDATE documents_chunks SET embedding = ?, embedding_model = ? WHERE id = ?'
          );
          const MODEL_STAMP = 'multilingual-e5-small-q';
          let embedded = 0;
          for (const row of chunkRows) {
            const chunkText = content.substring(row.char_start, row.char_end);
            if (!chunkText || chunkText.length < 50) continue;
            const vec = await embedText(chunkText, false);
            upsert.run(vecToBlob(vec), MODEL_STAMP, row.id);
            embedded++;
          }
          console.log(`[knowledge] embedded ${embedded}/${chunkRows.length} chunks for ${finalName}`);
        } catch (e) {
          console.error('[knowledge] embed error:', e.message);
          // Non-fatal — upload still succeeds. Backfill on boot catches missed rows.
        }
      }
      try { db.close(); } catch {}
    } else {
      dbWarning = 'DB không mở được — file đã lưu trên disk, sẽ index lại sau khi sửa DB.';
    }

    rewriteKnowledgeIndex(category);
    purgeAgentSessions('knowledge-upload');
    return { success: true, filename: finalName, summary, wordCount, dbWarning, mediaAsset };
  } catch (e) {
    console.error('[knowledge] upload error:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('set-knowledge-visibility', async (_event, { docId, visibility }) => {
  try {
    if (!Number.isInteger(docId) || docId <= 0) {
      return { success: false, error: 'Invalid docId' };
    }
    if (!['public', 'internal', 'private'].includes(visibility)) {
      return { success: false, error: 'Invalid visibility value' };
    }
    const db = getDocumentsDb();
    if (!db) return { success: false, error: 'DB unavailable' };
    let info, category, filename, filepath;
    try {
      const row = db.prepare('SELECT category, filename, filepath FROM documents WHERE id=?').get(docId);
      category = row?.category;
      filename = row?.filename;
      filepath = row?.filepath;
      info = db.prepare('UPDATE documents SET visibility=? WHERE id=?').run(visibility, docId);
    } finally {
      try { db.close(); } catch {}
    }
    if (!info || info.changes === 0) return { success: false, error: 'Document not found' };
    try { auditLog('visibility-change', { docId, visibility, ts: Date.now() }); } catch {}
    let indexWarning;
    if (category) {
      try { rewriteKnowledgeIndex(category); } catch (e) { indexWarning = e.message; }
      purgeAgentSessions('knowledge-visibility');
    }
    try {
      mediaLibrary.updateKnowledgeMediaAssets({ docId, filename, filepath }, { visibility });
    } catch (e) {
      indexWarning = indexWarning || e.message;
    }
    return { success: true, indexWarning };
  } catch (e) {
    console.error('[set-knowledge-visibility] error:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('list-knowledge-files', async (_event, { category }) => {
  try {
    if (!KNOWLEDGE_CATEGORIES.includes(category)) return [];
    const diskRows = listKnowledgeFilesFromDisk(category);
    const db = getDocumentsDb();
    if (!db) {
      // DB unavailable (typically better-sqlite3 ABI mismatch). Return what's
      // actually on disk so the CEO never sees a blank Knowledge tab.
      return diskRows;
    }
    let dbRows = [];
    try {
      dbRows = db.prepare(
        'SELECT id, filename, filetype, filesize, word_count, summary, visibility, created_at FROM documents WHERE category = ? ORDER BY created_at DESC'
      ).all(category);
    } catch (e) {
      console.error('[knowledge] db query error:', e.message);
    }
    try { db.close(); } catch {}
    // Merge: prefer DB row (has summary) but include disk-only files (uploaded
    // while DB was broken).
    const dbNames = new Set(dbRows.map(r => r.filename));
    const diskOnly = diskRows.filter(r => !dbNames.has(r.filename));
    return [...dbRows, ...diskOnly];
  } catch (e) {
    console.error('[knowledge] list error:', e.message);
    // Last-ditch: still try disk-only.
    try { return listKnowledgeFilesFromDisk(category); } catch { return []; }
  }
});

ipcMain.handle('delete-knowledge-file', async (_event, { category, filename }) => {
  try {
    if (!KNOWLEDGE_CATEGORIES.includes(category)) return { success: false };
    if (!filename || typeof filename !== 'string' || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return { success: false, error: 'invalid filename' };
    }
    const db = getDocumentsDb();
    let docId = null;
    let storedFilepath = null;
    if (db) {
      try {
        const row = db.prepare('SELECT id, filepath FROM documents WHERE category = ? AND filename = ?').get(category, filename);
        docId = row?.id || null;
        storedFilepath = row?.filepath || null;
        const deleteAll = db.transaction(() => {
          if (row) {
            db.prepare('DELETE FROM documents_chunks WHERE document_id = ?').run(row.id);
          }
          db.prepare('DELETE FROM documents WHERE category = ? AND filename = ?').run(category, filename);
          db.prepare('DELETE FROM documents_fts WHERE filename = ?').run(filename);
        });
        deleteAll();
      } finally {
        try { db.close(); } catch {}
      }
    }
    const fp = path.join(getKnowledgeDir(category), 'files', filename);
    try {
      mediaLibrary.deleteKnowledgeMediaAssets({ docId, filename, filepath: storedFilepath || fp }, { keepPath: fp });
    } catch (e) { console.warn('[knowledge] media cleanup failed:', e.message); }
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    rewriteKnowledgeIndex(category);
    purgeAgentSessions('knowledge-delete');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('get-knowledge-counts', async () => {
  try {
    const cats = getKnowledgeCategories();
    const db = getDocumentsDb();
    const counts = {};
    for (const cat of cats) counts[cat] = 0;
    if (!db) {
      for (const cat of cats) counts[cat] = listKnowledgeFilesFromDisk(cat).length;
      return counts;
    }
    try {
      for (const cat of cats) {
        let n = 0;
        try { n = db.prepare('SELECT COUNT(*) as n FROM documents WHERE category = ?').get(cat)?.n || 0; } catch {}
        const diskFiles = listKnowledgeFilesFromDisk(cat);
        const dbNames = new Set();
        try {
          for (const r of db.prepare('SELECT filename FROM documents WHERE category = ?').all(cat)) dbNames.add(r.filename);
        } catch {}
        const diskExtra = diskFiles.filter(f => !dbNames.has(f.filename)).length;
        counts[cat] = n + diskExtra;
      }
      return counts;
    } finally {
      try { db.close(); } catch {}
    }
  } catch {
    const counts = {};
    for (const cat of getKnowledgeCategories()) counts[cat] = 0;
    return counts;
  }
});

// === FIRST-TIME CHANNEL GUIDE IPC ===

ipcMain.handle('check-guide-needed', async (_e, { channel }) => {
  const ws = getWorkspace();
  if (!ws) return { needed: false };
  const guideFile = path.join(ws, 'guide-completed.json');
  try {
    if (fs.existsSync(guideFile)) {
      const data = JSON.parse(fs.readFileSync(guideFile, 'utf-8'));
      if (data && data[channel]) return { needed: false };
    }
  } catch {}
  return { needed: true };
});

ipcMain.handle('mark-guide-complete', async (_e, { channel }) => {
  const ws = getWorkspace();
  if (!ws) return { ok: false, error: 'workspace not ready' };
  const guideFile = path.join(ws, 'guide-completed.json');
  try {
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(guideFile, 'utf-8')); } catch {}
    existing[channel] = true;
    existing.completedAt = existing.completedAt || new Date().toISOString();
    writeJsonAtomic(guideFile, existing);
    return { ok: true };
  } catch (e) {
    console.error('[mark-guide-complete] write failed:', e?.message);
    return { ok: false, error: e?.message || 'write failed' };
  }
});

// List all knowledge folders with labels
ipcMain.handle('list-knowledge-folders', async () => {
  const cats = getKnowledgeCategories();
  return cats.map(cat => ({
    id: cat,
    label: KNOWLEDGE_LABELS[cat] || cat.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    isDefault: DEFAULT_KNOWLEDGE_CATEGORIES.includes(cat),
  }));
});

ipcMain.handle('knowledge-search', async (_event, payload) => {
  const { query, category, limit } = payload || {};
  try {
    const results = await searchKnowledge({ query, category, limit, audience: 'ceo' });
    return { success: true, results };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
});

// RAG config — read/write rag-config.json in workspace root
ipcMain.handle('get-rag-config', async () => getRagConfig());
ipcMain.handle('set-rag-config', async (_event, cfg) => {
  try {
    const p = path.join(getWorkspace(), 'rag-config.json');
    // Whitelist rewriteModel to known 9Router slots. Prevents devtools/buggy-UI
    // from persisting invalid model IDs that would silently fail tier2 calls.
    const ALLOWED_MODELS = ['ninerouter/main', 'ninerouter/fast'];
    const requested = String((cfg && cfg.rewriteModel) || 'ninerouter/fast');
    const rewriteModel = ALLOWED_MODELS.includes(requested) ? requested : 'ninerouter/fast';
    writeJsonAtomic(p, {
      tier2Enabled: !!(cfg && cfg.tier2Enabled),
      rewriteModel,
      updatedAt: new Date().toISOString(),
    });
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

// Create custom knowledge folder
ipcMain.handle('create-knowledge-folder', async (_event, { name }) => {
  try {
    // Sanitize: lowercase, replace spaces with dash, remove non-alphanumeric
    const id = String(name).toLowerCase().trim()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip diacritics
      .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    if (!id || id.length < 2) return { success: false, error: 'Tên thư mục quá ngắn' };
    if (id.length > 30) return { success: false, error: 'Tên thư mục quá dài (tối đa 30 ký tự)' };
    const dir = path.join(getWorkspace(), 'knowledge', id, 'files');
    fs.mkdirSync(dir, { recursive: true });
    const label = String(name).trim();
    KNOWLEDGE_LABELS[id] = label;
    const indexFile = path.join(getWorkspace(), 'knowledge', id, 'index.md');
    if (!fs.existsSync(indexFile)) {
      fs.writeFileSync(indexFile, `# Knowledge — ${label}\n\n*Chưa có tài liệu nào.*\n`, 'utf-8');
    }
    return { success: true, id, label };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Delete custom knowledge folder (only non-default)
ipcMain.handle('delete-knowledge-folder', async (_event, { id }) => {
  try {
    if (!/^[a-z0-9-]+$/.test(id)) return { success: false, error: 'Invalid folder name' };
    if (DEFAULT_KNOWLEDGE_CATEGORIES.includes(id)) return { success: false, error: 'Không thể xóa thư mục mặc định' };
    const dir = path.join(getWorkspace(), 'knowledge', id);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    // Clean DB entries
    try {
      const db = getDocumentsDb();
      if (db) { db.prepare('DELETE FROM documents WHERE category = ?').run(id); db.close(); }
    } catch {}
    purgeAgentSessions('knowledge-folder-delete');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// File picker (Electron native dialog) — for upload UI
ipcMain.handle('pick-knowledge-file', async () => {
  try {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog(ctx.mainWindow, {
      title: 'Chọn file để thêm vào Knowledge',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Tài liệu', extensions: ['pdf', 'docx', 'xlsx', 'xls', 'txt', 'md', 'csv'] },
        { name: 'Ảnh', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] },
        { name: 'Tất cả', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    return { canceled: false, filePaths: result.filePaths };
  } catch (e) {
    return { canceled: true, error: e.message };
  }
});

ipcMain.handle('index-document', async (_event, { filepath, filename }) => {
  try {
    if (!filename || /[\/\\]/.test(filename) || filename.includes('..')) return { success: false, error: 'Invalid filename' };
    ensureDocumentsDir();
    const dst = path.join(getDocumentsDir(), filename);
    fs.copyFileSync(filepath, dst);

    const content = await extractTextFromFile(dst, filename);
    const wordCount = content ? content.split(/\s+/).length : 0;
    const filesize = fs.statSync(dst).size;
    const filetype = path.extname(filename).toLowerCase().replace('.', '');

    const db = getDocumentsDb();
    if (db) {
      const insertBoth = db.transaction(() => {
        insertDocumentRow(db, {
          filename, filepath: dst, content,
          filetype, filesize, wordCount
        });
        db.prepare('INSERT INTO documents_fts (filename, content) VALUES (?, ?)')
          .run(filename, content);
      });
      insertBoth();
      db.close();
    }

    return { success: true, filename, wordCount, filesize };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('search-documents', async (_event, query) => {
  let db;
  try {
    db = getDocumentsDb();
    if (!db) return [];
    // Layer 1: expand query for better recall.
    const expandedQuery = await expandSearchQuery(query);
    if (expandedQuery !== query) console.log(`[search] expanded "${query}" → "${expandedQuery}"`);
    // Layer 2: FTS5 search with expanded query.
    let results;
    try {
      results = db.prepare(`
        SELECT d.filename, d.filetype, d.word_count, d.created_at,
               snippet(documents_fts, 1, '**', '**', '...', 32) as snippet
        FROM documents_fts f
        JOIN documents d ON d.filename = f.filename
        WHERE documents_fts MATCH ?
        ORDER BY rank
        LIMIT 10
      `).all(expandedQuery);
    } catch {
      // Expanded query may have FTS5 syntax issues — fall back to original.
      results = db.prepare(`
        SELECT d.filename, d.filetype, d.word_count, d.created_at,
               snippet(documents_fts, 1, '**', '**', '...', 32) as snippet
        FROM documents_fts f
        JOIN documents d ON d.filename = f.filename
        WHERE documents_fts MATCH ?
        ORDER BY rank
        LIMIT 10
      `).all(query);
    }
    if (results.length === 0) return results;
    // Layer 3: rerank for semantic relevance.
    return await rerankSearchResults(query, results);
  } catch (e) { return []; }
  finally { try { if (db) db.close(); } catch {} }
});

ipcMain.handle('list-documents', async () => {
  try {
    const db = getDocumentsDb();
    if (!db) return [];
    const docs = db.prepare('SELECT filename, filetype, word_count, filesize, created_at FROM documents ORDER BY created_at DESC').all();
    db.close();
    return docs;
  } catch { return []; }
});

ipcMain.handle('delete-document', async (_event, filename) => {
  try {
    if (!filename || /[\/\\]/.test(filename) || filename.includes('..')) return { success: false, error: 'Invalid filename' };
    const db = getDocumentsDb();
    if (db) {
      db.prepare('DELETE FROM documents WHERE filename = ?').run(filename);
      db.prepare('DELETE FROM documents_fts WHERE filename = ?').run(filename);
      db.close();
    }
    const fp = path.join(getDocumentsDir(), filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('test-telegram', async (_event, { token, chatId }) => {
  return new Promise((resolve) => {
    const https = require('https');
    const payload = JSON.stringify({
      chat_id: chatId, text: '9BizClaw — Kết nối thành công!', parse_mode: 'Markdown',
    });
    const req = https.request(
      `https://api.telegram.org/bot${token}/sendMessage`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => { try { resolve({ success: JSON.parse(data).ok }); } catch { resolve({ success: false }); } });
      }
    );
    req.on('error', () => resolve({ success: false }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ success: false }); });
    req.write(payload);
    req.end();
  });
});

// Check all channels — fast, reliable, based on config + process state + HTTP ping
ipcMain.handle('check-all-channels', async () => {
  const r = {
    telegram: 'not_configured',
    zalo: 'not_configured',
    ai: 'stopped',
    google: 'not_configured',
    gateway: ctx.botRunning ? 'ok' : 'stopped',
  };

  // 1. 9Router — HTTP ping 127.0.0.1:20128
  r.ai = await new Promise((resolve) => {
    const req = require('http').get('http://127.0.0.1:20128/v1/models', { timeout: 3000 }, (res) => {
      res.resume();
      console.log('9Router check: status', res.statusCode);
      resolve(res.statusCode === 200 ? 'ok' : 'error');
    });
    req.on('error', (e) => { console.log('9Router check ERROR:', e.code, e.message); resolve('stopped'); });
    req.on('timeout', () => { console.log('9Router check TIMEOUT'); req.destroy(); resolve('stopped'); });
  });

  // 2. Telegram — check botToken in openclaw.json
  try {
    const tg = await probeTelegramReady();
    const { token } = getTelegramConfig();
    const telegramPause = getChannelPauseStatus('telegram');
    if (!token) {
      r.telegram = 'not_configured';
    } else if (telegramPause?.permanent) {
      r.telegram = 'disabled';
    } else if (telegramPause?.paused) {
      r.telegram = 'paused';
    } else if (tg.ready) {
      r.telegram = 'ok';
    } else if (tg.awaitingConfirmation) {
      r.telegram = 'checking';
    } else if (tg.reason === 'no-ceo-chat-id') {
      r.telegram = 'error';
    } else {
      r.telegram = ctx.botRunning ? 'error' : 'stopped';
    }
  } catch {}

  // 3. Zalo — check credentials file
  try {
    const zl = await probeZaloReady();
    if (zl.reason === 'config-error') {
      r.zalo = 'error';
    } else if (zl.reason === 'disabled' || zl.reason === 'paused-permanent') {
      r.zalo = 'disabled';
    } else if (zl.reason === 'paused') {
      r.zalo = 'paused';
    } else if (zl.ready) {
      r.zalo = 'ok';
    } else if (zl.awaitingConfirmation) {
      r.zalo = 'checking';
    } else if (zl.reason === 'no-credentials') {
      r.zalo = 'not_configured';
    } else {
      r.zalo = ctx.botRunning ? 'error' : 'stopped';
    }
  } catch {}

  // 4. Google Workspace — check via gogcli
  try {
    const googleApi = require('./google-api');
    const gs = await googleApi.authStatus();
    if (gs.connected) r.google = ctx.botRunning ? 'ok' : 'configured';
  } catch {}

  return r;
});

ipcMain.handle('get-dashboard', async () => {
  const data = { botRunning: ctx.botRunning };
  return data;
});

// _OVERVIEW_EVENT_LABELS, _readJsonlTail, _readCeoNameFromIdentity, _readRecentZaloCustomers, _nextFireTime — moved to lib/cron.js
ipcMain.handle('get-overview-data', async () => {
  try {
    const ws = getWorkspace();
    const now = new Date();
    const todayISO = now.toISOString().slice(0, 10);

    // 1. GREETING — CEO name + date + bot status
    const ceoInfo = _readCeoNameFromIdentity();
    const ceoName = ceoInfo.name || '';
    const ceoTitle = ceoInfo.title || '';
    const dayNames = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
    const dayName = dayNames[now.getDay()];
    const dateStr = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
    const hour = now.getHours();
    const greeting = hour < 12 ? 'Chào buổi sáng' : hour < 18 ? 'Chào buổi chiều' : 'Chào buổi tối';

    // 2. RECENT ACTIVITY — last 50 audit entries, mapped to display labels
    const auditFile = ws ? path.join(ws, 'logs', 'audit.jsonl') : null;
    const rawAudit = auditFile ? _readJsonlTail(auditFile, 50) : [];
    const activity = [];
    for (const e of rawAudit) {
      const meta = _OVERVIEW_EVENT_LABELS[e.event];
      if (!meta || !meta.show) continue;
      activity.push({
        ts: e.t,
        label: meta.label,
        icon: meta.icon,
        event: e.event,
      });
      if (activity.length >= 8) break;
    }

    // 3. UPCOMING — compute next firings for built-in schedules + custom crons
    const upcoming = [];
    try {
      const schedFile = path.join(ws, 'schedules.json');
      if (fs.existsSync(schedFile)) {
        const sched = JSON.parse(fs.readFileSync(schedFile, 'utf-8'));
        if (Array.isArray(sched)) {
          for (const s of sched) {
            if (!s || s.enabled === false) continue;
            const next = _nextFireTime(s.time, now);
            if (next) upcoming.push({ label: s.label || s.id, time: next, kind: 'built-in' });
          }
        }
      }
    } catch {}
    try {
      const cronsFile = path.join(ws, 'custom-crons.json');
      if (fs.existsSync(cronsFile)) {
        const crons = JSON.parse(fs.readFileSync(cronsFile, 'utf-8'));
        if (Array.isArray(crons)) {
          for (const c of crons) {
            if (!c || c.enabled === false) continue;
            const next = _nextFireTime(c.time, now, c.cronExpr);
            if (next) upcoming.push({ label: c.label || c.name || 'Cron tuỳ chỉnh', time: next, kind: 'custom' });
          }
        }
      }
    } catch {}
    upcoming.sort((a, b) => new Date(a.time) - new Date(b.time));
    const upcomingTrimmed = upcoming.slice(0, 6);

    // 4. ACTION ITEMS — things CEO should look at
    const actions = [];

    // 4a. Output filter blocked count today
    try {
      const filterFile = ws ? path.join(ws, 'logs', 'security-output-filter.jsonl') : null;
      if (filterFile && fs.existsSync(filterFile)) {
        const entries = _readJsonlTail(filterFile, 100);
        const todayCount = entries.filter(e => e.t && e.t.slice(0, 10) === todayISO).length;
        if (todayCount > 0) {
          actions.push({
            severity: 'medium',
            text: `${todayCount} tin Zalo bị bộ lọc chặn hôm nay`,
            cta: 'Xem log',
            ctaPage: null, // CTA opens log folder via tray
            kind: 'filter-blocked',
          });
        }
      }
    } catch {}

    // 4b. Zalo login status — only warn if not logged in at all
    try {
      const credFile = path.join(ctx.HOME, '.openzca', 'profiles', 'default', 'credentials.json');
      if (!fs.existsSync(credFile)) {
        // No credentials → user hasn't logged in Zalo yet
        actions.push({
          severity: 'low',
          text: 'Chưa đăng nhập Zalo',
          cta: 'Đăng nhập',
          ctaPage: 'zalo',
          kind: 'no-zalo-login',
        });
      }
    } catch {}

    // 4c. Strangers DMing today (count Zalo user memories created today)
    try {
      const zaloMemDir = ws ? path.join(ws, 'memory', 'zalo-users') : null;
      if (zaloMemDir && fs.existsSync(zaloMemDir)) {
        const files = fs.readdirSync(zaloMemDir).filter(f => f.endsWith('.md'));
        let newToday = 0;
        for (const f of files) {
          try {
            const mtime = fs.statSync(path.join(zaloMemDir, f)).mtimeMs;
            const ageH = (Date.now() - mtime) / (60 * 60 * 1000);
            if (ageH < 24) newToday++;
          } catch {}
        }
        if (newToday > 0) {
          actions.push({
            severity: 'low',
            text: `${newToday} khách Zalo mới tương tác hôm nay`,
            cta: 'Mở Zalo',
            ctaPage: 'zalo',
            kind: 'new-zalo-customers',
          });
        }
      }
    } catch {}

    // 4d. Bot stopped warning
    if (!ctx.botRunning) {
      actions.push({
        severity: 'high',
        text: 'Bot đang dừng — khách nhắn sẽ không có ai trả lời',
        cta: 'Khởi động',
        ctaPage: null,
        kind: 'bot-stopped',
      });
    }

    // 4e. RAG circuit breaker — recent rag_degraded audit entry within 10min
    try {
      const nowMs = Date.now();
      const recentRag = rawAudit.filter(e => {
        if (e.event !== 'rag_degraded') return false;
        const tMs = e.t ? Date.parse(e.t) : 0;
        return tMs && (nowMs - tMs) < 10 * 60 * 1000;
      });
      if (recentRag.length > 0) {
        actions.push({
          severity: 'medium',
          text: 'Tìm kiếm tài liệu tạm dừng (lỗi giao tiếp). Tự khôi phục sau 5 phút.',
          cta: null,
          ctaPage: null,
          kind: 'rag-degraded',
        });
      }
    } catch {}

    // 4f. Missed CEO alerts — ceo-alerts-missed.log has entries not yet surfaced
    try {
      const missedLogPath = ws ? path.join(ws, 'logs', 'ceo-alerts-missed.log') : null;
      if (missedLogPath && fs.existsSync(missedLogPath)) {
        const missedContent = fs.readFileSync(missedLogPath, 'utf-8').trim();
        if (missedContent.length > 0) {
          const lineCount = missedContent.split('\n').filter(l => l.trim()).length;
          actions.push({
            severity: 'high',
            text: `${lineCount} alert chưa gửi được cho CEO (Telegram có thể lỗi)`,
            cta: 'Kiểm tra Telegram',
            ctaPage: 'telegram',
            kind: 'missed-alerts',
          });
        }
      }
    } catch {}

    // 4g. Recent cron failures today
    try {
      const cronRunsFile2 = ws ? path.join(ws, 'logs', 'cron-runs.jsonl') : null;
      if (cronRunsFile2 && fs.existsSync(cronRunsFile2)) {
        const cronEntries2 = _readJsonlTail(cronRunsFile2, 100);
        const failsToday = cronEntries2.filter(e =>
          e.t && e.t.slice(0, 10) === todayISO && e.phase === 'fail'
        ).length;
        if (failsToday > 0) {
          actions.push({
            severity: 'high',
            text: `${failsToday} cron bị lỗi hôm nay`,
            cta: 'Xem log',
            ctaPage: null,
            kind: 'cron-failures',
          });
        }
      }
    } catch {}

    // 5. STATS — count of audit events today (rough proxy for "bot was busy")
    let eventsToday = 0;
    for (const e of rawAudit) {
      if (e.t && e.t.slice(0, 10) === todayISO) eventsToday++;
    }

    // 5b. New Zalo customers today (reuse actions computation)
    let newZaloCustomersToday = 0;
    try {
      const zaloMemDir2 = ws ? path.join(ws, 'memory', 'zalo-users') : null;
      if (zaloMemDir2 && fs.existsSync(zaloMemDir2)) {
        const files2 = fs.readdirSync(zaloMemDir2).filter(f => f.endsWith('.md'));
        for (const f of files2) {
          try {
            const mtime = fs.statSync(path.join(zaloMemDir2, f)).mtimeMs;
            if ((Date.now() - mtime) / (60 * 60 * 1000) < 24) newZaloCustomersToday++;
          } catch {}
        }
      }
    } catch {}

    // 5c. Cron OK count today
    let cronOkToday = 0;
    try {
      const cronRunsFile = ws ? path.join(ws, 'logs', 'cron-runs.jsonl') : null;
      if (cronRunsFile && fs.existsSync(cronRunsFile)) {
        const cronEntries = _readJsonlTail(cronRunsFile, 200);
        for (const e of cronEntries) {
          if (e.t && e.t.slice(0, 10) === todayISO && e.phase === 'ok') cronOkToday++;
        }
      }
    } catch {}

    // 5d. Workspace writability check — detect read-only filesystem / permissions
    try {
      if (ws) {
        const probeFile = path.join(ws, '.modoro-write-probe');
        fs.writeFileSync(probeFile, String(Date.now()), 'utf-8');
        fs.unlinkSync(probeFile);
      }
    } catch (writeErr) {
      actions.push({
        severity: 'high',
        text: 'Workspace chỉ đọc — config/cron/memory sẽ không lưu được',
        cta: null,
        ctaPage: null,
        kind: 'workspace-readonly',
      });
    }

    // 5e. Config staleness — openclaw.json older than 7 days may indicate stuck config
    try {
      const cfgPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
      if (fs.existsSync(cfgPath)) {
        const cfgAge = Date.now() - fs.statSync(cfgPath).mtimeMs;
        if (cfgAge > 7 * 24 * 60 * 60 * 1000) {
          actions.push({
            severity: 'low',
            text: 'Config chưa được cập nhật > 7 ngày',
            cta: null,
            ctaPage: null,
            kind: 'config-stale',
          });
        }
      }
    } catch {}

    // 6. RECENT ZALO CUSTOMERS — from memory/zalo-users/*.md
    const recentCustomers = ws ? _readRecentZaloCustomers(ws, 5) : [];

    return {
      success: true,
      greeting: {
        salutation: greeting,
        ceoName: ceoName || '',
        ceoTitle: ceoTitle || '',
        dayName,
        dateStr,
        botRunning: ctx.botRunning,
      },
      activity,
      upcoming: upcomingTrimmed,
      actions,
      recentCustomers,
      stats: {
        eventsToday,
        newZaloCustomersToday,
        cronOkToday,
      },
    };
  } catch (e) {
    console.error('[get-overview-data] error:', e?.message);
    return { success: false, error: e?.message };
  }
});

ipcMain.handle('wizard-complete', async () => {
  if (ctx.wizardCompleteInFlight) { console.log('[wizard] already in flight, skipping'); return { success: true }; }
  ctx.wizardCompleteInFlight = true;
  if (!ctx.mainWindow || ctx.mainWindow.isDestroyed()) { ctx.wizardCompleteInFlight = false; return { success: false }; }
  // GUARANTEE navigation: even if anything below throws/hangs, force-navigate
  // to dashboard.html on a short timer so CEO never sees forever-spinner.
  const navGuard = setTimeout(() => {
    try {
      if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
        console.warn('[wizard-complete] nav-guard fired — forcing dashboard load');
        ctx.mainWindow.loadFile(path.join(ELECTRON_DIR, 'ui', 'dashboard.html'));
        try { ctx.mainWindow.maximize(); } catch {}
      }
    } catch (e) { console.error('[wizard-complete nav-guard] error:', e && e.message); }
  }, 5000);
  // Fresh install: seed workspace files with defaults + cleanup any stale listener
  try { seedWorkspace(); } catch (e) { console.error('[wizard-complete seed] error:', e.message); }
  // F-3 + U3: Detect whether user completed Zalo QR login in wizard.
  // Poll for up to 3 seconds in case credentials.json is still being written
  // by the listener (QR scan completes → subprocess writes file asynchronously,
  // may lag 1-2s behind the IPC that says "login ok").
  let zaloLoggedIn = false;
  const credPath = path.join(ctx.HOME, '.openzca', 'profiles', 'default', 'credentials.json');
  for (let i = 0; i < 6; i++) {
    try {
      if (fs.existsSync(credPath)) {
        const stat = fs.statSync(credPath);
        if ((Date.now() - stat.mtimeMs) < 24 * 60 * 60 * 1000) { zaloLoggedIn = true; break; }
      }
    } catch {}
    if (i < 5) await new Promise(r => setTimeout(r, 500));
  }
  try { cleanupOrphanZaloListener(); } catch {}
  try { markOnboardingComplete('wizard-complete'); } catch {}
  // Pre-fill RAG rewrite-model based on primary AI provider.
  // Does NOT enable Tier 2 — tier2Enabled stays false. CEO opts in via Settings.
  try {
    const ragPath = path.join(getWorkspace(), 'rag-config.json');
    if (!fs.existsSync(ragPath)) {
      const isChatgptPlus = await detectChatgptPlusOAuth();
      writeJsonAtomic(ragPath, {
        tier2Enabled: false,
        rewriteModel: isChatgptPlus ? 'ninerouter/main' : 'ninerouter/fast',
        updatedAt: new Date().toISOString(),
      });
      console.log(`[wizard-complete] rag-config.json seeded (tier2=off, model=${isChatgptPlus ? 'ninerouter/main' : 'ninerouter/fast'})`);
    }
  } catch (e) { console.warn('[wizard-complete] RAG config prefill failed:', e?.message); }
  clearTimeout(navGuard);
  try { ctx.mainWindow.loadFile(path.join(ELECTRON_DIR, 'ui', 'dashboard.html')); } catch (e) { console.error('[wizard-complete loadFile] error:', e && e.message); }
  try { ctx.mainWindow.maximize(); } catch {}
  // CRIT #2: Return IMMEDIATELY. Previously this awaited ensureZaloPlugin +
  // startOpenClaw sequentially → UI froze 30-180s on fresh Windows install.
  // Non-tech CEOs force-quit. Dashboard channel-status broadcast (every 45s
  // after boot, 500ms-30s during boot window) drives sidebar dots as gateway
  // comes up — user sees progress instead of a frozen window.
  (async () => {
    try {
    if (ctx.appIsQuitting) { console.log('[wizard-iife] aborting — app quitting (pre-ensureZaloPlugin)'); return; }
    try { await ensureZaloPlugin(); } catch (e) { console.error('[wizard-complete ensureZaloPlugin] error:', e?.message || e); }
    if (ctx.appIsQuitting) { console.log('[wizard-iife] aborting — app quitting (pre-seedZaloCustomers)'); return; }
    try { seedZaloCustomersFromCache(); } catch (e) { console.error('[wizard-complete seedZaloCustomers] error:', e?.message || e); }
    if (ctx.appIsQuitting) { console.log('[wizard-iife] aborting — app quitting (pre-startOpenClaw)'); return; }
    try { startCronApi(); } catch (e) { console.error('[wizard-complete startCronApi preflight] error:', e?.message || e); }
    try { await startOpenClaw(); } catch (e) { console.error('[wizard-complete startOpenClaw] error:', e?.message || e); }
    if (ctx.appIsQuitting) { console.log('[wizard-iife] aborting — app quitting (pre-startCronJobs)'); return; }
    try { startCronJobs(); } catch (e) { console.error('[wizard-complete startCronJobs] error:', e?.message || e); }
    try { startCronApi(); } catch (e) { console.error('[wizard-complete startCronApi] error:', e?.message || e); }
    try { watchCustomCrons(); } catch {}
    try { startZaloCacheAutoRefresh(); } catch {}
    try { startAppointmentDispatcher(); } catch {}
    try { startFollowUpChecker(); } catch {}
    try { startEscalationChecker(); } catch {}
    setTimeout(() => { try { checkZaloCookieAge(); } catch {} }, 30000);

    // Welcome flow: first-time introduction after wizard
    if (ctx.appIsQuitting) { console.log('[wizard-iife] aborting — app quitting (pre-welcome)'); return; }
    try {
      const ws = getWorkspace();
      const welcomeSent = ws && fs.existsSync(path.join(ws, '.welcome-sent'));
      if (!welcomeSent) {
        const { chatId } = getTelegramConfig();
        if (chatId) {
          const welcomeMsg = [
            'Chào anh/chị, em đã sẵn sàng làm việc.',
            '',
            'Vài thứ có thể thử ngay:',
            '- Nhắn tin cho em trên Telegram này -- em sẽ trả lời như cố vấn kinh doanh',
            '- Nhờ khách hàng nhắn Zalo cho shop -- em sẽ tự động tư vấn dựa trên Knowledge',
            '- Gõ "báo cáo" -- em gửi tóm tắt hoạt động ngay lập tức',
            '- Gõ "tạo cron gửi nhóm VIP mỗi sáng 9h: Chào buổi sáng" -- em tạo lịch gửi tự động',
            '',
            'Mỗi sáng và tối em sẽ gửi báo cáo tự động. Reply tự nhiên để ra lệnh.',
            '',
            'Nếu cần thêm Knowledge (bảng giá, FAQ, chính sách), mở Dashboard tab Knowledge và upload file.',
          ].join('\n');
          // Write marker BEFORE send (write-then-send = safe order per AGENTS.md)
          if (ws) fs.writeFileSync(path.join(ws, '.welcome-sent'), new Date().toISOString(), 'utf-8');
          await sendTelegram(welcomeMsg, { skipFilter: true, skipPauseCheck: true });
          console.log('[welcome] sent first-time introduction via Telegram');
        }
      }
    } catch (e) { console.error('[welcome] failed:', e?.message); }
    } finally { ctx.wizardCompleteInFlight = false; }
  })();
  return { success: true };
});

// Install OpenClaw automatically (async — no UI freeze)
ipcMain.handle('install-openclaw', async (event) => {
  const sender = event.sender;
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';

  const send = (msg) => sender.send('install-progress', msg);

  // SHORT-CIRCUIT: if app is packaged AND vendor/ ships with bundled Node + plugins,
  // skip npm install entirely. The wizard's "Đang khởi tạo npm..." step is a no-op
  // for full-bundled builds (Mac DMG + Win EXE 436MB) — everything is already
  // pre-extracted to resources/vendor/ by prebuild-vendor.js. Verifying the bundled
  // openclaw + 9router + openzca + modoro-zalo all exist is enough.
  try {
    const vendorDir = getBundledVendorDir();
    if (vendorDir) {
      const openclawCli = path.join(vendorDir, 'node_modules', 'openclaw', 'openclaw.mjs');
      const ninerouterPkg = path.join(vendorDir, 'node_modules', '9router', 'package.json');
      const openzcaCli = path.join(vendorDir, 'node_modules', 'openzca', 'dist', 'cli.js');
      const modoroZaloPlugin = path.join(vendorDir, 'node_modules', 'modoro-zalo', 'openclaw.plugin.json');
      const zaloPluginExists = fs.existsSync(modoroZaloPlugin);
      const all = [openclawCli, ninerouterPkg, openzcaCli];
      const allPresent = all.every(p => { try { return fs.existsSync(p); } catch { return false; } }) && zaloPluginExists;
      if (allPresent) {
        send('App đã có sẵn OpenClaw bundled — bỏ qua npm install.');
        send('Bundled vendor: ' + vendorDir);
        send('  openclaw: OK');
        send('  9router: OK');
        send('  openzca: OK');
        send('  modoro-zalo: OK');
        send('Hoàn tất.');
        return { success: true, bundled: true };
      } else {
        const missing = all.filter(p => { try { return !fs.existsSync(p); } catch { return true; } });
        send('Cảnh báo: vendor folder có nhưng thiếu file:');
        for (const m of missing) send('  - ' + m);
        send('Sẽ thử npm install để bổ sung...');
      }
    }
  } catch (e) {
    send('Lỗi khi kiểm tra bundled vendor: ' + String(e.message || e));
    send('Sẽ fallback sang npm install...');
  }

  // PRE-CHECK 1: Verify Node.js is available + version is recent enough.
  // openzca requires Node >= 22.13.0. If user has older Node, npm install will
  // log a warning but proceed; openzca's compiled output (tsup --target node22)
  // may then fail at runtime with syntax errors. Show a clear actionable error
  // BEFORE wasting 5 minutes on a doomed npm install.
  // NOTE: This intentionally checks SYSTEM node (`node -v` via PATH), not the
  // bundled vendor/node/bin/node. Reason: this handler runs `npm install -g`
  // which goes through the user's npm prefix and uses their globally-installed
  // Node. Bundled vendor node is for RUNTIME spawning of openclaw/openzca/9router
  // by the gateway, not for installing global packages. The two roles are
  // separate by design — vendor node never touches the user's npm tree.
  let nodeVersionMajor = 0;
  try {
    const { execSync } = require('child_process');
    const out = execSync('node -v', { encoding: 'utf-8', timeout: 5000 }).trim();
    const m = out.match(/^v(\d+)/);
    if (m) nodeVersionMajor = parseInt(m[1], 10);
  } catch {
    return {
      success: false,
      error: isMac
        ? 'Không tìm thấy Node.js trên máy.\n\nCài Node 22 LTS từ https://nodejs.org\n(hoặc: brew install node@22)\n\nSau đó mở lại 9BizClaw.'
        : 'Không tìm thấy Node.js trên máy.\n\nCài Node 22 LTS từ https://nodejs.org\n\nSau đó mở lại 9BizClaw.',
    };
  }
  if (nodeVersionMajor < 22) {
    return {
      success: false,
      error: `Node.js quá cũ (v${nodeVersionMajor}). 9BizClaw cần Node 22+ để chạy openzca (Zalo plugin).\n\n` +
             (isMac
               ? 'Cập nhật:\n  brew upgrade node\nhoặc tải installer từ https://nodejs.org'
               : 'Cập nhật từ https://nodejs.org'),
    };
  }

  // PRE-CHECK 2 (Mac only): Verify npm has write permission to global prefix.
  // On Mac without sudo, /usr/local/lib/node_modules is often write-protected.
  // We check `npm config get prefix` and try to detect EACCES early so the
  // user gets a clear hint to set up `~/.npm-global` or use `sudo`.
  if (isMac) {
    try {
      const { execSync } = require('child_process');
      const npmPrefix = execSync('npm config get prefix', { encoding: 'utf-8', timeout: 5000 }).trim();
      // Probe writability of the global lib dir
      const libDir = path.join(npmPrefix, 'lib', 'node_modules');
      try { fs.accessSync(libDir, fs.constants.W_OK); }
      catch {
        send(`C\u1EA3nh b\u00E1o: npm global prefix kh\u00F4ng ghi \u0111\u01B0\u1EE3c: ${npmPrefix}`);
        send('');
        send('Kh\u1EAFc ph\u1EE5c: thi\u1EBFt l\u1EADp user-prefix cho npm:');
        send('  mkdir -p ~/.npm-global');
        send('  npm config set prefix ~/.npm-global');
        send('  echo \'export PATH=~/.npm-global/bin:$PATH\' >> ~/.zshrc');
        send('  source ~/.zshrc');
        send('');
        send('Sau \u0111\u00F3 th\u1EED l\u1EA1i. (Tr\u00E1nh d\u00F9ng sudo cho npm install -g.)');
        // We don't hard-fail here — npm install may still succeed if user
        // has /usr/local writable. Just warn loudly.
      }
    } catch {}
  }

  // Kill 9Router/OpenClaw before npm install to avoid EBUSY
  try { await stop9Router(); } catch {}
  try { await stopOpenClaw(); } catch {}
  if (isWin) {
    try { spawn('taskkill', ['/f', '/im', '9router.exe'], { stdio: 'ignore' }); } catch {}
  } else {
    try { spawn('killall', ['9router', 'openclaw'], { stdio: 'ignore' }); } catch {}
  }
  await new Promise(r => setTimeout(r, 1000));

  return new Promise((resolve) => {
    let resolved = false;
    const safeResolve = (val) => { if (!resolved) { resolved = true; resolve(val); } };
    send('=== Bắt đầu cài đặt OpenClaw ===');
    send('');
    send('Hệ điều hành: ' + (isWin ? 'Windows' : process.platform === 'darwin' ? 'macOS' : process.platform));
    send('Node.js: v' + nodeVersionMajor);
    send('Thời gian: ' + new Date().toLocaleTimeString('vi-VN'));
    send('');
    send('--- Cài đặt OpenClaw via npm ---');

    // Install OpenClaw + 9Router + openzca via npm AT PINNED VERSIONS.
    // CRITICAL: pin versions to protect against upstream schema breakage.
    // Without pinning, fresh installs months from now will pull `latest` which
    // may have incompatible schema → wizard fails on day 1 with "Config invalid".
    // To upgrade pinned versions: edit PINNED_VERSIONS table below,
    // smoke-test, then ship a new build. Single source of truth is also in
    // electron/scripts/prebuild-vendor.js — keep both in sync (and PINNING.md).
    // CRIT #11: All 4 vendor packages must be pinned. Previously @tuyenhx/openzalo
    // was missing — dev-mode fresh installs pulled `latest` via openclaw's
    // plugin auto-install path, so an upstream breaking change in the zalo plugin
    // would silently break Zalo for every new VIP installing that day.
    // NOTE: modoro-zalo is the renamed fork; @tuyenhx/openzalo kept as fallback
    // for dev-mode network installs until modoro-zalo is published to npm.
    const PINNED_VERSIONS = [
      'openclaw@2026.4.14',
      '9router@0.4.12',
      'openzca@0.1.57',
    ];
    let cmd, args;
    if (isWin) {
      cmd = 'npm.cmd';
      args = ['install', '-g', '--save-exact', ...PINNED_VERSIONS];
    } else {
      cmd = 'npm';
      args = ['install', '-g', '--save-exact', ...PINNED_VERSIONS];
    }

    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: isWin });
    let output = '';

    // Stream ALL output — both stdout and stderr
    const handleOutput = (stream, prefix) => {
      let buffer = '';
      stream.on('data', (data) => {
        buffer += data.toString();
        // Process complete lines
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete last line in buffer
        for (const raw of lines) {
          const clean = raw.replace(/\x1b\[[0-9;]*m/g, '').trim();
          if (clean) {
            output += clean + '\n';
            send(prefix + clean);
          }
        }
      });
      // Flush remaining buffer
      stream.on('end', () => {
        const clean = buffer.replace(/\x1b\[[0-9;]*m/g, '').trim();
        if (clean) {
          output += clean + '\n';
          send(prefix + clean);
        }
      });
    };

    handleOutput(proc.stdout, '');
    handleOutput(proc.stderr, '');

    // Timeout after 10 minutes (npm install can be slow)
    const timeout = setTimeout(() => {
      proc.kill();
      send('');
      send('Qu\u00E1 th\u1EDDi gian (10 ph\u00FAt).');
      safeResolve({ success: false, error: 'Quá thời gian. Thử lại hoặc cài thủ công.' });
    }, 10 * 60 * 1000);

    proc.on('exit', (code) => {
      clearTimeout(timeout);
      send('');
      send('--- Bước 2: Kiểm tra cài đặt ---');
      send('Exit code: ' + code);

      // Verify — small delay for PATH to propagate
      // (_cachedBin is private to lib/boot.js; findOpenClawBin() re-probes automatically)
      setTimeout(async () => {
        const bin = await findOpenClawBin();
        if (bin) {
          send('OpenClaw binary: ' + bin);
          send('');
          send('CÀI ĐẶT THÀNH CÔNG');
          safeResolve({ success: true });
        } else if (code === 0) {
          send('');
          send('C\u1EA3nh b\u00E1o: Installer ch\u1EA1y xong nh\u01B0ng kh\u00F4ng t\u00ECm th\u1EA5y openclaw.');
          send('Thử khởi động lại app.');
          safeResolve({ success: false, error: 'Cài xong nhưng không tìm thấy openclaw. Khởi động lại app.' });
        } else {
          send('');
          send('C\u00E0i \u0111\u1EB7t th\u1EA5t b\u1EA1i.');
          safeResolve({ success: false, error: `Mã lỗi: ${code}\n\n${output.slice(-1000)}` });
        }
      }, 2000);
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      send('');
      send('Không chạy được: ' + err.message);
      safeResolve({ success: false, error: err.message });
    });
  });
});

// Relaunch app after OpenClaw install
ipcMain.handle('relaunch', async () => {
  app.relaunch();
  app.exit(0);
});

// Factory reset — wipe ALL user data. Called from Dashboard with 2-layer
// confirmation (modal + type-to-confirm "XOA"). After wipe, Dashboard calls
// relaunch() so app starts fresh with wizard onboarding.
ipcMain.handle('factory-reset', async () => {
  try {
    console.log('[factory-reset] Starting full wipe...');
    // Stop background processes so they don't hold file handles
    try { await stopOpenClaw(); } catch {}
    try { stop9Router(); } catch {}
    try { stopCronJobs(); } catch {}
    // Small delay for process cleanup
    await new Promise(r => setTimeout(r, 500));

    const targets = [];
    const ws = getWorkspace();
    if (ws) targets.push(ws);
    targets.push(path.join(ctx.HOME, '.openclaw'));
    targets.push(path.join(ctx.HOME, '.openzca'));
    if (process.platform === 'win32') {
      const appData = process.env.APPDATA || path.join(ctx.HOME, 'AppData', 'Roaming');
      targets.push(path.join(appData, '9router'));
    } else if (process.platform === 'darwin') {
      targets.push(path.join(ctx.HOME, 'Library', 'Application Support', '9router'));
    } else {
      const xdg = process.env.XDG_CONFIG_HOME || path.join(ctx.HOME, '.config');
      targets.push(path.join(xdg, '9router'));
    }

    const results = [];
    for (const t of targets) {
      try {
        if (fs.existsSync(t)) {
          fs.rmSync(t, { recursive: true, force: true });
          console.log('[factory-reset] removed:', t);
          results.push({ path: t, ok: true });
        }
      } catch (e) {
        console.error('[factory-reset] failed to remove', t, e?.message);
        results.push({ path: t, ok: false, error: e?.message });
      }
    }

    console.log('[factory-reset] done');
    return { success: true, results };
  } catch (e) {
    console.error('[factory-reset] error:', e?.message || e);
    return { success: false, error: e?.message || String(e) };
  }
});

// Export workspace — create a tar archive of the user's workspace (config,
// memory, knowledge metadata, schedules, etc.) for backup / migration to a
// new machine. Excludes Electron cache dirs, logs, backups, and heavy
// knowledge/*/files blobs to keep the archive lean.
ipcMain.handle('export-workspace', async () => {
  try {
    const { dialog } = require('electron');
    const ws = getWorkspace();
    if (!ws || !fs.existsSync(ws)) {
      return { ok: false, error: 'workspace not found' };
    }
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
    const defaultName = `modoroclaw-export-${Date.now()}.tar`;
    const saveRes = await dialog.showSaveDialog(win, {
      title: 'Lưu file export',
      defaultPath: defaultName,
      filters: [{ name: 'TAR archive', extensions: ['tar'] }],
    });
    if (saveRes.canceled || !saveRes.filePath) {
      return { ok: false, canceled: true };
    }
    const outfile = saveRes.filePath;

    // Excluded dir/file name set (Electron cache, heavy state, transient).
    const EXCLUDED = new Set([
      'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'Network',
      'Local Storage', 'Session Storage', 'logs', 'backups',
      'Shared Dictionary', 'SharedStorage', 'blob_storage', 'Partitions',
      'node_modules', 'tmp', 'temp',
    ]);
    // Build explicit include list from top-level workspace entries.
    const include = [];
    for (const name of fs.readdirSync(ws)) {
      if (EXCLUDED.has(name)) continue;
      // Skip dotfiles coming from Chromium/Electron state.
      if (name === '.org.chromium.Chromium' || name.startsWith('.com.google.Chrome')) continue;
      include.push(name);
    }
    if (include.length === 0) {
      return { ok: false, error: 'nothing to export' };
    }

    // For each knowledge/<cat>/files subdir, exclude via --exclude patterns
    // (still include knowledge/<cat>/index.md + metadata). tar honors
    // --exclude relative to -C root on both BSD tar (mac) and bsdtar
    // bundled with Windows 10+.
    const excludePatterns = [
      'knowledge/*/files',
      'knowledge/*/files/*',
    ];

    const tarBin = process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
      : '/usr/bin/tar';

    const args = ['-cf', outfile];
    for (const pat of excludePatterns) args.push(`--exclude=${pat}`);
    args.push('-C', ws);
    for (const n of include) args.push(n);

    await new Promise((resolve, reject) => {
      const proc = spawn(tarBin, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`tar exit ${code}: ${stderr.trim()}`));
      });
    });

    const stat = fs.statSync(outfile);
    console.log('[export-workspace] wrote', outfile, stat.size, 'bytes');
    return { ok: true, path: outfile, sizeBytes: stat.size };
  } catch (e) {
    console.error('[export-workspace] error:', e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
});

// Import workspace — restore a previously exported tar archive over the
// current workspace. Overwrites existing files. Caller is expected to show
// a confirm dialog in the UI before invoking. App restart is recommended
// afterwards so in-memory state re-reads the fresh files.
ipcMain.handle('import-workspace', async () => {
  try {
    const { dialog } = require('electron');
    const ws = getWorkspace();
    if (!ws) {
      return { ok: false, error: 'workspace not found' };
    }
    try { fs.mkdirSync(ws, { recursive: true }); } catch {}
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
    const openRes = await dialog.showOpenDialog(win, {
      title: 'Chọn file export để khôi phục',
      properties: ['openFile'],
      filters: [{ name: 'TAR archive', extensions: ['tar'] }],
    });
    if (openRes.canceled || !openRes.filePaths || openRes.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    const infile = openRes.filePaths[0];
    if (!fs.existsSync(infile)) {
      return { ok: false, error: 'file not found' };
    }

    const tarBin = process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
      : '/usr/bin/tar';
    const args = ['-xf', infile, '-C', ws];

    await new Promise((resolve, reject) => {
      const proc = spawn(tarBin, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`tar exit ${code}: ${stderr.trim()}`));
      });
    });

    console.log('[import-workspace] restored from', infile, 'into', ws);
    return { ok: true, path: infile };
  } catch (e) {
    console.error('[import-workspace] error:', e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
});

// Diagnostic log IPC — lets Dashboard/wizard grab the main.log contents
// without the user needing to open DevTools.
ipcMain.handle('get-diagnostic-log', async (_event, { tailLines = 500 } = {}) => {
  try {
    const logPath = ctx.getLogFilePath ? ctx.getLogFilePath() : null;
    if (!logPath || !fs.existsSync(logPath)) {
      return { ok: false, error: 'log file not found', path: logPath || null };
    }
    const raw = fs.readFileSync(logPath, 'utf-8');
    const lines = raw.split('\n');
    const tail = tailLines > 0 ? lines.slice(-tailLines).join('\n') : raw;
    const redacted = tail.replace(/\b(bot\d{5,}:\S{30,}|sk-[A-Za-z0-9_-]{20,}|[A-Za-z0-9+/=]{40,})/g, '[REDACTED]');
    return { ok: true, path: logPath, content: redacted, totalLines: lines.length };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('open-log-folder', async () => {
  try {
    const logPath = ctx.getLogFilePath ? ctx.getLogFilePath() : null;
    if (logPath && fs.existsSync(logPath)) {
      shell.showItemInFolder(logPath);
      return { ok: true };
    }
    if (logPath) {
      shell.openPath(path.dirname(logPath));
      return { ok: true };
    }
    return { ok: false, error: 'no log path' };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('open-external', async (_event, url) => {
  try {
    const parsed = new URL(url);
    const allowedOrigins = [
      'https://ollama.com',
      'https://t.me',
      'https://youtube.com',
      'https://www.youtube.com',
      'https://business.facebook.com',
      'https://developers.facebook.com',
      'https://www.facebook.com',
      'https://facebook.com',
      'https://console.cloud.google.com',
      'https://console.developers.google.com',
      'https://cloud.google.com',
      'https://developers.google.com',
      'https://support.google.com',
      'https://github.com',
      'https://drive.google.com',
      'https://docs.google.com',
      'https://mail.google.com',
      'http://localhost:20128',
      'http://127.0.0.1:20128',
      'http://127.0.0.1:18789',
      'http://localhost:18789',
      'http://127.0.0.1:18791',
      'http://localhost:18791',
    ];
    // Telegram deep-link: tg://resolve?domain=<bot> opens native app directly.
    // Allow ONLY the resolve action (no msg_url, no join) to keep the surface
    // tight. Non-resolve tg:// URLs are rejected.
    const isTelegramResolve = parsed.protocol === 'tg:' && parsed.href.startsWith('tg://resolve?domain=') && /^[A-Za-z0-9_]{1,32}$/.test(parsed.searchParams.get('domain') || '');
    if (allowedOrigins.includes(parsed.origin) || isTelegramResolve) {
      const { shell } = require('electron');
      shell.openExternal(parsed.href);
    }
  } catch {} // Invalid URL — ignore
});

ipcMain.handle('get-gateway-token', async () => {
  try {
    const configPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return config.gateway?.auth?.token || null;
    }
  } catch {}
  return null;
});

ipcMain.handle('get-bot-status', async () => ({ running: ctx.botRunning }));

ipcMain.handle('get-app-version', async () => {
  try { return app.getVersion(); } catch { return ''; }
});

// ---- License IPC handlers (membership builds only) ----

ipcMain.handle('activate-license', async (_event, { key }) => {
  const license = require('./license');
  license.init(getWorkspace);
  try {
    const result = await license.activateLicense(key);
    if (!result.success) return result;
    // Check if app was already set up (re-activation after expiry)
    const configured = isOpenClawConfigured() && hasCompletedOnboarding();
    return { ...result, configured };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('get-license-status', async () => {
  const license = require('./license');
  license.init(getWorkspace);
  const status = license.checkLicenseStatus();
  status.machineId = license.getMachineId();
  return status;
});

ipcMain.handle('deactivate-license', async () => {
  const license = require('./license');
  license.init(getWorkspace);
  await license.clearLicense();
  return { success: true };
});

ipcMain.handle('toggle-bot', async () => {
  if (ctx.botRunning) {
    await stopOpenClaw();
  } else {
    if (ctx.startOpenClawInFlight || ctx.gatewayRestartInFlight) {
      return { running: false, pending: true };
    }
    try { startCronApi(); } catch (e) { console.error('[toggle-bot] startCronApi preflight error:', e?.message || e); }
    await startOpenClaw();
    startRuntimeSidecars('toggle-bot');
  }
  return { running: ctx.botRunning };
});

ipcMain.handle('check-for-updates', async () => {
  try {
    const result = await checkForUpdates();
    if (result) return { available: true, ...result };
    return { available: false, version: app.getVersion() };
  } catch (e) {
    return { available: false, error: e.message };
  }
});

ipcMain.handle('download-and-install-update', async () => {
  const _latestRel = getLatestRelease();
  if (!_latestRel) return { success: false, error: 'No update available' };
  // H1: concurrency guard — prevent double-click corruption
  if (getUpdateDownloadInFlight()) return { success: false, error: 'Download already in progress' };
  setUpdateDownloadInFlight(true);
  try {
    const platform = process.platform;
    let asset = null;
    if (platform === 'win32') {
      asset = _latestRel.assets.find(a => a.name.endsWith('.exe'));
    } else if (platform === 'darwin') {
      // Mac: download correct DMG (arm64 vs x64) → mount → install → relaunch
      const arch = process.arch; // 'arm64' or 'x64'
      // Asset naming: 9BizClaw-2.3.4-arm64.dmg (Apple Silicon), 9BizClaw-2.3.4.dmg (Intel x64)
      asset = _latestRel.assets.find(a => {
        if (!a.name.endsWith('.dmg')) return false;
        if (arch === 'arm64') return a.name.includes('arm64');
        // x64: pick DMG that does NOT have 'arm64' in name
        return !a.name.includes('arm64');
      });
      if (!asset) {
        // Fallback: open release page in browser
        console.warn('[update] No matching DMG for arch:', arch);
        openGitHubUrl(_latestRel.html_url);
        return { success: true, method: 'browser' };
      }
    }
    if (!asset) {
      // Fallback: open release page
      openGitHubUrl(_latestRel.html_url);
      return { success: true, method: 'browser' };
    }
    // Download asset (EXE on Windows, DMG on Mac)
    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      ctx.mainWindow.webContents.send('update-download-progress', { received: 0, total: asset.size, percent: 0 });
    }
    const localPath = await downloadUpdate(asset.url, asset.name, asset.size);

    if (platform === 'darwin') {
      // Mac: mount DMG → copy .app → remove quarantine → relaunch
      await installDmgUpdate(localPath);
      return { success: true, method: 'dmg-install' };
    }
    // Windows: launch EXE installer and quit
    const { shell } = require('electron');
    const openErr = await shell.openPath(localPath);
    if (openErr) throw new Error(openErr);
    // Give installer 2s to start then quit app
    setTimeout(() => { app.quit(); }, 2000);
    return { success: true, method: 'installer', path: localPath };
  } catch (e) {
    console.error('[update] download/install error:', e.message);
    // Mac fallback: if DMG install fails, open release page in browser
    const _latestRelFb = getLatestRelease();
    if (process.platform === 'darwin' && _latestRelFb && _latestRelFb.html_url) {
      openGitHubUrl(_latestRelFb.html_url);
      return { success: false, error: e.message, fallback: 'browser' };
    }
    return { success: false, error: e.message };
  } finally {
    setUpdateDownloadInFlight(false);
  }
});


  // --- Google Workspace (via gogcli) ---
  const googleApi = require('./google-api');

  ipcMain.handle('google-auth-status', async () => {
    try { return await googleApi.authStatus(); }
    catch (e) { return { connected: false, error: e.message }; }
  });
  ipcMain.handle('google-health', async () => {
    try { return await googleApi.serviceHealth(); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('google-upload-credentials', async (_ev, filePath) => {
    try {
      googleApi.validateOAuthClientSecret(filePath);
      const configDir = googleApi.getGogConfigDir();
      fs.mkdirSync(configDir, { recursive: true });
      const dest = path.join(configDir, 'client_secret.json');
      fs.copyFileSync(filePath, dest);
      await googleApi.registerCredentials(dest);
      return { ok: true };
    } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('google-connect', async (_ev, email) => {
    try {
      const result = await googleApi.connectAccount(email);
      return { ok: true, ...result };
    } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('google-disconnect', async () => {
    try { return await googleApi.disconnectAccount(); }
    catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('google-calendar-events', async (_ev, opts) => {
    try { return await googleApi.listEvents(opts?.from, opts?.to, opts?.calendarId); }
    catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-calendar-create', async (_ev, opts) => {
    try {
      if (!opts?.summary || !opts?.start || !opts?.end) return { error: 'summary, start, end required' };
      const r = await googleApi.createEvent(opts.summary, opts.start, opts.end, opts.attendees, opts.calendarId);
      try { auditLog('google_calendar_create', { summary: opts.summary }); } catch {}
      return r;
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-calendar-update', async (_ev, opts) => {
    try {
      if (!opts?.eventId) return { error: 'eventId required' };
      const hasUpdate = ['summary', 'start', 'end', 'description', 'location', 'attendees']
        .some(key => opts[key] !== undefined);
      if (!hasUpdate) return { error: 'at least one update field required' };
      const r = await googleApi.updateEvent(opts.eventId, opts, opts.calendarId);
      try { auditLog('google_calendar_update', { eventId: opts.eventId, summary: opts.summary }); } catch {}
      return r;
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-calendar-delete', async (_ev, opts) => {
    try {
      if (!opts?.eventId) return { error: 'eventId required' };
      const r = await googleApi.deleteEvent(opts.eventId, opts.calendarId);
      try { auditLog('google_calendar_delete', { eventId: opts.eventId }); } catch {}
      return r;
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-calendar-freebusy', async (_ev, opts) => {
    try { return await googleApi.getFreeBusy(opts?.from, opts?.to); }
    catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-calendar-free-slots', async (_ev, opts) => {
    try { return await googleApi.getFreeSlots(opts.date, opts.workStart, opts.workEnd, opts.slotMinutes); }
    catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('google-gmail-inbox', async (_ev, opts) => {
    try { return await googleApi.listInbox(opts?.max); }
    catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-gmail-read', async (_ev, opts) => {
    try { return await googleApi.readEmail(opts.id); }
    catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-gmail-send', async (_ev, opts) => {
    try {
      if (!opts?.to || !opts?.subject || !opts?.body) return { error: 'to, subject, body required' };
      const r = await googleApi.sendEmail(opts.to, opts.subject, opts.body);
      try { auditLog('google_gmail_send', { to: opts.to, subject: opts.subject }); } catch {}
      return r;
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-gmail-reply', async (_ev, opts) => {
    try {
      if (!opts?.id || !opts?.body) return { error: 'id, body required' };
      const r = await googleApi.replyEmail(opts.id, opts.body);
      try { auditLog('google_gmail_reply', { id: opts.id }); } catch {}
      return r;
    } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('google-drive-list', async (_ev, opts) => {
    try { return await googleApi.listFiles(opts?.query, opts?.max); }
    catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-drive-upload', async (_ev, opts) => {
    try {
      if (!opts?.filePath) return { error: 'filePath required' };
      const googleRoutes = require('./google-routes');
      if (googleRoutes.isHomedirPathSafe && !googleRoutes.isHomedirPathSafe(opts.filePath)) return { error: 'filePath blocked by path validation' };
      const r = await googleApi.uploadFile(opts.filePath, opts.folderId);
      try { auditLog('google_drive_upload', { filePath: opts.filePath }); } catch {}
      return r;
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-drive-download', async (_ev, opts) => {
    try {
      if (!opts?.fileId || !opts?.destPath) return { error: 'fileId, destPath required' };
      const googleRoutes = require('./google-routes');
      if (googleRoutes.isHomedirPathSafe && !googleRoutes.isHomedirPathSafe(opts.destPath)) return { error: 'destPath blocked by path validation' };
      const r = await googleApi.downloadFile(opts.fileId, opts.destPath, opts.format);
      try { auditLog('google_drive_download', { fileId: opts.fileId }); } catch {}
      return r;
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-drive-share', async (_ev, opts) => {
    try {
      if (!opts?.fileId || !opts?.email) return { error: 'fileId, email required' };
      const r = await googleApi.shareFile(opts.fileId, opts.email, opts.role);
      try { auditLog('google_drive_share', { fileId: opts.fileId, email: opts.email }); } catch {}
      return r;
    } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('google-docs-list', async (_ev, opts) => {
    try { return await googleApi.listDocs(opts?.max); }
    catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-docs-info', async (_ev, opts) => {
    try {
      if (!opts?.docId) return { error: 'docId required' };
      return await googleApi.getDocInfo(opts.docId);
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-docs-read', async (_ev, opts) => {
    try {
      if (!opts?.docId) return { error: 'docId required' };
      return await googleApi.readDoc(opts.docId, opts);
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-docs-create', async (_ev, opts) => {
    try {
      if (!opts?.title) return { error: 'title required' };
      const googleRoutes = require('./google-routes');
      if (opts.file && googleRoutes.isHomedirPathSafe && !googleRoutes.isHomedirPathSafe(opts.file)) return { error: 'file blocked by path validation' };
      const r = await googleApi.createDoc(opts.title, opts);
      try { auditLog('google_docs_create', { title: opts.title }); } catch {}
      return r;
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-docs-write', async (_ev, opts) => {
    try {
      if (!opts?.docId) return { error: 'docId required' };
      if (opts.text === undefined && !opts.file) return { error: 'text or file required' };
      const googleRoutes = require('./google-routes');
      if (opts.file && googleRoutes.isHomedirPathSafe && !googleRoutes.isHomedirPathSafe(opts.file)) return { error: 'file blocked by path validation' };
      const r = await googleApi.writeDoc(opts.docId, opts);
      try { auditLog('google_docs_write', { docId: opts.docId }); } catch {}
      return r;
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-docs-insert', async (_ev, opts) => {
    try {
      if (!opts?.docId) return { error: 'docId required' };
      if (opts.content === undefined && !opts.file) return { error: 'content or file required' };
      const googleRoutes = require('./google-routes');
      if (opts.file && googleRoutes.isHomedirPathSafe && !googleRoutes.isHomedirPathSafe(opts.file)) return { error: 'file blocked by path validation' };
      const r = await googleApi.insertDoc(opts.docId, opts.content, opts);
      try { auditLog('google_docs_insert', { docId: opts.docId }); } catch {}
      return r;
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-docs-find-replace', async (_ev, opts) => {
    try {
      if (!opts?.docId || !opts?.find) return { error: 'docId and find required' };
      const googleRoutes = require('./google-routes');
      if (opts.contentFile && googleRoutes.isHomedirPathSafe && !googleRoutes.isHomedirPathSafe(opts.contentFile)) return { error: 'contentFile blocked by path validation' };
      const r = await googleApi.findReplaceDoc(opts.docId, opts.find, opts.replace, opts);
      try { auditLog('google_docs_find_replace', { docId: opts.docId }); } catch {}
      return r;
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-docs-export', async (_ev, opts) => {
    try {
      if (!opts?.docId) return { error: 'docId required' };
      const googleRoutes = require('./google-routes');
      if (opts.out && googleRoutes.isHomedirPathSafe && !googleRoutes.isHomedirPathSafe(opts.out)) return { error: 'out blocked by path validation' };
      return await googleApi.exportDoc(opts.docId, opts);
    } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('google-contacts-list', async (_ev, opts) => {
    try { return await googleApi.listContacts(opts?.query); }
    catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-contacts-create', async (_ev, opts) => {
    try {
      if (!opts?.name) return { error: 'name required' };
      const r = await googleApi.createContact(opts.name, opts.phone, opts.email);
      try { auditLog('google_contacts_create', { name: opts.name }); } catch {}
      return r;
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-tasks-list', async (_ev, opts) => {
    try { return await googleApi.listTasks(opts?.listId); }
    catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-tasks-lists', async (_ev, opts) => {
    try { return await googleApi.listTaskLists(opts?.max); }
    catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-tasks-create', async (_ev, opts) => {
    try {
      if (!opts?.title) return { error: 'title required' };
      const r = await googleApi.createTask(opts.title, opts.due, opts.listId);
      try { auditLog('google_tasks_create', { title: opts.title }); } catch {}
      return r;
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-tasks-complete', async (_ev, opts) => {
    try {
      if (!opts?.taskId) return { error: 'taskId required' };
      const r = await googleApi.completeTask(opts.taskId, opts.listId);
      try { auditLog('google_tasks_complete', { taskId: opts.taskId }); } catch {}
      return r;
    } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('google-sheets-metadata', async (_ev, opts) => {
    try {
      if (!opts?.spreadsheetId) return { error: 'spreadsheetId required' };
      return await googleApi.getSheetMetadata(opts.spreadsheetId);
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-sheets-list', async (_ev, opts) => {
    try { return await googleApi.listSheets(opts?.max); }
    catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-sheets-get', async (_ev, opts) => {
    try {
      if (!opts?.spreadsheetId || !opts?.range) return { error: 'spreadsheetId and range required' };
      return await googleApi.getSheet(opts.spreadsheetId, opts.range, opts);
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-sheets-update', async (_ev, opts) => {
    try {
      if (!opts?.spreadsheetId || !opts?.range) return { error: 'spreadsheetId and range required' };
      const r = await googleApi.updateSheet(opts.spreadsheetId, opts.range, opts.values, opts);
      try { auditLog('google_sheets_update', { spreadsheetId: opts.spreadsheetId, range: opts.range }); } catch {}
      return r;
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-sheets-append', async (_ev, opts) => {
    try {
      if (!opts?.spreadsheetId || !opts?.range) return { error: 'spreadsheetId and range required' };
      const r = await googleApi.appendSheet(opts.spreadsheetId, opts.range, opts.values, opts);
      try { auditLog('google_sheets_append', { spreadsheetId: opts.spreadsheetId, range: opts.range }); } catch {}
      return r;
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-appscript-run', async (_ev, opts) => {
    try {
      if (!opts?.scriptId || !opts?.functionName) return { error: 'scriptId and functionName required' };
      const r = await googleApi.runAppScript(opts.scriptId, opts.functionName, opts.params, opts.devMode);
      try { auditLog('google_appscript_run', { scriptId: opts.scriptId, functionName: opts.functionName }); } catch {}
      return r;
    } catch (e) { return { error: e.message }; }
  });

} // end registerAllIpcHandlers

module.exports = { registerAllIpcHandlers };
