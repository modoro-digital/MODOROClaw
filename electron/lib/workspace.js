'use strict';
const fs = require('fs');
const path = require('path');
const ctx = require('./context');
const { writeJsonAtomic } = require('./util');

let app;
try { app = require('electron').app; } catch {}

// --- Private state ---
let _workspaceCached = null;
let _appPackaged = null;
let _compilePersonaMixFn = null;

function setCompilePersonaMix(fn) { _compilePersonaMixFn = fn; }

// ─── Constants ───────────────────────────────────────────────────
const BRAND_ASSET_FORMATS = ['.png', '.jpg', '.jpeg', '.webp'];
const BRAND_ASSET_MAX_SIZE = 10 * 1024 * 1024; // 10MB

// Default schedules (also used as template when seeding fresh install)
const DEFAULT_SCHEDULES_JSON = [
  // `icon` legacy field kept empty — Dashboard uses lucide icons via SCHEDULE_ICON_MAP, not emoji.
  { id: 'morning', label: 'Báo cáo sáng', time: '07:30', enabled: true, icon: '', description: 'Doanh thu, lịch họp, việc cần xử lý' },
  { id: 'evening', label: 'Tóm tắt cuối ngày', time: '21:00', enabled: true, icon: '', description: 'Kết quả ngày, vấn đề tồn đọng' },
  // heartbeat removed — fast watchdog (gateway.js, 20s interval) is strictly superior
  { id: 'meditation', label: 'Tối ưu ban đêm', time: '01:00', enabled: true, icon: '', description: 'Bot tự review bài học, tối ưu bộ nhớ' },
  { id: 'weekly', label: 'Báo cáo tuần', time: '08:00', enabled: true, icon: '', description: 'Tổng kết tuần, khách mới, ưu tiên tuần tới' },
  { id: 'monthly', label: 'Báo cáo tháng', time: '08:30', enabled: true, icon: '', description: 'Tổng kết tháng, trend, kế hoạch tháng tới' },
  { id: 'zalo-followup', label: 'Follow-up khách Zalo', time: '09:30', enabled: true, icon: '', description: 'Nhắc CEO khách mới chưa tương tác, khách hỏi chưa reply' },
  { id: 'memory-cleanup', label: 'Dọn dẹp memory', time: '02:00', enabled: false, icon: '', description: 'Tổng hợp journal cũ, dọn dẹp memory rời rạc' },
];

// --- AGENTS.md versioning (private) ---
const CURRENT_AGENTS_MD_VERSION = 98;
const AGENTS_MD_VERSION_RE = /<!--\s*modoroclaw-agents-version:\s*(\d+)\s*-->/;

// ─── User data dir (Electron/APPDATA level) ─────────────────────
function getUserDataDir() {
  if (app && app.isPackaged) {
    return app.getPath('userData');
  }
  const home = process.env.HOME || process.env.USERPROFILE || '';
  for (const dir of [path.join(home, '9bizclaw'), path.join(home, '.openclaw')]) {
    try {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) return dir;
    } catch {}
  }
  return path.join(home, '9bizclaw');
}

// ─── Recursive dir copy ─────────────────────────────────────────
function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ─── Core workspace path ─────────────────────────────────────────
function getWorkspace() {
  if (_workspaceCached) return _workspaceCached;
  // Detect packaged at runtime (app may not be ready yet during early calls)
  let packaged = false;
  try { packaged = (_appPackaged === null) ? !!(app && app.isPackaged) : _appPackaged; } catch {}
  if (packaged) {
    // Packaged: use userData (NSIS-safe). ctx.userDataDir is set in app.whenReady()
    // to app.getPath('userData'). Until that runs, fall back to a sensible default.
    _appPackaged = true;
    if (ctx.userDataDir && ctx.userDataDir !== ctx.resourceDir) {
      _workspaceCached = ctx.userDataDir;
    } else {
      // app.whenReady hasn't fired yet — compute manually so early seedWorkspace
      // calls (e.g. from bootDiagRunFullCheck) get the right path.
      // CRITICAL: dir name must match Electron's app.getName() which reads
      // the package.json `name` field ("9bizclaw", lowercase). NOT
      // build.productName ("MODOROClaw") — that's electron-builder installer
      // metadata, not Electron runtime. Mismatch creates a phantom capital
      // dir that some code paths write to while real workspace is lowercase.
      const HOMETMP = process.env.USERPROFILE || process.env.HOME || '';
      const APP_DIR = '9bizclaw';
      if (process.platform === 'win32') {
        _workspaceCached = path.join(process.env.APPDATA || path.join(HOMETMP, 'AppData', 'Roaming'), APP_DIR);
      } else if (process.platform === 'darwin') {
        _workspaceCached = path.join(HOMETMP, 'Library', 'Application Support', APP_DIR);
      } else {
        _workspaceCached = path.join(process.env.XDG_CONFIG_HOME || path.join(HOMETMP, '.config'), APP_DIR);
      }
    }
    try { fs.mkdirSync(_workspaceCached, { recursive: true }); } catch {}
    try {
      const { guardWritable } = require('./preflight');
      guardWritable('getWorkspace', _workspaceCached);
    } catch (e) {
      console.warn('[getWorkspace] guard failed:', e.message);
    }
    return _workspaceCached;
  }
  // Dev mode: use source dir if writable
  try {
    fs.accessSync(ctx.resourceDir, fs.constants.W_OK);
    _workspaceCached = ctx.resourceDir;
  } catch {
    _workspaceCached = ctx.userDataDir;
  }
  try {
    const { guardWritable } = require('./preflight');
    guardWritable('getWorkspace', _workspaceCached);
  } catch (e) {
    console.warn('[getWorkspace] guard failed:', e.message);
  }
  return _workspaceCached;
}

function invalidateWorkspaceCache() { _workspaceCached = null; _appPackaged = null; }
function _setWorkspaceCacheForTest(wsPath) { _workspaceCached = wsPath; }

