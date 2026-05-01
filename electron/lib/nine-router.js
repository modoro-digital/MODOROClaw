'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ctx = require('./context');
const { appDataDir, getBundledVendorDir, getBundledNodeBin, findNodeBin, findGlobalPackageFile } = require('./boot');

// Late-binding for killPort (still lives in main.js; used by gateway too)
let _killPortFn = () => {};
function setKillPort(fn) { _killPortFn = fn; }

// =========================================================================
// Private state
// =========================================================================

let routerProcess = null;

let _routerLogFd = null;

const PROVIDER_KEYS_PATH = () => path.join(appDataDir(), 'modoroclaw-provider-keys.json');

let _9routerSqliteFixAttempted = false;

function send9RouterAlert(text) {
  try {
    const { sendCeoAlert } = require('./channels');
    sendCeoAlert(text).catch((e) => {
      console.error('[9router] CEO alert failed:', e?.message);
    });
  } catch (e) {
    console.error('[9router] CEO alert unavailable:', e?.message);
  }
}

// =========================================================================
// Getter for routerProcess (external code may check if 9Router is running)
// =========================================================================

function getRouterProcess() { return routerProcess; }

// =========================================================================
// Functions
// =========================================================================

// Strip any stored password from 9Router's settings store so the default
// "123456" login always works. 9Router's /api/auth/login uses
// `getSettings().password` if present, falling back to env INITIAL_PASSWORD.
// If a previous run accidentally set a hashed password (or settings file
// got corrupted), the CEO can no longer log in. Idempotent: only writes
// when a non-null password field is present.
function ensure9RouterDefaultPassword() {
  try {
    const dbPath = path.join(appDataDir(), '9router', 'db.json');
    if (!fs.existsSync(dbPath)) return;
    const raw = fs.readFileSync(dbPath, 'utf-8');
    const db = JSON.parse(raw);
    let changed = false;
    if (db.settings && db.settings.password) {
      delete db.settings.password;
      changed = true;
    }
    // Some 9Router builds store password at top level
    if (db.password) { delete db.password; changed = true; }
    if (changed) {
      fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf-8');
      console.log('[9router] Cleared stored password — login uses default 123456');
    }
  } catch (e) { console.error('[9router] ensure default password error:', e.message); }
}

// 9Router GET /api/providers strips apiKey from response (security design).
// Problem: 9Router UI reads from API → shows empty apiKey field → CEO saves → key wiped.
// Fix: save provider keys in our own file, re-inject into 9Router db.json on every startup.

function saveProviderKey(provider, apiKey) {
  try {
    const p = PROVIDER_KEYS_PATH();
    let keys = {};
    if (fs.existsSync(p)) keys = JSON.parse(fs.readFileSync(p, 'utf-8'));
    keys[provider] = apiKey;
    fs.writeFileSync(p, JSON.stringify(keys, null, 2), 'utf-8');
  } catch (e) { console.warn('[provider-keys] save error:', e.message); }
}