function purgeAgentSessions(caller) {
  try {
    const sessDir = path.join(ctx.HOME, '.openclaw', 'agents', 'main', 'sessions');
    if (!fs.existsSync(sessDir)) return 0;
    const staleFiles = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'));
    for (const sf of staleFiles) {
      try { fs.unlinkSync(path.join(sessDir, sf)); } catch {}
    }
    const idxFile = path.join(sessDir, 'sessions.json');
    if (fs.existsSync(idxFile)) { try { fs.unlinkSync(idxFile); } catch {} }
    if (staleFiles.length > 0) console.log(`[${caller}] purged ${staleFiles.length} stale session(s)`);
    return staleFiles.length;
  } catch (pe) {
    console.warn(`[${caller}] session purge failed:`, pe?.message || pe);
    return 0;
  }
}

// ─── Brand Assets ────────────────────────────────────────────────
function getBrandAssetsDir() { return path.join(getWorkspace(), 'brand-assets'); }
function getMediaAssetsDir() { return path.join(getWorkspace(), 'media-assets'); }

// ─── Facebook Config ────────────────────────────────────────────
function getFbConfigPath() { return path.join(getWorkspace(), 'fb-config.json'); }

function readFbConfig() {
  try {
    const raw = fs.readFileSync(getFbConfigPath(), 'utf-8');
    const cfg = JSON.parse(raw);
    if (cfg.accessToken) {
      try {
        const { safeStorage } = require('electron');
        if (safeStorage.isEncryptionAvailable()) {
          cfg.accessToken = safeStorage.decryptString(Buffer.from(cfg.accessToken, 'base64'));
        }
      } catch {}
    }
    return cfg;
  } catch { return null; }
}

function writeFbConfig(cfg) {
  const toWrite = { ...cfg };
  if (toWrite.accessToken) {
    try {
      const { safeStorage } = require('electron');
      if (safeStorage.isEncryptionAvailable()) {
        toWrite.accessToken = safeStorage.encryptString(toWrite.accessToken).toString('base64');
      } else {
        console.warn('[fb-config] safeStorage unavailable — storing token in plaintext');
      }
    } catch {}
  }
  fs.writeFileSync(getFbConfigPath(), JSON.stringify(toWrite, null, 2), 'utf-8');
}

// Seed templates from read-only bundle → writable workspace (packaged install)
// In dev mode (ctx.resourceDir writable), this just ensures runtime files exist.
// Resolve where workspace template files live for the CURRENT runtime mode.
//   - Dev (Electron run from source): templates live in `ctx.resourceDir` (Desktop/claw)
//   - Packaged (.app on Mac, NSIS on Windows): templates were copied to
//     `process.resourcesPath/workspace-templates/` by electron-builder's
//     `extraResources` config. Reading from app.asar would fail (asar is
//     read-only and the templates are NOT inside it — they're alongside it).
// Falls back to `ctx.resourceDir` if the packaged path doesn't exist (shouldn't
// happen in a correctly built bundle, but better than crashing).
function getWorkspaceTemplateRoot() {
  try {
    if (app && app.isPackaged) {
      const packaged = path.join(process.resourcesPath, 'workspace-templates');
      if (fs.existsSync(packaged)) return packaged;
    }
  } catch {}
  return ctx.resourceDir;
}

function getOpenclawAgentWorkspace() {
  try {
    const cfgPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
    if (!fs.existsSync(cfgPath)) return null;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    const ws = cfg && cfg.agents && cfg.agents.defaults && cfg.agents.defaults.workspace;
    if (typeof ws === 'string' && ws.trim()) {
      // path.resolve() promotes relative paths to absolute (defensive — in
      // practice openclaw always writes absolute paths, but a misconfigured
      // wizard or hand-edit could leave a relative path which would then
      // resolve against process.cwd() and silently split bot/Electron paths
      // again — the exact bug we just fixed).
      return path.resolve(ws.trim());
    }
    return null;
  } catch (e) {
    console.warn('[getOpenclawAgentWorkspace] read failed:', e && e.message ? e.message : String(e));
    return null;
  }
}

function seedWorkspace() {
  const ws = getWorkspace();
  try { fs.mkdirSync(ws, { recursive: true }); } catch {}

  // Stale tmp sweep (H8): writeJsonAtomic leaves `<name>.tmp.<pid>.<ms>.<n>`
  // files if the process crashed mid-rename or AV killed the rename outright.
  // Clean anything older than 5 minutes at boot. Non-fatal on error.
  try {
    const now = Date.now();
    const entries = fs.readdirSync(ws);
    for (const f of entries) {
      if (!/\.tmp\.\d+\.\d+(?:\.\d+)?$/.test(f)) continue;
      const full = path.join(ws, f);
      try {
        const st = fs.statSync(full);
        if (now - st.mtimeMs > 300000) {
          try { fs.unlinkSync(full); } catch {}
        }
      } catch {}
    }
  } catch {}

  const copyDirRecursive = (src, dst) => {
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const sp = path.join(src, entry.name), tp = path.join(dst, entry.name);
      if (entry.isDirectory()) copyDirRecursive(sp, tp);
      else if (!fs.existsSync(tp)) {
        try { fs.copyFileSync(sp, tp); } catch {}
      }
    }
  };

  let _agentsUpgraded = false;
  // BUG #2 FIX: AGENTS.md version-aware overwrite. Without this, users
  // upgrading from any prior version keep their stale AGENTS.md because
  // the copy logic below only writes when destination is missing. Means
  // new rules never reach runtime workspace on upgrade installs.
  //
  // Strategy: read existing AGENTS.md → parse version stamp → if older
  // than current, back up to .learnings/ and DELETE so the copy logic
  // below repopulates from template.
  const templateRoot = getWorkspaceTemplateRoot();
  const existingAgents = path.join(ws, 'AGENTS.md');
  if (ws !== templateRoot && fs.existsSync(existingAgents)) {
    try {
      const existingContent = fs.readFileSync(existingAgents, 'utf-8');
      const m = existingContent.match(AGENTS_MD_VERSION_RE);
      const existingVersion = m ? parseInt(m[1], 10) : 0;
      // Spoof guard: version suspiciously far ahead of template → treat as
      // stale/tampered and force overwrite. Prevents CEO (or anyone) from
      // accidentally editing the stamp higher and freezing the file forever.
      const spoofed = existingVersion > CURRENT_AGENTS_MD_VERSION + 10;
      if (existingVersion < CURRENT_AGENTS_MD_VERSION || spoofed) {
        try {
          backupWorkspace({
            force: true,
            reason: (spoofed ? 'pre-spoof-reset' : 'pre-template-upgrade')
              + '-v' + existingVersion + '-to-v' + CURRENT_AGENTS_MD_VERSION,
          });
        } catch (preBackupErr) {
          console.warn('[seedWorkspace] pre-upgrade backup failed:', preBackupErr && preBackupErr.message ? preBackupErr.message : String(preBackupErr));
        }
        // Back up the stale file to .learnings/ so any user-added custom
        // rules (or bot self-improvement promotions) survive the overwrite.
        try {
          const backupDir = path.join(ws, '.learnings');
          fs.mkdirSync(backupDir, { recursive: true });
          const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const backupName = 'AGENTS-backup-v' + existingVersion + '-' + ts + '.md';
          fs.writeFileSync(path.join(backupDir, backupName), existingContent, 'utf-8');
          const label = spoofed ? 'spoof-reset' : 'upgrade';
          console.log('[seedWorkspace] AGENTS.md ' + label + ' ' + existingVersion + ' → ' +
            CURRENT_AGENTS_MD_VERSION + ' (backup: .learnings/' + backupName + ')');
        } catch (be) {
          console.warn('[seedWorkspace] AGENTS.md backup failed:', be && be.message ? be.message : String(be));
          // Continue with overwrite anyway — the rule update is more
          // important than preserving the backup.
        }
        try { fs.unlinkSync(existingAgents); } catch {}
        // PIGGYBACK: when AGENTS.md upgrades, also force-overwrite other
        // template .md files that changed significantly. These don't have
        // their own version stamps, so they only get updated on AGENTS.md
        // version bumps. CEO customizations in these files are rare (they're
        // bot-internal, not user-facing), so overwriting is safe.
        const alsoOverwrite = ['BOOTSTRAP.md', 'SOUL.md', 'TOOLS.md', 'README.md'];
        // Force-refresh template-owned files in these dirs while preserving
        // any files the customer created (custom skills, prompts, etc.).
        // Strategy: walk the template dir, overwrite matching files in workspace,
        // but never delete workspace files that don't exist in the template.
        for (const dirName of ['tools', 'docs', 'skills', 'prompts']) {
          const tmplDir = path.join(templateRoot, dirName);
          const wsDir = path.join(ws, dirName);
          if (!fs.existsSync(tmplDir)) continue;
          let refreshed = 0;
          const walkAndRefresh = (rel) => {
            const srcDir = path.join(tmplDir, rel);
            const dstDir = path.join(wsDir, rel);
            try { fs.mkdirSync(dstDir, { recursive: true }); } catch {}
            for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
              if (entry.isDirectory()) {
                walkAndRefresh(path.join(rel, entry.name));
              } else {
                const srcFile = path.join(srcDir, entry.name);
                const dstFile = path.join(dstDir, entry.name);
                try {
                  fs.copyFileSync(srcFile, dstFile); refreshed++;
                } catch (cpErr) {
                  if (process.platform === 'win32' && cpErr?.code === 'EBUSY') {
                    try { const { execSync } = require('child_process'); execSync('ping -n 2 127.0.0.1 >nul', { windowsHide: true }); fs.copyFileSync(srcFile, dstFile); refreshed++; } catch { console.warn('[seedWorkspace] EBUSY retry failed:', entry.name); }
                  }
                }
              }
            }
          };
          try { walkAndRefresh(''); console.log('[seedWorkspace] ' + dirName + '/ refreshed ' + refreshed + ' template files (user files preserved)'); } catch (we) { console.warn('[seedWorkspace] ' + dirName + '/ refresh failed:', we.message); }
        }
        for (const f of alsoOverwrite) {
          const fp = path.join(ws, f);
          if (fs.existsSync(fp)) {
            try { fs.unlinkSync(fp); console.log('[seedWorkspace] ' + f + ' force-overwritten (piggyback on AGENTS.md upgrade)'); } catch {}
          }
        }
        // Clean up fake sample memory files from older templates
        const fakeFiles = [
          'memory/people/colleague.md',
          'memory/projects/knowledge-management.md',
          'memory/projects/microservices-migration.md',
        ];
        for (const f of fakeFiles) {
          const fp = path.join(ws, f);
          if (fs.existsSync(fp)) {
            try { fs.unlinkSync(fp); console.log('[seedWorkspace] removed fake memory file: ' + f); } catch {}
          }
        }
        purgeAgentSessions('seedWorkspace');
        _agentsUpgraded = true;
      }
    } catch (e) {
      console.warn('[seedWorkspace] AGENTS.md version check failed:', e && e.message ? e.message : String(e));
    }
  }

  // Only seed from bundle if workspace differs from template source (packaged)
  if (ws !== templateRoot) {
    const templateFiles = [
      'AGENTS.md', 'BOOTSTRAP.md', 'SOUL.md', 'IDENTITY.md', 'USER.md',
      'COMPANY.md', 'PRODUCTS.md', 'MEMORY.md', 'TOOLS.md',
      'README.md',
    ];
    for (const f of templateFiles) {
      const src = path.join(templateRoot, f);
      const dst = path.join(ws, f);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        try { fs.copyFileSync(src, dst); } catch {}
      }
    }
    // Cleanup orphaned HEARTBEAT.md — leaked internal protocol to agent context
    for (const orphan of ['HEARTBEAT.md']) {
      const p = path.join(ws, orphan);
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
    }
    const hbPrompt = path.join(ws, 'prompts', 'heartbeat-prompt.md');
    try { if (fs.existsSync(hbPrompt)) fs.unlinkSync(hbPrompt); } catch {}
    const templateDirs = ['skills', 'industry', 'prompts', 'memory', 'tools', 'docs', '.learnings', 'config', 'personas'];
    for (const d of templateDirs) {
      copyDirRecursive(path.join(templateRoot, d), path.join(ws, d));
    }
    // Copy knowledge/sales-playbook.md explicitly (rest of knowledge/ is CEO-owned).
    try {
      const playbookSrc = path.join(templateRoot, 'knowledge', 'sales-playbook.md');
      const playbookDstDir = path.join(ws, 'knowledge');
      const playbookDst = path.join(playbookDstDir, 'sales-playbook.md');
      if (fs.existsSync(playbookSrc) && !fs.existsSync(playbookDst)) {
        fs.mkdirSync(playbookDstDir, { recursive: true });
        fs.copyFileSync(playbookSrc, playbookDst);
      }
    } catch {}
  }

  // Seed CEO-MEMORY.md (hot tier for Hermes-style memory)
  const ceoMemPath = path.join(ws, 'CEO-MEMORY.md');
  if (!fs.existsSync(ceoMemPath)) {
    try { fs.writeFileSync(ceoMemPath, '# Bộ nhớ bot\n\n_Chưa có gì. Bot sẽ tự học từ cuộc hội thoại với sếp._\n', 'utf-8'); } catch {}
  }

  // Re-apply Zalo mode from config/zalo-mode.txt into the fresh AGENTS.md.
  // Must run AFTER template copy (above) so AGENTS.md exists.
  if (_agentsUpgraded) {
    try {
      const zmPath = path.join(ws, 'config', 'zalo-mode.txt');
      const freshAgents = path.join(ws, 'AGENTS.md');
      if (fs.existsSync(zmPath) && fs.existsSync(freshAgents)) {
        const mode = fs.readFileSync(zmPath, 'utf-8').trim();
        if (mode && mode !== 'auto') {
          const modeText = mode === 'read'
            ? '**Chế độ: Chỉ đọc.** KHÔNG tự trả lời trên Zalo. Đọc tin nhắn và báo qua Telegram cho CEO. CEO quyết định trả lời.'
            : '**Chế độ: Tóm tắt cuối ngày.** KHÔNG tự trả lời. Đọc tất cả tin nhắn trong ngày, gửi bản tổng hợp qua Telegram 1 lần vào cuối ngày.';
          let agContent = fs.readFileSync(freshAgents, 'utf-8');
          const zaloHeaderRe = /^(#{2,3} Zalo \(kênh khách hàng[^)]*\))\r?\n/m;
          const replaced = agContent.replace(zaloHeaderRe, '$1\n\n' + modeText + '\n');
          if (replaced !== agContent) {
            fs.writeFileSync(freshAgents, replaced, 'utf-8');
            console.log('[seedWorkspace] re-applied Zalo mode "' + mode + '" to upgraded AGENTS.md');
          }
        }
      }
    } catch (zmErr) {
      console.warn('[seedWorkspace] Zalo mode re-apply failed:', zmErr?.message);
    }
  }

  // Seed empty shop-state.json (daily state file) if missing
  try {
    const shopStatePath = path.join(ws, 'shop-state.json');
    if (!fs.existsSync(shopStatePath)) {
      writeJsonAtomic(shopStatePath, {
        updatedAt: new Date().toISOString(),
        updatedBy: 'seed',
        outOfStock: [],
        staffAbsent: [],
        shippingDelay: { active: false, reason: '', estimatedDelayHours: 0 },
        activePromotions: [],
        earlyClosing: { active: false, time: null },
        specialNotes: '',
      });
    }
  } catch {}

  // REMOVED (user report 2026-04-18): legacy cleanup was deleting the
  // zalo-group-settings.json file whenever every entry was mode="off".
  // That pattern is ALSO what a CEO who legitimately turns off bot in all
  // groups via Dashboard "Tắt tất cả" produces. Result: their explicit
  // all-off setting got wiped on next boot → Dashboard fell back to the
  // UI default ("mention") → user saw all groups reset to @mention with
  // no memory of their choice. The original legacy case (v2.3.42-era
  // buggy save that unilaterally wrote all-off) hasn't been writable for
  // many releases; any legitimate all-off file now is intentional and
  // must be preserved.

  // Seed default active-persona mix if missing (wizard overwrites later).
  // Format: active-persona.json (structured config) + active-persona.md
  // (compiled prompt bot reads on bootstrap).
  //
  // Upgrade migration: if user had v2.2.35 with active-persona.txt (single
  // archetype id), map that to a matching mix config before seeding default.
  // Otherwise silently losing their wizard choice would change bot voice
  // without warning.
  try {
    const mixJsonPath = path.join(ws, 'active-persona.json');
    const compiledPath = path.join(ws, 'active-persona.md');
    const legacyPath = path.join(ws, 'active-persona.txt');

    // Archetype id → mix config map (mirrors PERSONA_PRESETS in wizard.html).
    // Traits use the 15 scientific slugs (Big Five + service-specific).
    const ARCHETYPE_TO_MIX = {
      'chi-ban-hang-mien-tay': { region: 'tay',         voice: 'em-nu-tre',       customer: 'anh-chi',   traits: ['am-ap','thuc-te','kien-nhan','chu-dao'],            formality: 4 },
      'em-sale-bds-sg':        { region: 'nam',         voice: 'em-nu-tre',       customer: 'anh-chi',   traits: ['nang-dong','chu-dong','chuyen-nghiep','chu-dao'],   formality: 6 },
      'co-giao-ha-noi':        { region: 'bac',         voice: 'chi-trung-nien',  customer: 'anh-chi',   traits: ['chin-chu','kien-nhan','chu-dao','tinh-te'],         formality: 8 },
      'duoc-si-an-can':        { region: 'trung-tinh',  voice: 'em-nu-tre',       customer: 'anh-chi',   traits: ['chin-chu','dong-cam','diem-tinh','chu-dao'],        formality: 6 },
      'chi-spa-nhe-nhang':     { region: 'trung-tinh',  voice: 'em-nu-tre',       customer: 'anh-chi',   traits: ['tinh-te','am-ap','diem-tinh','linh-hoat'],          formality: 7 },
      'anh-tho-sua-xe':        { region: 'nam',         voice: 'em-nam-tre',      customer: 'anh-chi',   traits: ['thang-than','thuc-te','chu-dao','than-thien'],      formality: 4 },
      'co-le-tan-khach-san':   { region: 'bac',         voice: 'em-nu-tre',       customer: 'quy-khach', traits: ['tinh-te','chuyen-nghiep','chin-chu','linh-hoat'],  formality: 10 },
      'anh-sale-oto':          { region: 'trung-tinh',  voice: 'em-nam-tre',      customer: 'anh-chi',   traits: ['chuyen-nghiep','chu-dong','chu-dao','linh-hoat'],  formality: 7 },
      'chi-chu-boutique':      { region: 'nam',         voice: 'em-nu-tre',       customer: 'anh-chi',   traits: ['sang-tao','tinh-te','am-ap','linh-hoat'],           formality: 6 },
      'anh-ky-thuat-cong-nghe':{ region: 'trung-tinh',  voice: 'em-nam-tre',      customer: 'anh-chi',   traits: ['chuyen-nghiep','kien-nhan','thuc-te','chu-dao'],   formality: 6 },
    };

    if (!fs.existsSync(mixJsonPath)) {
      let mixToSeed = null;

      // Try migration from v2.2.35 legacy format
      try {
        if (fs.existsSync(legacyPath)) {
          const oldId = fs.readFileSync(legacyPath, 'utf-8').trim();
          if (ARCHETYPE_TO_MIX[oldId]) {
            mixToSeed = Object.assign({ greeting: '', closing: '', phrases: '' }, ARCHETYPE_TO_MIX[oldId]);
            console.log('[seedWorkspace] migrated legacy persona "' + oldId + '" → mix config');
          }
        }
      } catch (e) {
        console.warn('[seedWorkspace] legacy persona migration failed:', e?.message);
      }

      // Fresh install default
      if (!mixToSeed) {
        mixToSeed = {
          region: 'trung-tinh',
          voice: 'em-nu-tre',
          customer: 'anh-chi',
          traits: ['am-ap', 'chu-dao', 'chuyen-nghiep'],
          formality: 5,
          greeting: '',
          closing: '',
          phrases: '',
        };
      }

      writeJsonAtomic(mixJsonPath, mixToSeed);
      if (typeof _compilePersonaMixFn === 'function') {
        fs.writeFileSync(compiledPath, _compilePersonaMixFn(mixToSeed), 'utf-8');
      }
    }
    // Legacy cleanup — only delete AFTER migration above had a chance to run
    try {
      if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath);
    } catch {}
  } catch {}

  // ALWAYS ensure runtime files exist (dev + packaged)
  const schedulesFile = path.join(ws, 'schedules.json');
  if (!fs.existsSync(schedulesFile)) {
    try { writeJsonAtomic(schedulesFile, DEFAULT_SCHEDULES_JSON); } catch {}
  }
  // INTENTIONAL: custom-crons.json is NOT in `templateFiles` above. It is user
  // data, never a template. Packaged fresh installs always get an empty list
  // here because their workspace=userData/ doesn't have the file. Devs cloning
  // the repo get whatever is in the source tree (their problem to manage).
  const customCronsFile = path.join(ws, 'custom-crons.json');
  if (!fs.existsSync(customCronsFile)) {
    try { writeJsonAtomic(customCronsFile, []); } catch {}
  }
  const blocklistFile = path.join(ws, 'zalo-blocklist.json');
  if (!fs.existsSync(blocklistFile)) {
    try { writeJsonAtomic(blocklistFile, []); } catch {}
  }

  // Zalo per-user memory dir (bot writes <senderId>.md per customer).
  // Bot's actual workspace is in openclaw.json -> agents.defaults.workspace,
  // NOT 9BizClaw's getWorkspace(). Pre-create at BOTH locations so the
  // Dashboard reader sees something even if openclaw.json isn't ready yet
  // on a fresh install (the agent-workspace one is the canonical one that
  // bot will actually use after wizard).
  try { fs.mkdirSync(path.join(ws, 'memory', 'zalo-users'), { recursive: true }); } catch {}
  try { fs.mkdirSync(path.join(ws, 'memory', 'zalo-groups'), { recursive: true }); } catch {}
  try { fs.mkdirSync(path.join(ws, 'brand-assets'), { recursive: true }); } catch {}
  try { fs.mkdirSync(path.join(ws, 'brand-assets', 'generated'), { recursive: true }); } catch {}
  try { fs.mkdirSync(path.join(ws, 'media-assets'), { recursive: true }); } catch {}
  for (const mediaType of ['brand', 'product', 'generated', 'knowledge_image', 'pdf_page']) {
    try { fs.mkdirSync(path.join(ws, 'media-assets', mediaType), { recursive: true }); } catch {}
  }
  try { fs.mkdirSync(path.join(ws, 'skills', 'image-templates'), { recursive: true }); } catch {}
  try {
    const agentWs = getOpenclawAgentWorkspace();
    if (agentWs && agentWs !== ws) {
      fs.mkdirSync(path.join(agentWs, 'memory', 'zalo-users'), { recursive: true });
      fs.mkdirSync(path.join(agentWs, 'memory', 'zalo-groups'), { recursive: true });
    }
  } catch {}

  // Knowledge tab folders + index files
  const knowCategories = ['cong-ty', 'san-pham', 'nhan-vien', '9bizclaw'];
  const knowLabels = { 'cong-ty': 'Công ty', 'san-pham': 'Sản phẩm', 'nhan-vien': 'Nhân viên', '9bizclaw': '9BizClaw' };
  for (const cat of knowCategories) {
    const filesDir = path.join(ws, 'knowledge', cat, 'files');
    try { fs.mkdirSync(filesDir, { recursive: true }); } catch {}
    const indexFile = path.join(ws, 'knowledge', cat, 'index.md');
    if (!fs.existsSync(indexFile)) {
      try {
        fs.writeFileSync(
          indexFile,
          `# Knowledge — ${knowLabels[cat]}\n\n*Chưa có tài liệu nào. CEO upload file qua Dashboard → Knowledge.*\n`,
          'utf-8'
        );
      } catch {}
    }
  }
  // Seed 9BizClaw product doc from source tree (self-knowledge for the bot)
  const bizclawSrc = path.join(ctx.resourceDir, 'knowledge', '9bizclaw');
  const bizclawDst = path.join(ws, 'knowledge', '9bizclaw');
  if (fs.existsSync(bizclawSrc)) copyDirRecursive(bizclawSrc, bizclawDst);

  return ws;
}