function ensure9RouterProviderKeys() {
  try {
    const dbPath = path.join(appDataDir(), '9router', 'db.json');
    const keysPath = PROVIDER_KEYS_PATH();
    if (!fs.existsSync(dbPath) || !fs.existsSync(keysPath)) return;
    const db = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
    const savedKeys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
    const providers = db.providers || db.providerConnections || [];
    let changed = false;
    for (const p of providers) {
      const savedKey = savedKeys[p.provider];
      if (savedKey && (!p.apiKey || p.apiKey.length < 10)) {
        console.log('[9router] Re-injecting apiKey for provider:', p.name);
        p.apiKey = savedKey;
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf-8');
      console.log('[9router] Provider keys re-injected into db.json');
    }
  } catch (e) { console.error('[9router] ensure provider keys error:', e.message); }
}

function start9Router() {
  if (routerProcess) return;
  try {
    // Kill any foreign process occupying port 20128 before spawning ours.
    // A pre-installed global 9Router (from manual install) squats on the port →
    // our spawn fails EADDRINUSE → waitFor9RouterReady sees the foreign process
    // respond 200 → gateway routes through wrong 9Router → 401 on first chat.
    try { _killPortFn(20128); } catch {}

    ensure9RouterDefaultPassword();
    ensure9RouterProviderKeys();
    const logsDir = path.join(ctx.userDataDir, 'logs');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    _routerLogFd = fs.openSync(path.join(logsDir, '9router.log'), 'a');

    // Spawn node directly with the JS entrypoint when we can resolve it.
    // This avoids PATH lookups (a real concern on Mac when Electron is launched
    // from Finder and inherits a minimal PATH that misses brew/nvm bin dirs).
    // Use findGlobalPackageFile so we search ALL Node-manager lib dirs — not
    // just the first existing one — because users with mixed setups (e.g.
    // nvm-windows + system Node) can have 9router installed in a different
    // lib dir than the one npmGlobalModules() returns first.
    const routerScript = findGlobalPackageFile('9router', 'cli.js');
    let routerCmd, routerArgs, routerSpawnOpts;
    if (routerScript) {
      // Resolve absolute node path so spawn doesn't depend on PATH at all.
      const nodeBin = findNodeBin() || 'node';
      routerCmd = nodeBin;
      routerArgs = [routerScript, '-n', '--skip-update'];
      routerSpawnOpts = { shell: false };
    } else {
      // Fallback: PATH lookup via shell shim. On Windows we need `9router.cmd`
      // AND shell:true (otherwise spawn ENOENT — only `node.exe`/`*.exe` can be
      // spawned without shell). On Mac/Linux PATH-augmented `9router` works
      // with shell:false. If 9router isn't installed at all, we skip silently
      // — 9router is optional, the CEO can use the app without it.
      const isWin = process.platform === 'win32';
      const probe = isWin ? '9router.cmd' : '9router';
      // Quick PATH probe so we fail-fast instead of escaping a spawn ENOENT
      // out of the try/catch (spawn errors are async — they'd kill the main
      // process via the unhandled 'error' event before our catch ever runs).
      let inPath = false;
      try {
        require('child_process').execSync(
          isWin ? `where ${probe}` : `command -v ${probe}`,
          { stdio: 'ignore', timeout: 3000, shell: !isWin }
        );
        inPath = true;
      } catch {}
      if (!inPath) {
        console.log('[9router] not installed (skipping start). The 9Router tab in Dashboard will be empty but the bot still works.');
        if (_routerLogFd !== null) { try { fs.closeSync(_routerLogFd); } catch {} _routerLogFd = null; }
        return;
      }
      routerCmd = probe;
      routerArgs = ['-n', '--skip-update'];
      routerSpawnOpts = { shell: isWin };
    }
    // Pin 9Router auth so the login form always accepts "123456" and the JWT
    // cookie stays valid across restarts. Without these env vars 9Router falls
    // back to its compiled defaults — but JWT_SECRET also defaults to a fixed
    // string, and INITIAL_PASSWORD defaults to "123456". The CEO-reported login
    // failure is usually because a previous run wrote a custom hashed password
    // into 9Router's settings store, so the literal "123456" stops working.
    // Pinning INITIAL_PASSWORD here is harmless when no stored password exists,
    // and pinning JWT_SECRET makes auth cookies survive Electron restarts.
    const routerEnv = {
      ...process.env,
      INITIAL_PASSWORD: process.env.INITIAL_PASSWORD || '123456',
      JWT_SECRET: process.env.JWT_SECRET || 'modoroclaw-9router-jwt-secret-stable-v1',
    };
    const thisFd = _routerLogFd;
    routerProcess = spawn(routerCmd, routerArgs, {
      stdio: ['ignore', thisFd, thisFd],
      detached: true,
      windowsHide: true,
      env: routerEnv,
      ...routerSpawnOpts,
    });
    // CRITICAL: register the 'error' listener BEFORE any other event so an
    // ENOENT (binary not found) doesn't bubble up as an uncaught exception
    // and crash the entire main process with a JS error dialog. spawn errors
    // are async — they fire after this function's try/catch has already
    // returned. Without this listener, ENOENT kills MODOROClaw on launch
    // when 9router is missing/misconfigured.
    routerProcess.on('error', (err) => {
      console.error('[9router] spawn error:', err.message);
      send9RouterAlert(`9Router không khởi động được. Mở Dashboard kiểm tra tab AI Models giúp em ạ. Lý do: ${err.message}`);
      if (thisFd !== null) { try { fs.closeSync(thisFd); } catch {} }
      if (_routerLogFd === thisFd) _routerLogFd = null;
      routerProcess = null;
    });
    routerProcess.unref();
    routerProcess.on('exit', (code, signal) => {
      routerProcess = null;
      if (thisFd !== null) { try { fs.closeSync(thisFd); } catch {} }
      if (_routerLogFd === thisFd) _routerLogFd = null;
      if (!ctx.appIsQuitting && code !== 0 && code !== null) {
        send9RouterAlert(`9Router đã dừng bất thường. Mở Dashboard kiểm tra tab AI Models giúp em ạ. Mã lỗi: ${code}${signal ? `, tín hiệu: ${signal}` : ''}.`);
      }
    });
    console.log('9Router started (log: logs/9router.log)');
  } catch (e) {
    console.log('9Router start failed:', e.message);
    if (_routerLogFd !== null) { try { fs.closeSync(_routerLogFd); } catch {} _routerLogFd = null; }
    routerProcess = null;
  }
}

function stop9Router() {
  if (!routerProcess) return;
  const pid = routerProcess.pid;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', pid.toString(), '/f', '/t']);
    } else {
      // Mac/Linux: belt-and-braces process tree cleanup. The child Next.js server
      // is a grandchild — kill -pid (process group) is the cleanest approach but
      // RELIES on detached:true at spawn time creating a proper group. If anything
      // about that setup is fragile (which it has been on Mac in the past), the
      // grandchild becomes orphan and squats on port 20128 → next 9router start
      // fails with EADDRINUSE.
      //
      // Strategy: do BOTH process-group kill AND pkill IMMEDIATELY (not as
      // delayed fallback). Use SIGTERM first to allow graceful shutdown, then
      // SIGKILL after 1.5s for anything still alive. Final pkill on
      // server.js as the safety net catches any orphan from previous runs too.
      try { process.kill(-pid, 'SIGTERM'); } catch {}
      try { routerProcess.kill('SIGTERM'); } catch {}
      // Immediate pkill — primary, not fallback
      try {
        require('child_process').execSync(
          'pkill -TERM -f "9router/(app/server.js|cli\\.js)" 2>/dev/null || true',
          { stdio: 'ignore', timeout: 3000, shell: '/bin/sh' }
        );
      } catch {}
      // SIGKILL escalation if still alive after grace period
      setTimeout(() => {
        try { process.kill(-pid, 'SIGKILL'); } catch {}
        try {
          require('child_process').execSync(
            'pkill -KILL -f "9router/(app/server.js|cli\\.js)" 2>/dev/null || true',
            { stdio: 'ignore', timeout: 3000, shell: '/bin/sh' }
          );
        } catch {}
      }, 1500);
    }
  } catch {}
  routerProcess = null;
}