function getSetupCompletePath() {
  try {
    const dir = (app && app.isReady()) ? app.getPath('userData') : ctx.userDataDir;
    return path.join(dir || ctx.HOME, 'setup-complete.json');
  } catch {
    return path.join(ctx.userDataDir || ctx.HOME, 'setup-complete.json');
  }
}

function hasCompletedOnboarding() {
  try {
    return fs.existsSync(getSetupCompletePath());
  } catch {
    return false;
  }
}

function markOnboardingComplete(source = 'wizard') {
  try {
    const p = getSetupCompletePath();
    writeJsonAtomic(p, {
      completed: true,
      source,
      at: new Date().toISOString(),
      appVersion: app?.getVersion?.() || null,
    });
    return true;
  } catch (e) {
    console.error('[setup-complete] write error:', e.message);
    return false;
  }
}

function isOpenClawConfigured() {
  try {
    // Read config directly — CLI requires pairing which can timeout/fail
    const configPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
    console.log('[isOpenClawConfigured] configPath:', configPath, 'exists:', fs.existsSync(configPath));
    if (!fs.existsSync(configPath)) return false;
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const token = config && config.channels && config.channels.telegram && config.channels.telegram.botToken;
    console.log('[isOpenClawConfigured] token found:', !!token);
    return !!token && token.trim() !== '';
  } catch (e) { console.error('[isOpenClawConfigured] error:', e.message); return false; }
}

function getAppPrefsPath() {
  try {
    const dir = app.getPath('userData');
    return path.join(dir, 'app-prefs.json');
  } catch {
    return path.join(ctx.HOME, '.9bizclaw-app-prefs.json');
  }
}

function loadAppPrefs() {
  const defaults = { startMinimized: false };
  try {
    const p = getAppPrefsPath();
    if (!fs.existsSync(p)) {
      try { writeJsonAtomic(p, defaults); } catch {}
      return { ...defaults };
    }
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return { ...defaults, ...(raw && typeof raw === 'object' ? raw : {}) };
  } catch (e) {
    console.warn('[app-prefs] load failed:', e?.message || e);
    return { ...defaults };
  }
}

function saveAppPrefs(partial) {
  try {
    const cur = loadAppPrefs();
    const next = { ...cur, ...(partial && typeof partial === 'object' ? partial : {}) };
    writeJsonAtomic(getAppPrefsPath(), next);
    return next;
  } catch (e) {
    console.warn('[app-prefs] save failed:', e?.message || e);
    return null;
  }
}

// ========================================================================
// Security Layer 3 — Append-only audit log
// ========================================================================
// Every sensitive event (boot, config write, channel spawn, blocked output,
// cron fire, friend-check hit, etc.) is appended to an audit.jsonl file in
// the workspace logs/ directory. Append-only — callers NEVER rewrite or
// truncate. Gives CEO a forensic trail: "what did the bot do on day X".
//
// Rotation handled separately by Layer 5 log-rotate cron.
//
// Usage: auditLog('event_name', { ...metadata })
function auditLog(event, meta) {
  try {
    const workspace = getWorkspace();
    if (!workspace) return;
    const logsDir = path.join(workspace, 'logs');
    try { fs.mkdirSync(logsDir, { recursive: true }); } catch {}
    const file = path.join(logsDir, 'audit.jsonl');
    const entry = JSON.stringify({
      t: new Date().toISOString(),
      event: String(event || 'unknown'),
      pid: process.pid,
      ...meta,
    }) + '\n';
    fs.appendFileSync(file, entry, 'utf-8');
  } catch (e) {
    // Audit log failure MUST NOT break core flow. Log to console only.
    console.warn('[audit] write failed:', e?.message);
  }
}