// Auto-setup 9Router: write db.json directly (most reliable), then restart
// Direct Ollama Cloud API key validation. Calls Ollama's own API (not via
// 9router proxy) so we can fail-fast with a CLEAR error message before
// writing the key to db.json + restarting 9router (which takes ~15s).
//
// Endpoint: https://ollama.com/api/ps — list running processes, USER-SCOPED
// (requires auth). We picked this specifically because:
//   - /api/tags is PUBLIC (returns global model catalog regardless of key)
//   - /v1/models is PUBLIC (same)
//   - /api/version is PUBLIC
//   - /api/ps returns 401 for missing or invalid key, 200 with JSON
//     (possibly empty array) for valid key. Verified by curling with
//     empty Bearer + fake Bearer — both got 401. A real key would get 200.
//
// Failure modes:
//   - 401/403 → invalid or expired key
//   - 200 but non-JSON → captive portal returning HTML
//   - 5xx → ollama outage
//   - Network errors → no internet, DNS, firewall
//   - Timeout (10s) → slow connection
async function validateOllamaKeyDirect(apiKey) {
  return new Promise((resolve) => {
    const https = require('https');
    const req = https.request({
      hostname: 'ollama.com',
      port: 443,
      path: '/api/ps',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
        'User-Agent': '9BizClaw-Wizard/1.0',
      },
      timeout: 10000,
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          // Parse to verify it's actually JSON (defensive — captive portal
          // might return 200 with HTML login page)
          try {
            const parsed = JSON.parse(buf);
            // /api/ps returns { models: [...] } (running processes). Empty
            // array is fine — means key valid but no active processes.
            // Just verify we got an object.
            if (parsed && typeof parsed === 'object') {
              resolve({ valid: true, statusCode: 200, raw: parsed });
            } else {
              resolve({
                valid: false,
                statusCode: 200,
                error: 'Phản hồi từ Ollama không đúng định dạng — có thể đang ở mạng captive portal (Wi-Fi khách sạn / quán cafe). Thử lại với mạng khác.',
              });
            }
          } catch {
            resolve({
              valid: false,
              statusCode: 200,
              error: 'Phản hồi từ Ollama không phải JSON — có thể đang ở mạng captive portal (Wi-Fi khách sạn / quán cafe). Thử lại với mạng khác.',
            });
          }
        } else if (res.statusCode === 401 || res.statusCode === 403) {
          resolve({
            valid: false,
            statusCode: res.statusCode,
            error: 'Ollama API key sai hoặc đã hết hạn. Vào ollama.com/settings/keys → tạo key mới → paste lại.',
          });
        } else if (res.statusCode === 429) {
          resolve({
            valid: false,
            statusCode: 429,
            error: 'Ollama trả về 429 (rate limit). Đợi 1 phút rồi thử lại.',
          });
        } else if (res.statusCode >= 500) {
          resolve({
            valid: false,
            statusCode: res.statusCode,
            error: `Ollama đang gặp sự cố (HTTP ${res.statusCode}). Thử lại sau vài phút hoặc check status.ollama.com.`,
          });
        } else {
          resolve({
            valid: false,
            statusCode: res.statusCode,
            error: `Ollama trả về HTTP ${res.statusCode} — không xác định: ${buf.slice(0, 200)}`,
          });
        }
      });
    });
    req.on('error', (e) => {
      const msg = e?.message || String(e);
      if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) {
        resolve({ valid: false, error: 'Không kết nối được ollama.com — kiểm tra mạng Internet.' });
      } else if (/ECONNREFUSED|ECONNRESET/i.test(msg)) {
        resolve({ valid: false, error: 'Kết nối tới ollama.com bị từ chối — có thể firewall hoặc proxy chặn.' });
      } else if (/CERT|SSL|TLS/i.test(msg)) {
        resolve({ valid: false, error: 'Lỗi chứng chỉ SSL — máy có thể có MITM/antivirus chặn HTTPS.' });
      } else {
        resolve({ valid: false, error: 'Lỗi mạng: ' + msg });
      }
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ valid: false, error: 'Timeout kết nối ollama.com (>10s) — mạng chậm hoặc bị chặn.' });
    });
    req.end();
  });
}