function enforceRetentionPolicies() {
  try {
    const workspace = getWorkspace();
    if (!workspace) return;
    const logsDir = path.join(workspace, 'logs');
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const MB = 1024 * 1024;

    // 1. Rotate oversized logs
    const rotationTargets = [
      { name: 'openclaw.log', maxBytes: 10 * MB },
      { name: 'openzca.log', maxBytes: 10 * MB },
      { name: '9router.log', maxBytes: 10 * MB },
      { name: 'main.log', maxBytes: 20 * MB },
      { name: 'audit.jsonl', maxBytes: 50 * MB },
      { name: 'cron-runs.jsonl', maxBytes: 10 * MB },
      { name: 'security-output-filter.jsonl', maxBytes: 10 * MB },
      { name: 'escalation-queue.jsonl', maxBytes: 5 * MB },
      { name: 'ceo-alerts-missed.log', maxBytes: 5 * MB },
    ];
    for (const t of rotationTargets) {
      try {
        const p = path.join(logsDir, t.name);
        if (!fs.existsSync(p)) continue;
        const stat = fs.statSync(p);
        if (stat.size > t.maxBytes) {
          const rotated = p + '.1';
          try { fs.rmSync(rotated, { force: true }); } catch {}
          fs.renameSync(p, rotated);
          auditLog('log_rotated', { file: t.name, bytes: stat.size });
          console.log(`[retention] rotated ${t.name} (${(stat.size / MB).toFixed(1)} MB)`);
        }
      } catch (e) { console.warn('[retention] rotate', t.name, 'failed:', e?.message); }
    }

    // 2. Delete old rotated .log.1 files (>7 days)
    try {
      if (fs.existsSync(logsDir)) {
        for (const entry of fs.readdirSync(logsDir)) {
          if (!/\.(log|jsonl)\.\d+$/.test(entry)) continue;
          const p = path.join(logsDir, entry);
          try {
            const stat = fs.statSync(p);
            if (now - stat.mtimeMs > 7 * DAY) {
              fs.rmSync(p, { force: true });
              auditLog('log_expired_deleted', { file: entry });
              console.log(`[retention] deleted expired log: ${entry}`);
            }
          } catch {}
        }
      }
    } catch {}

    // 3. Archive memory/YYYY-MM-DD.md > 90 days old
    try {
      const memoryDir = path.join(workspace, 'memory');
      const archiveDir = path.join(memoryDir, 'archive');
      if (fs.existsSync(memoryDir)) {
        for (const entry of fs.readdirSync(memoryDir)) {
          if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(entry)) continue;
          const p = path.join(memoryDir, entry);
          try {
            const stat = fs.statSync(p);
            if (now - stat.mtimeMs > 90 * DAY) {
              fs.mkdirSync(archiveDir, { recursive: true });
              fs.renameSync(p, path.join(archiveDir, entry));
              auditLog('memory_archived', { file: entry });
              console.log(`[retention] archived old memory: ${entry}`);
            }
          } catch {}
        }
      }
    } catch {}

    // 4. Delete old openclaw.json.bak* (>30 days) — not needed forever
    try {
      const openclawDir = path.join(ctx.HOME, '.openclaw');
      if (fs.existsSync(openclawDir)) {
        for (const entry of fs.readdirSync(openclawDir)) {
          if (!/^openclaw\.json\.bak/.test(entry)) continue;
          const p = path.join(openclawDir, entry);
          try {
            const stat = fs.statSync(p);
            if (now - stat.mtimeMs > 30 * DAY) {
              fs.rmSync(p, { force: true });
              auditLog('config_backup_expired', { file: entry });
              console.log(`[retention] deleted old config backup: ${entry}`);
            }
          } catch {}
        }
      }
    } catch {}

    // 5. Purge agent session files older than 7 days
    try {
      const sessDir = path.join(ctx.HOME, '.openclaw', 'agents', 'main', 'sessions');
      if (fs.existsSync(sessDir)) {
        let purged = 0;
        for (const sf of fs.readdirSync(sessDir)) {
          if (!sf.endsWith('.jsonl')) continue;
          try {
            const p = path.join(sessDir, sf);
            const stat = fs.statSync(p);
            if (now - stat.mtimeMs > 7 * DAY) {
              fs.unlinkSync(p);
              purged++;
            }
          } catch {}
        }
        if (purged > 0) console.log(`[retention] purged ${purged} agent session files older than 7 days`);
      }
    } catch {}

    // 6. SQLite WAL checkpoint (reclaim dead space from upload/delete cycles)
    try {
      const dbPath = path.join(workspace, 'memory.db');
      if (fs.existsSync(dbPath)) {
        let db = null;
        try {
          const Database = require('better-sqlite3');
          db = new Database(dbPath);
          db.pragma('wal_checkpoint(TRUNCATE)');
        } catch (abiErr) {
          if (String(abiErr?.message).includes('NODE_MODULE_VERSION')) {
            console.warn('[retention] WAL checkpoint skipped — better-sqlite3 ABI mismatch (will auto-fix on next knowledge access)');
          } else { throw abiErr; }
        } finally { try { if (db) db.close(); } catch {} }
      }
    } catch (e) { console.warn('[retention] WAL checkpoint failed:', e?.message); }

    auditLog('retention_policies_enforced', {});
  } catch (e) {
    console.warn('[retention] enforcement failed:', e?.message);
  }
}

const BACKUP_FORMAT_VERSION = 2;

function backupWorkspace(opts = {}) {
  const ws = getWorkspace();
  if (!ws || !fs.existsSync(ws)) return;
  const backupsRoot = path.join(ws, 'backups');
  try { fs.mkdirSync(backupsRoot, { recursive: true }); } catch {}
  const force = opts && opts.force === true;
  const reason = String((opts && opts.reason) || 'scheduled');

  // Throttle: skip if most recent backup < 1 hour old
  try {
    const existing = fs.readdirSync(backupsRoot)
      .filter(n => /^\d{4}-\d{2}-\d{2}-\d{6}$/.test(n))
      .sort();
    if (existing.length > 0) {
      const latest = existing[existing.length - 1];
      const latestPath = path.join(backupsRoot, latest);
      try {
        const st = fs.statSync(latestPath);
        const manifestPath = path.join(latestPath, 'backup-manifest.json');
        let latestFormat = 0;
        try {
          latestFormat = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')).formatVersion || 0;
        } catch {}
        if (!force && latestFormat >= BACKUP_FORMAT_VERSION && Date.now() - st.mtimeMs < 60 * 60 * 1000) {
          console.log('[backup] skipped — recent full backup exists');
          return;
        }
      } catch {}
    }
  } catch {}

  // Build UTC timestamp YYYY-MM-DD-HHmmss
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  const dst = path.join(backupsRoot, stamp);
  fs.mkdirSync(dst, { recursive: true });

  let fileCount = 0;

  const copyFileIfExists = (srcAbs, dstAbs) => {
    try {
      if (!fs.existsSync(srcAbs)) return;
      fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
      fs.copyFileSync(srcAbs, dstAbs);
      fileCount++;
    } catch {}
  };

  const countFiles = (root) => {
    let n = 0;
    const walk = (p) => {
      try {
        for (const e of fs.readdirSync(p, { withFileTypes: true })) {
          const full = path.join(p, e.name);
          if (e.isDirectory()) walk(full);
          else if (e.isFile()) n++;
        }
      } catch {}
    };
    if (fs.existsSync(root)) walk(root);
    return n;
  };

  const copyDirIfExists = (rel, filterFn) => {
    const src = path.join(ws, rel);
    const out = path.join(dst, rel);
    if (!fs.existsSync(src)) return;
    try {
      fs.cpSync(src, out, {
        recursive: true,
        force: true,
        filter: (srcPath) => {
          const base = path.basename(srcPath);
          if (base === 'Cache' || base === 'Code Cache' || base === 'GPUCache') return false;
          if (base === 'logs' || base === 'backups') return false;
          if (/\.tmp\.\d+\.\d+\.\d+$/i.test(base)) return false;
          return filterFn ? filterFn(srcPath) : true;
        },
      });
      fileCount += countFiles(out);
    } catch (e) {
      console.warn('[backup] dir copy failed:', rel, e && e.message ? e.message : String(e));
    }
  };

  const flatFiles = [
    'AGENTS.md', 'IDENTITY.md', 'COMPANY.md', 'PRODUCTS.md', 'USER.md',
    'SOUL.md', 'MEMORY.md', 'BOOTSTRAP.md', 'TOOLS.md',
    'schedules.json', 'custom-crons.json',
    'zalo-blocklist.json', 'telegram-paused.json', 'zalo-paused.json',
    'zalo-group-settings.json', 'zalo-stranger-policy.json',
    'shop-state.json', 'active-persona.json', 'active-persona.md',
    'app-prefs.json', 'setup-complete.json', 'fb-config.json',
    'google-workspace.json', 'memory.db', 'memory.db-wal', 'memory.db-shm',
    'media-library.json',
  ];
  for (const rel of flatFiles) {
    copyFileIfExists(path.join(ws, rel), path.join(dst, rel));
  }

  // Full user-owned workspace data. This intentionally includes uploaded
  // Knowledge blobs and custom skills so upgrade rollback is real, not cosmetic.
  for (const rel of [
    'memory',
    'knowledge',
    'skills',
    'prompts',
    'tools',
    'docs',
    'config',
    'personas',
    '.learnings',
    'brand-assets',
    'media-assets',
    'documents',
  ]) {
    copyDirIfExists(rel);
  }

  // ~/.openclaw/openclaw.json
  try {
    const openclawJson = path.join(require('os').homedir(), '.openclaw', 'openclaw.json');
    copyFileIfExists(openclawJson, path.join(dst, 'openclaw.json'));
  } catch {}

  try {
    fs.writeFileSync(path.join(dst, 'backup-manifest.json'), JSON.stringify({
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      reason,
      sourceWorkspace: ws,
      includes: [
        'knowledge/**',
        'skills/**',
        'media-assets/**',
        'brand-assets/**',
        'memory/**',
        'config/**',
        'custom-crons.json',
        'memory.db',
        'openclaw.json',
      ],
      fileCount,
    }, null, 2), 'utf-8');
  } catch {}

  console.log(`[backup] saved ${dst} (${fileCount} files, reason=${reason})`);

  // Retention: keep 7 most recent
  try {
    const all = fs.readdirSync(backupsRoot)
      .filter(n => /^\d{4}-\d{2}-\d{2}-\d{6}$/.test(n))
      .sort();
    const toDelete = all.slice(0, Math.max(0, all.length - 7));
    for (const name of toDelete) {
      try {
        fs.rmSync(path.join(backupsRoot, name), { recursive: true, force: true });
      } catch {}
    }
  } catch {}
}