// Generic 9router HTTP API caller. Localhost-only, no auth needed (9router
// /api/* is bound to 127.0.0.1 and doesn't require auth — only /v1/* needs
// the Bearer API key). Returns { success, data, error, statusCode }.
function nineRouterApi(method, path, body = null, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const http = require('http');
    const headers = { 'Content-Type': 'application/json' };
    let bodyStr = null;
    if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      bodyStr = JSON.stringify(body);
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const req = http.request({
      hostname: '127.0.0.1', port: 20128, path, method, headers, timeout: timeoutMs,
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = buf ? JSON.parse(buf) : {}; }
        catch { parsed = { _raw: buf.slice(0, 200) }; }
        if (res.statusCode >= 400 || (parsed && parsed.error)) {
          resolve({
            success: false,
            statusCode: res.statusCode,
            error: parsed?.error || `HTTP ${res.statusCode}`,
            data: parsed,
          });
        } else {
          resolve({ success: true, statusCode: res.statusCode, data: parsed });
        }
      });
    });
    req.on('error', (e) => resolve({ success: false, error: 'Network: ' + e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'Timeout (>' + timeoutMs + 'ms)' }); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Runtime self-heal for 9router's bundled better-sqlite3 binary.
// Mirrors the build-time fixNineRouterNativeModules() in prebuild-vendor.js, but
// runs inside the packaged app when the binary ships with the wrong arch (e.g.
// x64 binary on arm64 Mac, or vice versa). Runs at most once per process lifetime.
async function autoFix9RouterSqlite() {
  if (_9routerSqliteFixAttempted) return false;
  _9routerSqliteFixAttempted = true;
  try {
    const vendorDir = getBundledVendorDir();
    if (!vendorDir) {
      console.warn('[9router-autofix] not packaged — skipping');
      return false;
    }
    const bsqlDir = path.join(vendorDir, 'node_modules', '9router', 'app', 'node_modules', 'better-sqlite3');
    if (!fs.existsSync(bsqlDir)) {
      console.warn('[9router-autofix] better-sqlite3 dir not found:', bsqlDir);
      return false;
    }
    const nodeBin = getBundledNodeBin();
    if (!nodeBin) {
      console.warn('[9router-autofix] bundled node binary not found');
      return false;
    }
    // Get version of the BUNDLED Node (not Electron's embedded Node)
    let nodeVer;
    try {
      nodeVer = require('child_process')
        .execFileSync(nodeBin, ['--version'], { encoding: 'utf-8', timeout: 5000 })
        .trim().replace(/^v/, '');
    } catch (e) {
      console.warn('[9router-autofix] could not get bundled node version:', e.message);
      return false;
    }
    const arch = process.arch; // 'arm64' or 'x64'
    const platform = process.platform;
    console.log(`[9router-autofix] rebuilding better-sqlite3 for node-${nodeVer} ${platform}-${arch}`);
    const { execFileSync } = require('child_process');
    const bsqlBin = path.join(bsqlDir, 'build', 'Release', 'better_sqlite3.node');
    // Strategy 1: prebuild-install from 9router's own .bin dir (fastest — prebuilt binary)
    const prebuildBin = path.join(bsqlDir, '..', '.bin', 'prebuild-install');
    if (fs.existsSync(prebuildBin)) {
      try {
        execFileSync(nodeBin, [prebuildBin, '-r', 'node', '-t', nodeVer, '--arch', arch], {
          cwd: bsqlDir, timeout: 60000, shell: false,
          env: { ...process.env, npm_config_arch: arch },
        });
        if (fs.existsSync(bsqlBin)) {
          console.log('[9router-autofix] ✓ rebuilt via prebuild-install');
          return true;
        }
      } catch (e) {
        console.warn('[9router-autofix] prebuild-install failed:', e.message);
      }
    }
    // Strategy 2: node-pre-gyp from 9router's .bin dir
    const nodePreGyp = path.join(bsqlDir, '..', '.bin', 'node-pre-gyp');
    if (fs.existsSync(nodePreGyp)) {
      try {
        execFileSync(nodeBin, [nodePreGyp, 'rebuild', `--target=${nodeVer}`, `--target_arch=${arch}`], {
          cwd: bsqlDir, timeout: 120000, shell: false,
        });
        if (fs.existsSync(bsqlBin)) {
          console.log('[9router-autofix] ✓ rebuilt via node-pre-gyp');
          return true;
        }
      } catch (e) {
        console.warn('[9router-autofix] node-pre-gyp failed:', e.message);
      }
    }
    // Strategy 3: npx prebuild-install — downloads prebuild-install if not in .bin.
    // This handles 9router versions that don't ship prebuild-install as a dep.
    const npxBin = path.join(path.dirname(nodeBin), 'npx');
    if (fs.existsSync(npxBin)) {
      try {
        console.log('[9router-autofix] trying npx prebuild-install...');
        execFileSync(npxBin, ['--yes', 'prebuild-install', '-r', 'node', '-t', nodeVer, '--arch', arch], {
          cwd: bsqlDir, timeout: 90000, shell: false,
          env: { ...process.env, npm_config_arch: arch },
        });
        if (fs.existsSync(bsqlBin)) {
          console.log('[9router-autofix] ✓ rebuilt via npx prebuild-install');
          return true;
        }
      } catch (e) {
        console.warn('[9router-autofix] npx prebuild-install failed:', e.message);
      }
    }
    // Strategy 4: npm rebuild from the 9router app dir (compiles from source).
    // Needs Xcode CLT on Mac, but that's the last resort.
    const vendorDir2 = getBundledVendorDir();
    const npmBin = path.join(path.dirname(nodeBin), 'npm');
    if (vendorDir2 && fs.existsSync(npmBin)) {
      try {
        console.log('[9router-autofix] trying npm rebuild better-sqlite3...');
        execFileSync(npmBin, ['rebuild', 'better-sqlite3', `--arch=${arch}`], {
          cwd: path.join(vendorDir2, 'node_modules', '9router', 'app'),
          timeout: 180000, shell: false,
          env: { ...process.env, npm_config_arch: arch, npm_config_target: nodeVer, npm_config_runtime: 'node' },
        });
        if (fs.existsSync(bsqlBin)) {
          console.log('[9router-autofix] ✓ rebuilt via npm rebuild');
          return true;
        }
      } catch (e) {
        console.warn('[9router-autofix] npm rebuild failed:', e.message);
      }
    }
    console.warn('[9router-autofix] all 4 rebuild strategies failed — user needs reinstall');
    return false;
  } catch (e) {
    console.error('[9router-autofix] unexpected error:', e.message);
    return false;
  }
}

// Wait for 9router to be reachable. Polls /api/settings every 500ms up to maxMs.
// Returns { ready: true } on success, or { ready: false, reason: '...' } on timeout.
// Distinguishes between "never started" (ECONNREFUSED) vs "started but 5xx" (native
// module crash — e.g. better-sqlite3 arch mismatch on Mac).
async function waitFor9RouterReady(maxMs = 10000) {
  const start = Date.now();
  let consecutiveFiveXx = 0;
  while (Date.now() - start < maxMs) {
    const r = await nineRouterApi('GET', '/api/settings', null, 1500);
    if (r.success || (r.statusCode && r.statusCode < 500)) return true;
    if (r.statusCode && r.statusCode >= 500) {
      consecutiveFiveXx++;
      // 3 consecutive 5xx while process IS accepting connections = internal crash
      // (e.g. better-sqlite3 native module arch mismatch). No point waiting longer.
      if (consecutiveFiveXx >= 3) {
        console.warn('[waitFor9RouterReady] 9router accepting connections but returning 5xx consistently — likely native module crash');
        return false;
      }
    } else {
      consecutiveFiveXx = 0; // reset on ECONNREFUSED / timeout
    }
    await new Promise(res => setTimeout(res, 500));
  }
  return false;
}

// Shared 9Router LLM call helper. Returns response text or null on failure.
// Reuses CEO's configured 9Router provider from openclaw.json.
// timeoutMs: per-call timeout (default 8s). maxTokens: response cap.
// Model resolution order (NEVER hardcode):
//   1. agents.defaults.model from openclaw.json (e.g. 'ninerouter/auto') → strip prefix
//   2. First model id in models.providers.ninerouter.models[]
//   3. Literal 'auto' — 9router treats this as "use first available combo"
async function call9Router(prompt, { maxTokens = 200, temperature = 0.3, timeoutMs = 8000 } = {}) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(ctx.HOME, '.openclaw', 'openclaw.json'), 'utf-8'));
    const provider = config?.models?.providers?.ninerouter;
    if (!provider?.baseUrl || !provider?.apiKey) return null;
    let modelName = 'auto';
    try {
      const def = config?.agents?.defaults?.model;
      if (typeof def === 'string' && def.length > 0) {
        modelName = def.replace(/^ninerouter\//, '');
      } else if (Array.isArray(provider?.models) && provider.models[0]?.id) {
        modelName = provider.models[0].id;
      }
    } catch {}
    const http = require('http');
    const body = JSON.stringify({
      model: modelName,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature,
    });
    const url = new URL(provider.baseUrl + '/chat/completions');
    return await new Promise((resolve) => {
      const req = http.request({
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${provider.apiKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const text = parsed?.choices?.[0]?.message?.content?.trim();
            resolve(text || null);
          } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(body);
      req.end();
    });
  } catch { return null; }
}

function format9RouterVisionError(statusCode, responseBody) {
  let providerMessage = String(responseBody || '').trim();
  try {
    const parsed = JSON.parse(providerMessage);
    providerMessage = parsed?.error?.message || parsed?.message || providerMessage;
  } catch {}
  const msg = providerMessage || `HTTP ${statusCode}`;
  if (/429|weekly usage limit|rate/i.test(msg)) {
    return `9Router/model vision báo lỗi 429: tài khoản hoặc model đã hết hạn mức sử dụng. Chi tiết gốc: ${msg}`;
  }
  if (/401|invalidated|unauthor/i.test(msg)) {
    return `9Router/model vision báo lỗi xác thực: token hoặc API key không còn hợp lệ. Chi tiết gốc: ${msg}`;
  }
  if (/tool choice|tool_choice/i.test(msg)) {
    return `9Router/model vision báo lỗi cấu hình tool_choice. Chi tiết gốc: ${msg}`;
  }
  if (/does not represent a valid image|valid image/i.test(msg)) {
    return `9Router/model vision báo lỗi ảnh không hợp lệ: dữ liệu ảnh gửi lên không đọc được. Chi tiết gốc: ${msg}`;
  }
  return `9Router/model vision trả lỗi HTTP ${statusCode}. Chi tiết gốc: ${msg}`;
}

// Vision-capable 9Router call: sends image as base64 alongside a text prompt.
// Returns response text or null on failure. Set throwOnError to surface a
// Vietnamese, provider-specific error to the Dashboard.
async function call9RouterVision(imagePath, prompt, { maxTokens = 1500, temperature = 0.2, timeoutMs = 30000, throwOnError = false } = {}) {
  try {
    const stat = fs.statSync(imagePath);
    if (stat.size > 20 * 1024 * 1024) {
      if (throwOnError) throw new Error('Ảnh quá lớn để gửi cho model vision. Giới hạn hiện tại là 20MB mỗi ảnh.');
      return null;
    }

    const config = JSON.parse(fs.readFileSync(path.join(ctx.HOME, '.openclaw', 'openclaw.json'), 'utf-8'));
    const provider = config?.models?.providers?.ninerouter;
    if (!provider?.baseUrl || !provider?.apiKey) {
      if (throwOnError) throw new Error('Chưa cấu hình 9Router/API key cho model vision.');
      return null;
    }
    let modelName = 'auto';
    try {
      const def = config?.agents?.defaults?.model;
      if (typeof def === 'string' && def.length > 0) {
        modelName = def.replace(/^ninerouter\//, '');
      } else if (Array.isArray(provider?.models) && provider.models[0]?.id) {
        modelName = provider.models[0].id;
      }
    } catch {}

    const ext = path.extname(imagePath).toLowerCase();
    const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
    const mime = mimeMap[ext] || 'image/jpeg';
    const base64 = fs.readFileSync(imagePath).toString('base64');

    const http = require('http');
    const body = JSON.stringify({
      model: modelName,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}`, detail: 'high' } },
        ],
      }],
      max_tokens: maxTokens,
      temperature,
    });
    const url = new URL(provider.baseUrl + '/chat/completions');
    return await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${provider.apiKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (res.statusCode !== 200) {
            console.error('[call9RouterVision] HTTP ' + res.statusCode + ': ' + data.substring(0, 200));
            if (throwOnError) {
              reject(new Error(format9RouterVisionError(res.statusCode, data)));
              return;
            }
            resolve(null);
            return;
          }
          try {
            const parsed = JSON.parse(data);
            const text = parsed?.choices?.[0]?.message?.content?.trim();
            resolve(text || null);
          } catch { resolve(null); }
        });
      });
      req.on('error', (error) => {
        if (throwOnError) reject(new Error(`Không kết nối được 9Router/model vision: ${error.message}`));
        else resolve(null);
      });
      req.on('timeout', () => {
        req.destroy();
        if (throwOnError) reject(new Error(`Model vision phản hồi quá lâu sau ${Math.round(timeoutMs / 1000)} giây.`));
        else resolve(null);
      });
      req.write(body);
      req.end();
    });
  } catch (error) {
    if (throwOnError) throw error;
    return null;
  }
}

// Detect whether 9Router is configured with a ChatGPT Plus OAuth provider.
// Used by wizard-complete to pre-fill the rewrite-model dropdown:
// OAuth = 'ninerouter/main' (ChatGPT Plus included, cheap), else 'ninerouter/fast'.
async function detectChatgptPlusOAuth() {
  try {
    // 9router db.json path: use appDataDir() to match how 9router actually
    // stores it on each platform (Win: %APPDATA%/9router/, Mac: Application
    // Support/9router/, Linux: ~/.config/9router/). Previous `HOME/.9router/`
    // was wrong — existsSync always false → every install defaults to 'fast'
    // even for ChatGPT Plus OAuth users (bug flagged by code quality review).
    const dbPath = path.join(appDataDir(), '9router', 'db.json');
    if (!fs.existsSync(dbPath)) return false;
    const cfg = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
    const providers = cfg?.providers || [];
    return providers.some(p =>
      String(p.type || p.kind || '').toLowerCase().includes('oauth') ||
      String(p.label || '').toLowerCase().includes('chatgpt plus')
    );
  } catch { return false; }
}

module.exports = {
  ensure9RouterDefaultPassword, saveProviderKey, ensure9RouterProviderKeys,
  start9Router, stop9Router, nineRouterApi, autoFix9RouterSqlite,
  waitFor9RouterReady, validateOllamaKeyDirect,
  call9Router, call9RouterVision, detectChatgptPlusOAuth,
  format9RouterVisionError,
  getRouterProcess, setKillPort,
};