function hardenSensitiveFilePerms() {
  if (process.platform === 'win32') {
    // NTFS default ACL on user profile already restricts to owner.
    // Setting explicit ACLs via icacls would require elevation we don't have.
    return { skipped: true, reason: 'win32_ntfs_default_acl' };
  }
  const targets = [
    path.join(ctx.HOME, '.openclaw', 'openclaw.json'),
    path.join(ctx.HOME, '.openclaw', 'openclaw.json.bak'),
    path.join(ctx.HOME, '.openzca', 'profiles', 'default', 'credentials.json'),
    path.join(ctx.HOME, '.openzca', 'profiles', 'default', 'listener-owner.json'),
  ];
  let hardened = 0;
  for (const f of targets) {
    try {
      if (fs.existsSync(f)) {
        fs.chmodSync(f, 0o600);
        hardened++;
      }
    } catch (e) {
      console.warn('[file-harden] chmod failed:', path.basename(f), e.message);
    }
  }
  // Also harden the parent dirs to 700 so listing is restricted
  const dirs = [
    path.join(ctx.HOME, '.openclaw'),
    path.join(ctx.HOME, '.openzca'),
  ];
  for (const d of dirs) {
    try {
      if (fs.existsSync(d)) fs.chmodSync(d, 0o700);
    } catch {}
  }
  console.log('[file-harden] hardened', hardened, 'sensitive files (chmod 600)');
  try { auditLog('file_perms_hardened', { count: hardened }); } catch {}
  return { hardened };
}

module.exports = {
  getUserDataDir,
  copyDirRecursive,
  getWorkspace,
  invalidateWorkspaceCache,
  getWorkspaceTemplateRoot,
  getOpenclawAgentWorkspace,
  seedWorkspace,
  purgeAgentSessions,
  getBrandAssetsDir,
  getMediaAssetsDir,
  getFbConfigPath,
  readFbConfig,
  writeFbConfig,
  getSetupCompletePath,
  hasCompletedOnboarding,
  markOnboardingComplete,
  isOpenClawConfigured,
  getAppPrefsPath,
  loadAppPrefs,
  saveAppPrefs,
  auditLog,
  enforceRetentionPolicies,
  backupWorkspace,
  hardenSensitiveFilePerms,
  setCompilePersonaMix,
  _setWorkspaceCacheForTest,
  DEFAULT_SCHEDULES_JSON,
  BRAND_ASSET_FORMATS,
  BRAND_ASSET_MAX_SIZE,
};
