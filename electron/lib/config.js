'use strict';
const fs = require('fs');
const path = require('path');
const ctx = require('./context');
const { getWorkspace, seedWorkspace, auditLog } = require('./workspace');
const { normalizeZaloBlocklist } = require('./zalo-settings');

// Late-binding for journalCronRun (still lives in main.js; will move to cron.js later)
let _journalCronRunFn = null;
function setJournalCronRun(fn) { _journalCronRunFn = fn; }

// =========================================================================
// Private state
// =========================================================================

// Whitelist of fields we might mistakenly have added to modoro-zalo config that
// are NOT in its schema. When we see "additional properties" error at the
// modoro-zalo path, we strip these known-offenders. Expand this list as we learn.
const KNOWN_BAD_ZALO_KEYS = ['streaming', 'streamMode', 'nativeStreaming', 'blockStreamingDefault'];

// Single-writer mutex for openclaw.json read-modify-write sequences.
// Multiple IPC handlers (save-zalo-manager-config, save-wizard-config,
// set-batch-config, getTelegramConfigWithRecovery, setZaloChannelEnabled,
// resume-zalo) all do: read → mutate → writeOpenClawConfigIfChanged.
// Without serialization, two concurrent handlers can both read the same
// snapshot, mutate independently, and the last writer silently clobbers
// the first one's changes (TOCTOU).
//
// Usage: await withOpenClawConfigLock(async () => { ...read/mutate/write... })
let _openClawConfigMutex = Promise.resolve();

// =========================================================================
// Parse openclaw stderr for schema violations we can auto-heal.
// openclaw's validator emits two different error formats depending on the
// underlying schema library version:
//
//   1. Zod v3 "Unrecognized key" format:
//        "agents.defaults: Unrecognized key: \"blockStreaming\""
//        "channels.telegram.foo: Unrecognized key: \"bar\""
//
//   2. AJV / JSON-Schema-draft-07 "additional properties" format:
//        "channels.modoro-zalo: invalid config: must NOT have additional properties"
//        "- channels.modoro-zalo/streaming: must match ..."
//
//   3. Plain list format (sometimes wraps around):
//        "channels.modoro-zalo: must NOT have additional properties"
//        followed by: "Additional property: streaming"
//
// For format #1 we can extract both the path AND the specific key.
// For format #2 we only know the parent path — we need to diff against the
// known schema whitelist to figure out which key is the offender. But that
// whitelist is in the plugin source, not shipped to us. Fallback: return the
// parent path only, and the caller does a targeted cleanup using known
// "bad keys we ourselves might have added" — which catches the case where
// WE introduced the invalid field in the first place.
//
// Returns an array of { path: string[], key: string | null } objects.
// A null `key` means "parent path detected but specific field unknown — use
// whitelist diff at caller site".
function parseUnrecognizedKeyErrors(stderr) {
  const out = [];
  if (!stderr) return out;
  // Format #1: Unrecognized key with explicit name
  const unrecognized = /([\w.\-]+):\s*Unrecognized key:\s*"([^"]+)"/g;
  let m;
  while ((m = unrecognized.exec(stderr)) !== null) {
    out.push({ path: m[1].split('.'), key: m[2] });
  }
  // Format #2: "must NOT have additional properties" at a dotted path
  const additionalProps = /([\w.\-]+):\s*(?:invalid config:\s*)?must NOT have additional properties/g;
  while ((m = additionalProps.exec(stderr)) !== null) {
    out.push({ path: m[1].split('.'), key: null });
  }
  // Format #3: "Additional property: xxx" as a separate line
  const addlProp = /Additional propert(?:y|ies):\s*"?([^"\s,]+)"?/g;
  while ((m = addlProp.exec(stderr)) !== null) {
    // Without a path, we can't know which parent. Push as unscoped marker.
    out.push({ path: null, key: m[1] });
  }
  return out;
}

// Defense-in-depth: synchronously remove deprecated keys from openclaw.json so
// `openclaw <subcommand>` stops exiting with "Config invalid". Cheap, idempotent.
// Called BEFORE every agent spawn AND on any "Config invalid" stderr.
//
// Two modes:
//   - Static mode (no errStderr): removes keys we already know about (current
//     state of the world: agents.defaults.blockStreaming).
//   - Dynamic mode (errStderr passed): parses "Unrecognized key" errors from
//     openclaw stderr and deletes EXACTLY those paths. This means future
//     deprecated keys we don't yet know about heal themselves on first failure.
//
// Returns true if a write happened.
// Intentionally synchronous and lock-free — called in the cron pre-spawn hot
// path where the async config lock may already be held by ensureDefaultConfig.
// Safe because: (1) writeOpenClawConfigIfChanged is byte-equal-guarded, and
// (2) this function only DELETES keys — concurrent writers adding other keys
// won't conflict, and if our delete is lost to a concurrent write the bad key
// will trigger another heal on next cron attempt (self-correcting).
function healOpenClawConfigInline(errStderr) {
  try {
    const configPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
    if (!fs.existsSync(configPath)) return false;
    const raw = fs.readFileSync(configPath, 'utf-8');
    let config;
    try { config = JSON.parse(raw); } catch (e) {
      console.error('[heal-inline] openclaw.json is not valid JSON — refusing to touch:', e.message);
      return false;
    }
    let changed = false;
    const removed = [];

    // --- Static known-key removals (always run) ---
    if (config?.agents?.defaults && 'blockStreaming' in config.agents.defaults) {
      delete config.agents.defaults.blockStreaming;
      removed.push('agents.defaults.blockStreaming');
      changed = true;
    }
    // Static: strip any KNOWN_BAD_ZALO_KEYS from modoro-zalo root + all accounts.
    // These are fields that LOOK like they should work (streaming, streamMode)
    // but modoro-zalo schema doesn't define them, so the validator hard-rejects.
    const stripBadZaloKeys = (block, pathPrefix) => {
      if (!block || typeof block !== 'object') return;
      for (const k of KNOWN_BAD_ZALO_KEYS) {
        if (k in block) {
          delete block[k];
          removed.push(`${pathPrefix}.${k}`);
          changed = true;
        }
      }
    };
    if (config?.channels?.['modoro-zalo']) {
      stripBadZaloKeys(config.channels['modoro-zalo'], 'channels.modoro-zalo');
      if (config.channels['modoro-zalo'].accounts) {
        for (const accId of Object.keys(config.channels['modoro-zalo'].accounts || {})) {
          stripBadZaloKeys(
            config.channels['modoro-zalo'].accounts[accId],
            `channels.modoro-zalo.accounts.${accId}`
          );
        }
      }
    }

    // --- Dynamic removals from openclaw's own error message ---
    if (errStderr) {
      const parsed = parseUnrecognizedKeyErrors(errStderr);
      for (const { path: keyPath, key } of parsed) {
        if (keyPath && key) {
          // Format #1: explicit (path, key) — delete exactly that field
          let parent = config;
          let valid = true;
          for (const segment of keyPath) {
            if (parent && typeof parent === 'object' && segment in parent) {
              parent = parent[segment];
            } else { valid = false; break; }
          }
          if (valid && parent && typeof parent === 'object' && key in parent) {
            delete parent[key];
            removed.push(`${keyPath.join('.')}.${key}`);
            changed = true;
          }
        } else if (keyPath && !key) {
          // Format #2: "additional properties" at parent path — we don't know
          // WHICH field is the offender. Strategy: if path is channels.modoro-zalo
          // (or its accounts), strip all KNOWN_BAD_ZALO_KEYS. This catches
          // the case where we ourselves added a bad field.
          if (keyPath[0] === 'channels' && (keyPath[1] === 'modoro-zalo' || keyPath[1] === 'openzalo')) {
            let parent = config;
            for (const segment of keyPath) {
              if (parent && typeof parent === 'object' && segment in parent) parent = parent[segment];
              else { parent = null; break; }
            }
            if (parent && typeof parent === 'object') {
              stripBadZaloKeys(parent, keyPath.join('.'));
            }
          }
        } else if (!keyPath && key) {
          // Format #3: "Additional property: xxx" without parent — only strip
          // from modoro-zalo (the strict-schema channel), AND only if the key
          // is in the known-bad list. Without this guard, a colliding key name
          // (e.g. "enabled") could delete a valid field.
          const mz = config?.channels?.['modoro-zalo'];
          if (mz && typeof mz === 'object' && key in mz && KNOWN_BAD_ZALO_KEYS.includes(key)) {
            delete mz[key];
            removed.push(`channels.modoro-zalo.${key}`);
            changed = true;
          }
        }
      }
    }

    if (changed) {
      const wrote = writeOpenClawConfigIfChanged(configPath, config);
      if (wrote) {
        console.log('[heal-inline] healed openclaw.json — removed:', removed.join(', '));
        if (_journalCronRunFn) _journalCronRunFn({ phase: 'heal-inline', changed: true, removed, dynamic: !!errStderr });
      } else {
        console.log('[heal-inline] heal would have run but file already byte-equal — skipping write');
      }
    }
    return changed;
  } catch (e) {
    console.error('[heal-inline] error:', e.message);
    return false;
  }
}

function isValidConfigKey(key) {
  return typeof key === 'string' && /^[a-zA-Z0-9._-]+$/.test(key);
}

// Strip schema-invalid keys from a config object in-place before serialization.
// Single chokepoint: every writer of openclaw.json goes through
// writeOpenClawConfigIfChanged → sanitizeOpenClawConfigInPlace, so legacy
// wizard handlers, save-zalo-manager-config, ensureDefaultConfig, and any
// future code path get the same cleanup for free.
//
// This is defense-in-depth on top of ensureDefaultConfig's own cleanup —
// catches bad writes that originate from IPC handlers which don't re-run
// ensureDefaultConfig.
function sanitizeOpenClawConfigInPlace(config) {
  if (!config || typeof config !== 'object') return;
  // openclaw 2026.4.x removed agents.defaults.blockStreaming (replaced with
  // blockStreamingDefault). Keep the file schema-clean.
  if (config.agents?.defaults && 'blockStreaming' in config.agents.defaults) {
    delete config.agents.defaults.blockStreaming;
  }
  // modoro-zalo schema does NOT include 'streaming', 'streamMode',
  // 'nativeStreaming', or 'blockStreamingDefault' — writing them causes
  // `channels.modoro-zalo: must NOT have additional properties` which kills
  // every `openclaw <subcommand>` call and blocks gateway reloads.
  const stripKeys = (block) => {
    if (!block || typeof block !== 'object') return;
    for (const k of KNOWN_BAD_ZALO_KEYS) {
      if (k in block) delete block[k];
    }
  };
  if (config.channels?.['modoro-zalo']) {
    stripKeys(config.channels['modoro-zalo']);
    if (config.channels['modoro-zalo'].accounts && typeof config.channels['modoro-zalo'].accounts === 'object') {
      for (const accId of Object.keys(config.channels['modoro-zalo'].accounts)) {
        stripKeys(config.channels['modoro-zalo'].accounts[accId]);
      }
    }
  }
}

function withOpenClawConfigLock(fn, timeoutMs = 30000) {
  let fnResult;
  const run = _openClawConfigMutex.then(() => {
    fnResult = Promise.resolve(fn());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('[config-lock] timed out after ' + timeoutMs + 'ms')), timeoutMs);
      fnResult.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); }
      );
    });
  });
  // Mutex waits for fn() to actually finish, not just timeout — preserves serialization
  _openClawConfigMutex = _openClawConfigMutex.then(() => fnResult).catch(() => {});
  return run;
}

// Byte-for-byte safe write of openclaw.json. The gateway watches this file
// AND distinguishes its own writes from external ones via a hash. Any external
// write (even one that produces logically-identical JSON) fires the
// config-reload pipeline → buildGatewayReloadPlan → if any path matches a
// "restart" rule, gateway restarts → in-flight reply runs are aborted with
// `aborted_for_restart` → CEO sees "⚠️ Gateway is restarting. Please wait..."
//
// Our `ensureDefaultConfig()` was the culprit: it `JSON.stringify`'d without a
// trailing newline while OpenClaw writes WITH one — so even when nothing
// logically changed, our write differed by a single \n, openclaw's reloader
// woke up, and a CEO message sent at the wrong moment got aborted mid-reply.
//
// This helper:
//   1. Serializes the new config the same way openclaw does (2-space indent +
//      trailing newline).
//   2. Reads the existing file as a Buffer.
//   3. Only writes if the byte content actually differs.
// Returns true if a write happened.
function writeOpenClawConfigIfChanged(configPath, config) {
  try {
    // Sanitize FIRST — strip any schema-invalid keys that may have crept in
    // from legacy code paths, stale wizard state, or future schema bumps.
    // Callers get the cleaned version written even if they forgot to sanitize.
    sanitizeOpenClawConfigInPlace(config);
    const serialized = JSON.stringify(config, null, 2) + '\n';
    if (fs.existsSync(configPath)) {
      const existing = fs.readFileSync(configPath, 'utf-8');
      // Exact byte match — skip
      if (existing === serialized) return false;
      // Trailing-newline-only diff — also skip. Current file may have been
      // written by an older version of this code without a trailing newline;
      // overwriting it just to add the newline would still wake openclaw's
      // file watcher and trigger a spurious "Gateway is restarting" mid-reply.
      // The semantic content is identical so it's safe to leave as-is.
      if (existing + '\n' === serialized) return false;
      // Also handle the inverse: existing has trailing newline, our serialized
      // would still match content-wise. Compare with newline normalized.
      const existingNorm = existing.replace(/\n+$/, '');
      const serializedNorm = serialized.replace(/\n+$/, '');
      if (existingNorm === serializedNorm) return false;
    }
    fs.writeFileSync(configPath, serialized, 'utf-8');
    // Security audit: record every config write with the keys that changed.
    // Don't log values (may contain tokens). Only structure.
    try {
      auditLog('openclaw_config_write', {
        configPath: path.basename(configPath),
        bytes: serialized.length,
        topKeys: Object.keys(config || {}),
      });
    } catch {}
    return true;
  } catch (e) {
    console.error('[openclaw-config] write error:', e.message);
    return false;
  }
}

async function ensureDefaultConfig() {
  // Wrap the entire read-modify-write in the global openclaw.json mutex.
  // This fn runs at boot AND reactively (startOpenClaw from heartbeat / save-zalo-manager
  // / wizard-complete) so it can race with IPC handlers that mutate the same file.
  return withOpenClawConfigLock(async () => {
  console.log('[config-lock] ensureDefaultConfig acquired');
  // Patch openclaw.json directly — no CLI "restart to apply" issue
  const configPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
  try {
    if (!fs.existsSync(configPath)) return;
    let config;
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (parseErr) {
      console.error('[config] openclaw.json corrupt — attempting sticky backup restore:', parseErr?.message);
      const _backupPath = path.join(ctx.HOME, '.openclaw', 'modoroclaw-zalo-config-sticky.json');
      if (fs.existsSync(_backupPath)) {
        try {
          const backup = JSON.parse(fs.readFileSync(_backupPath, 'utf-8'));
          config = { channels: {}, agents: {}, plugins: {}, gateway: { mode: 'local' } };
          if (backup?.channel) config.channels['modoro-zalo'] = backup.channel;
          if (backup?.pluginEntry) { config.plugins.entries = { 'modoro-zalo': backup.pluginEntry }; }
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
          console.log('[config] RESTORED openclaw.json from sticky backup after corrupt parse');
        } catch (restoreErr) {
          console.error('[config] sticky backup restore also failed:', restoreErr?.message);
          return;
        }
      } else {
        return;
      }
    }
    let changed = false;

    // STICKY ZALO CONFIG: restore from backup if the Zalo block got wiped
    // (e.g. openclaw CLI reset, corrupt write, plugin reinstall).
    // Backup file lives outside openclaw.json so nothing can clobber it.
    const _zaloBackupPath = path.join(ctx.HOME, '.openclaw', 'modoroclaw-zalo-config-sticky.json');
    try {
      const hasZaloBlock = config.channels?.['modoro-zalo'] && typeof config.channels['modoro-zalo'] === 'object'
        && Object.keys(config.channels['modoro-zalo']).length > 1;
      const hasLegacyBlock = config.channels?.openzalo && typeof config.channels.openzalo === 'object'
        && Object.keys(config.channels.openzalo).length > 1;
      if (!hasZaloBlock && !hasLegacyBlock && fs.existsSync(_zaloBackupPath)) {
        const backup = JSON.parse(fs.readFileSync(_zaloBackupPath, 'utf-8'));
        if (backup && backup.channel && typeof backup.channel === 'object' && Object.keys(backup.channel).length > 1) {
          if (!config.channels) config.channels = {};
          config.channels['modoro-zalo'] = backup.channel;
          if (backup.pluginEntry) {
            if (!config.plugins) config.plugins = {};
            if (!config.plugins.entries) config.plugins.entries = {};
            config.plugins.entries['modoro-zalo'] = backup.pluginEntry;
          }
          changed = true;
          console.log('[config] RESTORED Zalo config from sticky backup (enabled=' + backup.channel.enabled + ')');
        }
      }
    } catch (e) { console.warn('[config] zalo sticky restore failed:', e?.message); }

    if (!config.gateway) config.gateway = {};
    if (config.gateway.mode !== 'local') { config.gateway.mode = 'local'; changed = true; }

    const provider = config.models?.providers?.ninerouter;
    if (provider) {
      if (provider.api !== 'openai-completions') { provider.api = 'openai-completions'; changed = true; }
      // Fix IPv6 issue: localhost → 127.0.0.1
      if (provider.baseUrl && provider.baseUrl.includes('localhost')) {
        provider.baseUrl = provider.baseUrl.replace('localhost', '127.0.0.1');
        changed = true;
      }
      // LAYER 5 vision fix — pi-ai's openai-completions.js filters out
      // image_url parts from user messages AND tool results if
      // `model.input.includes("image")` is false (node_modules/@mariozechner/
      // pi-ai/dist/providers/openai-completions.js:461 + 574). 9Router's
      // /v1/models response does NOT declare `input:["image"]` → pi-ai gate
      // strips every image part at the final outbound serialization step →
      // upstream gets only text → bot hallucinates. Declaring input:["image"]
      // at the openclaw.json model level propagates through openclaw's model
      // override chain into pi-ai, flipping the gate open.
      if (Array.isArray(provider.models)) {
        for (const m of provider.models) {
          if (!m || typeof m !== 'object') continue;
          if (!Array.isArray(m.input) || !m.input.includes('image')) {
            m.input = Array.isArray(m.input) ? [...new Set([...m.input, 'image', 'text'])] : ['text', 'image'];
            changed = true;
          }
        }
      }
    }

    // Fix required fields OpenClaw validator demands
    if (config.channels?.telegram?.botToken && !config.channels.telegram.enabled) {
      config.channels.telegram.enabled = true; changed = true;
    }
    // Ensure modoro-zalo has all policy fields set. CRITICAL: create block if missing
    // entirely — previously we only healed when `config.channels?.['modoro-zalo']` was truthy,
    // but openclaw 2026.4.x gateway normalization can strip fields and leave `{}`, or
    // even remove the key altogether. Always create + heal so the block is
    // never undefined/empty after this function.
    if (!config.channels) config.channels = {};
    // --- modoro-zalo migration from v2.3.49 ---
    if (config.channels && config.channels.openzalo && !config.channels['modoro-zalo']) {
      config.channels['modoro-zalo'] = JSON.parse(JSON.stringify(config.channels.openzalo));
      changed = true;
      console.log('[config] migrated channels.openzalo → channels["modoro-zalo"]');
    }
    if (config.channels && config.channels.openzalo) {
      delete config.channels.openzalo;
      changed = true;
    }
    if (config.plugins && config.plugins.entries) {
      if (config.plugins.entries.openzalo && !config.plugins.entries['modoro-zalo']) {
        config.plugins.entries['modoro-zalo'] = config.plugins.entries.openzalo;
        changed = true;
      }
      if (config.plugins.entries.openzalo) {
        delete config.plugins.entries.openzalo;
        changed = true;
      }
    }
    if (Array.isArray(config.plugins && config.plugins.allow)) {
      const idx = config.plugins.allow.indexOf('openzalo');
      if (idx !== -1) { config.plugins.allow[idx] = 'modoro-zalo'; changed = true; }
      config.plugins.allow = [...new Set(config.plugins.allow)];
    }
    // --- end migration ---
    if (!config.channels['modoro-zalo'] || typeof config.channels['modoro-zalo'] !== 'object') {
      config.channels['modoro-zalo'] = {};
      changed = true;
    }
    // ALSO: if the modoro-zalo plugin files exist at ~/.openclaw/extensions/modoro-zalo/
    // (either because bundled copy placed them there, or local install did),
    // make sure the plugin entry EXISTS. We sync its enabled state later from
    // channels['modoro-zalo'].enabled so "Tắt Zalo" is a real hard-off, not
    // merely a soft gate after the plugin already loaded.
    try {
      const modoroZaloPluginManifest = path.join(ctx.HOME, '.openclaw', 'extensions', 'modoro-zalo', 'openclaw.plugin.json');
      if (fs.existsSync(modoroZaloPluginManifest)) {
        if (!config.plugins) config.plugins = {};
        if (!config.plugins.entries) config.plugins.entries = {};
        if (!config.plugins.entries['modoro-zalo']) {
          config.plugins.entries['modoro-zalo'] = { enabled: false };
          changed = true;
        }
        // plugins.allow tells gateway which non-bundled plugins are trusted.
        // Without this, gateway warns "plugins.allow is empty" on every boot.
        if (!Array.isArray(config.plugins.allow)) {
          config.plugins.allow = ['modoro-zalo'];
          changed = true;
        } else if (!config.plugins.allow.includes('modoro-zalo')) {
          config.plugins.allow.push('modoro-zalo');
          changed = true;
        }
      }
    } catch (e) { console.warn('[config] plugin entry heal failed:', e?.message); }
    {
      const oz = config.channels['modoro-zalo'];
      // Default OFF on fresh install — CEO must enable from Settings > Zalo.
      // If field already exists (any value), preserve it so disabling from
      // dashboard survives restarts. Previously this forced true every boot,
      // which overrode the CEO's explicit disable.
      if (oz.enabled === undefined) { oz.enabled = false; changed = true; }
      if (config.plugins?.entries?.['modoro-zalo']
          && config.plugins.entries['modoro-zalo'].enabled !== (oz.enabled !== false)) {
        config.plugins.entries['modoro-zalo'].enabled = oz.enabled !== false;
        changed = true;
      }
      // U2: purge legacy channels['modoro-zalo'].groups on upgrade. v2.58 stored
      // per-group requireMention/enabled here, creating a dual source of
      // truth with zalo-group-settings.json (CRIT #5). We're now
      // single-sourcing via the JSON file + GROUP-SETTINGS v3 patch.
      if (oz.groups && typeof oz.groups === 'object') { delete oz.groups; changed = true; }
      if (!oz.dmPolicy) { oz.dmPolicy = 'open'; changed = true; }
      if (!oz.allowFrom) { oz.allowFrom = ['*']; changed = true; }
      if (!oz.groupPolicy) { oz.groupPolicy = 'open'; changed = true; }
      if (!oz.groupAllowFrom) { oz.groupAllowFrom = ['*']; changed = true; }
      // DELETE legacy streaming keys — openclaw 2026.4.14 rejects them.
      // Modoro-Zalo one-message guarantee comes from blockStreaming:false capability
      // baked into channel.ts. blockStreaming itself is a valid schema field.
      for (const legacyKey of ['streamMode', 'draftChunk', 'blockStreamingCoalesce']) {
        if (legacyKey in oz) { delete oz[legacyKey]; changed = true; }
      }
      // History limits: prevent context window bloat over weeks of chat.
      // historyLimit = max messages kept per group thread (default unlimited → OOM after weeks)
      // dmHistoryLimit = max messages kept per DM thread
      // Without these, a CEO with 50 active Zalo groups × 200 msg/day = compaction every reply after ~3 days.
      if (typeof oz.historyLimit !== 'number' || oz.historyLimit > 50) { oz.historyLimit = 50; changed = true; }
      if (typeof oz.dmHistoryLimit !== 'number' || oz.dmHistoryLimit > 20) { oz.dmHistoryLimit = 20; changed = true; }
      // DEFENSIVE CLEANUP: remove `streaming` if it crept in from a prior buggy
      // version of this function (2026-04-08 regression). Schema rejects it.
      if ('streaming' in oz) { delete oz.streaming; changed = true; }
      // Whitelist-based strip: modoro-zalo schema is strict
      // (additionalProperties:false). CEOs upgrading from older openclaw CLI
      // installs may have fields like `messages` (seen in real customer
      // workspace 2026-04-15) or other legacy keys that make the gateway
      // reject config with "channels['modoro-zalo']: must NOT have additional
      // properties" → gateway never binds WS → bot dead silently.
      // Fields valid per modoro-zalo/src/config-schema-core.ts config schema:
      const MODORO_ZALO_VALID_FIELDS = new Set([
        'name', 'enabled', 'profile', 'zcaBinary', 'acpx', 'markdown',
        'dmPolicy', 'allowFrom', 'groupPolicy', 'groupAllowFrom', 'groups',
        'historyLimit', 'dmHistoryLimit', 'textChunkLimit', 'chunkMode',
        'blockStreaming', 'mediaMaxMb', 'mediaLocalRoots', 'sendTypingIndicators',
        'threadBindings', 'actions', 'accounts', 'defaultAccount',
      ]);
      for (const k of Object.keys(oz)) {
        if (!MODORO_ZALO_VALID_FIELDS.has(k)) {
          console.log('[config] stripped unknown modoro-zalo field: ' + k);
          delete oz[k];
          changed = true;
        }
      }
      // DO NOT set `zcaBinary` here: the modoro-zalo plugin's
      // resolveOpenzcaCliJs() on Windows only searches hardcoded npm global
      // paths and ignores the config value during resolve, then falls back to
      // `spawn(binary, ..., {shell: true})`. On Mac it always falls back to
      // that shell-spawn path. Either way, the resolution works via PATH
      // lookup of plain "openzca". For bundled .dmg installs, the PATH
      // augmentation in augmentPathWithBundledNode() prepends
      // vendor/node_modules/.bin so the bundled openzca shim is found.
    }
    // Defense-in-depth: config layer in case env var fails to propagate (e.g.,
    // cron-agent subprocess spawn that doesn't inherit enrichedEnv).
    if (!config.discovery) config.discovery = {};
    if (!config.discovery.mdns) config.discovery.mdns = {};
    if (config.discovery.mdns.mode !== "off") {
      config.discovery.mdns.mode = "off";
      changed = true;
    }
    // Sync plugin hard-off with the master Zalo enabled flag. If Zalo is off,
    // the gateway should not load modoro-zalo at all.
    try {
      const modoroZaloPluginManifest2 = path.join(ctx.HOME, '.openclaw', 'extensions', 'modoro-zalo', 'openclaw.plugin.json');
      if (fs.existsSync(modoroZaloPluginManifest2)) {
        if (!config.plugins) config.plugins = {};
        if (!config.plugins.entries) config.plugins.entries = {};
        const wantZaloEnabled = config.channels['modoro-zalo'].enabled !== false;
        if (!config.plugins.entries['modoro-zalo']) {
          config.plugins.entries['modoro-zalo'] = { enabled: wantZaloEnabled };
          changed = true;
        } else if (config.plugins.entries['modoro-zalo'].enabled !== wantZaloEnabled) {
          config.plugins.entries['modoro-zalo'].enabled = wantZaloEnabled;
          changed = true;
        }
      }
    } catch (e) { console.warn('[config] plugin hard-off sync failed:', e?.message); }
    // Telegram — disable streaming so bot replies arrive as exactly 1 complete
    // message, never split. openclaw 2026.4.14 moved streaming config from scalar
    // keys (blockStreaming, streaming:"off") to nested object:
    //   streaming.mode = "off"
    //   streaming.block.enabled = false
    // Old scalar keys are REJECTED by validator ("must NOT have additional properties").
    if (!config.channels.telegram) config.channels.telegram = {};
    {
      const tg = config.channels.telegram;
      // DELETE legacy keys that cause "invalid config" rejection
      for (const legacyKey of ['blockStreaming', 'streamMode', 'chunkMode', 'draftChunk', 'blockStreamingCoalesce']) {
        if (legacyKey in tg) { delete tg[legacyKey]; changed = true; }
      }
      // Migrate scalar `streaming: "off"` → nested object
      if (typeof tg.streaming === 'string' || tg.streaming === undefined) {
        tg.streaming = { mode: 'off', block: { enabled: false } };
        changed = true;
      } else if (tg.streaming && typeof tg.streaming === 'object') {
        if (tg.streaming.mode !== 'off') { tg.streaming.mode = 'off'; changed = true; }
        if (!tg.streaming.block) tg.streaming.block = {};
        if (tg.streaming.block.enabled !== false) { tg.streaming.block.enabled = false; changed = true; }
      }
      // Group policy: "open" lets bot reply in ANY group it's added to (no
      // allowlist gate). Default openclaw is "allowlist" which blocks all groups
      // until manually configured → CEO adds bot to group, @mentions, bot
      // silently drops message. Same UX as Zalo (open by default).
      if (!tg.groupPolicy) { tg.groupPolicy = 'open'; changed = true; }
      // Require @mention in groups so bot only replies when explicitly called.
      // Otherwise bot would forward every group message to AI → huge token waste.
      // NOTE: requireMention is NOT a valid Telegram schema field in openclaw
      // 2026.4.14 (it exists for Discord/Slack/Matrix only). Telegram groups
      // use per-group config via `groups.<id>.requireMention` instead. Writing
      // it at top level causes "must NOT have additional properties" → gateway
      // refuses to start. DELETE if present from prior versions.
      if ('requireMention' in tg) { delete tg.requireMention; changed = true; }
      // History limit: prevent context bloat for CEO who chats 100+ msg/day
      if (typeof tg.historyLimit !== 'number' || tg.historyLimit > 50) { tg.historyLimit = 50; changed = true; }
      // DEFENSIVE CLEANUP: strip keys that are NOT in the Telegram schema.
      // A prior config or openclaw version may have left `messages`, `configWrites`
      // or other top-level keys nested under channels.telegram by mistake.
      // openclaw 2026.4.14 uses strict() → any unknown key = "must NOT have
      // additional properties" → gateway refuses to start.
      const TELEGRAM_VALID_FIELDS = new Set([
        'name', 'capabilities', 'execApprovals', 'enabled', 'markdown',
        'commands', 'customCommands', 'configWrites', 'dmPolicy', 'botToken',
        'tokenFile', 'replyToMode', 'groups', 'allowFrom', 'defaultTo',
        'groupAllowFrom', 'groupPolicy', 'contextVisibility', 'historyLimit',
        'dmHistoryLimit', 'dms', 'direct', 'textChunkLimit', 'streaming',
        'mediaMaxMb', 'timeoutSeconds', 'retry', 'network', 'webhookUrl',
        'webhookSecret', 'webhookPath', 'webhookHost', 'webhookPort',
        'webhookCertPath', 'accounts', 'defaultAccount',
        'profile', 'sendTypingIndicators',
      ]);
      for (const k of Object.keys(tg)) {
        if (!TELEGRAM_VALID_FIELDS.has(k)) {
          console.log('[config] stripped unknown telegram field: ' + k);
          delete tg[k];
          changed = true;
        }
      }
    }
    // Global default: openclaw 2026.4.x removed `agents.defaults.blockStreaming`
    // (boolean) and replaced it with `agents.defaults.blockStreamingDefault`
    // ("on"|"off"). The new default is already "off" — no value to write — but we
    // MUST actively delete the old key so the validator stops rejecting the file
    // with: `agents.defaults: Unrecognized key: "blockStreaming"`. Without this,
    // every `openclaw <subcommand>` call exits with code 1 (Config invalid) and
    // the entire cron-agent pipeline is dead.
    if (!config.agents) config.agents = {};
    if (!config.agents.defaults) config.agents.defaults = {};
    if ('blockStreaming' in config.agents.defaults) {
      delete config.agents.defaults.blockStreaming;
      changed = true;
    }
    // Belt-and-braces: explicitly set blockStreamingDefault="off" so even if a
    // future channel config block forgets `blockStreaming: false`, the global
    // default kicks in and prevents the "D" + "ạ em chào..." word-split bug.
    // (openclaw 2026.4.x default is already "off" but writing it explicit
    // protects against any future schema flip + makes intent clear in config.)
    if (config.agents.defaults.blockStreamingDefault !== 'off') {
      config.agents.defaults.blockStreamingDefault = 'off';
      changed = true;
    }
    // BOOTSTRAP INJECTION MODE: "always" re-injects AGENTS.md + bootstrap files
    // on EVERY turn (~8k tokens overhead). "continuation-skip" only injects on
    // the first message then skips — saves tokens but model loses AGENTS.md rules
    // on subsequent turns, causing emoji usage, AI self-disclosure, and missing
    // CEO confirmation steps. For customer-facing bot, correctness > token cost.
    if (config.agents.defaults.contextInjection !== 'always') {
      config.agents.defaults.contextInjection = 'always';
      changed = true;
    }
    // BOOTSTRAP-BUDGET FIX: openclaw default bootstrapMaxChars is 20,000 per file.
    // AGENTS.md is ~24K and growing (v2.3.48 will add more rules). At 20K the tail
    // of AGENTS.md is silently truncated — defense rules, cron rules, and channel
    // rules at the bottom get cut. Raise to 40K so the full file is always injected.
    // bootstrapTotalMaxChars default (150K) is generous and does not need changing.
    if (config.agents.defaults.bootstrapMaxChars !== 40000) {
      config.agents.defaults.bootstrapMaxChars = 40000;
      changed = true;
    }
    // TOOL-BLOAT FIX: use a small exact allowlist. Admin actions now go through
    // local authenticated APIs instead of giving the agent filesystem/process
    // tools globally.
    //
    // tools.allow verified in openclaw 2026.4.x runtime-schema at "tools.allow".
    if (!config.tools) config.tools = {};
    // tools.allow = absolute allowlist. Only these tools are available to the agent.
    // Zalo stranger protection is CODE-LEVEL:
    //   Layer 1: COMMAND-BLOCK patch in inbound.ts (43 regex, rewrite rawBody)
    //   Layer 2: AGENTS.md rules (exec/cron forbidden from Zalo context)
    //   Layer 3: Cron API token requires Telegram bot_token to acquire
    // cron tool still banned — cron management via web_fetch to local API only.
    const REQUIRED_TOOLS = ['message', 'web_search', 'web_fetch', 'update_plan'];
    const BANNED_TOOLS = ['cron', 'exec', 'process', 'read', 'write', 'apply_patch', 'memory', 'read_file', 'write_file', 'list_files', 'search_files'];
    const existingAllow = Array.isArray(config.tools.allow) ? config.tools.allow : [];
    const merged = REQUIRED_TOOLS.filter(t => !BANNED_TOOLS.includes(t));
    if (JSON.stringify(existingAllow.slice().sort()) !== JSON.stringify(merged.slice().sort())) {
      config.tools.allow = merged;
      changed = true;
    }
    // Remove legacy deny list — allow takes precedence, deny is redundant
    if (config.tools.deny) {
      delete config.tools.deny;
      changed = true;
    }
    // modoro-zalo.tools already stripped by MODORO_ZALO_VALID_FIELDS whitelist above.
    // LOOP SAFETY: enable tools.loopDetection — openclaw ships it disabled.
    // Without this, a truly stuck model can grind through unlimited tool calls.
    // Thresholds chosen wide enough to NEVER fire on normal 3-5 turn Zalo reply
    // (user said don't cap natural behavior), but stops pathological runaway.
    // Default values used for most fields — we just flip `enabled: true`.
    if (!config.tools.loopDetection) config.tools.loopDetection = {};
    if (config.tools.loopDetection.enabled !== true) {
      config.tools.loopDetection.enabled = true;
      changed = true;
    }
    // CLEANUP: execSecurity is NOT valid under agents.defaults (it's a runtime
    // agent config key). A prior buggy version wrote it here → gateway rejects
    // entire config with "Unrecognized key: execSecurity" → bot never starts.
    // Must actively delete to heal machines that already have the bad key.
    if ('execSecurity' in config.agents.defaults) {
      delete config.agents.defaults.execSecurity;
      changed = true;
    }
    // Inbound message batching: wait 3s for rapid messages from same sender,
    // then process all together as 1 turn. Prevents bot replying 3 times when
    // customer sends "anh ơi" + "giá bao nhiêu" + "có ship không" in 3 seconds.
    // OpenClaw default is 700ms. CEO experience is better at 3000ms.
    if (!config.messages) config.messages = {};
    if (!config.messages.inbound) config.messages.inbound = {};
    if (config.messages.inbound.debounceMs === undefined) {
      config.messages.inbound.debounceMs = 3000;
      changed = true;
    }
    // Suppress compaction notices to customers. OpenClaw sends "🧹 Compacting context..."
    // and "⚠️ Context limit exceeded" to the chat — CEO/khách should never see these.
    if (!config.agents.defaults.compaction) config.agents.defaults.compaction = {};
    if (config.agents.defaults.compaction.notifyUser !== false) {
      config.agents.defaults.compaction.notifyUser = false;
      changed = true;
    }
    // Enable cross-channel messaging: bot on Telegram channel can call `message`
    // tool targeting Zalo channel (e.g. CEO says "nhắn group Zalo X"). Without
    // this flag openclaw hard-throws "Cross-context messaging denied" even if the
    // bot follows AGENTS.md instruction. Config key confirmed from source:
    //   message-action-runner.js: cfg.tools?.message?.crossContext?.allowAcrossProviders
    if (!config.tools) config.tools = {};
    if (!config.tools.message) config.tools.message = {};
    if (!config.tools.message.crossContext) config.tools.message.crossContext = {};
    if (config.tools.message.crossContext.allowAcrossProviders !== true) {
      config.tools.message.crossContext.allowAcrossProviders = true;
      changed = true;
    }

    // Enable DuckDuckGo web search (built-in from openclaw 2026.4.14, no API key needed)
    if (!config.tools.web) config.tools.web = {};
    if (!config.tools.web.search) config.tools.web.search = {};
    if (!config.tools.web.search.provider) {
      config.tools.web.search.provider = 'duckduckgo';
      changed = true;
    }

    // Remove any unknown keys that OpenClaw rejects
    const validKeys = ['plugins', 'meta', 'channels', 'gateway', 'models', 'agents', 'wizard', 'tools', 'messages', 'discovery'];
    for (const key of Object.keys(config)) {
      if (!validKeys.includes(key)) { delete config[key]; changed = true; }
    }

    // Seed writable workspace (first run) — copies templates from read-only bundle if packaged
    const ws = seedWorkspace();

    // Preserve large per-friend deny lists. Customers can legitimately have
    // thousands of Zalo friends and "Tat tat ca" writes all IDs here.
    const blPath = path.join(ws, 'zalo-blocklist.json');
    if (fs.existsSync(blPath)) {
      try {
        const bl = JSON.parse(fs.readFileSync(blPath, 'utf-8'));
        if (Array.isArray(bl)) {
          const normalized = normalizeZaloBlocklist(bl);
          const changedLen = normalized.length !== bl.length;
          const changedValue = !changedLen && normalized.some((id, idx) => id !== String(bl[idx] ?? '').trim());
          if (changedLen || changedValue) {
            fs.writeFileSync(blPath, JSON.stringify(normalized, null, 2) + '\n');
            try { auditLog('blocklist_normalized', { was: bl.length, now: normalized.length }); } catch {}
          }
        } else {
          console.warn('[config] zalo-blocklist.json is not an array — preserving file for manual review');
        }
      } catch (blErr) { console.warn('[config] blocklist normalize check failed:', blErr?.message); }
    }

    // Set workspace to the writable dir so gateway reads our AGENTS.md, SOUL.md etc
    if (!config.agents) config.agents = {};
    if (!config.agents.defaults) config.agents.defaults = {};
    const wantedWorkspace = ws.replace(/\\/g, '/');
    if (config.agents.defaults.workspace !== wantedWorkspace) {
      config.agents.defaults.workspace = wantedWorkspace;
      changed = true;
    }

    // Always go through writeOpenClawConfigIfChanged so even with `changed=true`
    // we still skip if the serialized bytes are byte-equal (e.g. trailing-newline
    // mismatch with openclaw's writer was the previous bug). This guarantees we
    // never wake openclaw's config-reload pipeline unless we *truly* changed
    // something — which is the only way to avoid spurious "Gateway is restarting".
    if (changed) {
      const wrote = writeOpenClawConfigIfChanged(configPath, config);
      if (wrote) console.log('[config] openclaw.json patched (real change)');
      else console.log('[config] openclaw.json unchanged on disk — skipping write');
    }

    // STICKY ZALO CONFIG: snapshot after all healing so next boot can restore
    try {
      const zaloBlock = config.channels?.['modoro-zalo'];
      if (zaloBlock && typeof zaloBlock === 'object' && zaloBlock.enabled !== undefined) {
        const snapshot = {
          channel: JSON.parse(JSON.stringify(zaloBlock)),
          pluginEntry: config.plugins?.entries?.['modoro-zalo'] ? JSON.parse(JSON.stringify(config.plugins.entries['modoro-zalo'])) : null,
          savedAt: new Date().toISOString(),
        };
        fs.writeFileSync(_zaloBackupPath, JSON.stringify(snapshot, null, 2), 'utf-8');
      }
    } catch (e) { console.warn('[config] zalo sticky save failed:', e?.message); }

    // Create required dirs
    fs.mkdirSync(path.join(ctx.HOME, '.openclaw', 'agents', 'main', 'sessions'), { recursive: true });
    console.log('[config] workspace =', ws);
  } catch (e) {
    console.error('ensureDefaultConfig error:', e.message);
    // Surface write errors prominently — silent failure means bot runs with broken config
    try {
      const logsDir = path.join(ctx.HOME, '.openclaw', 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      const errFile = path.join(logsDir, 'config-errors.log');
      fs.appendFileSync(errFile, `${new Date().toISOString()} ensureDefaultConfig: ${e?.message || e}\n`, 'utf-8');
    } catch {}
  }
  });
}

module.exports = {
  parseUnrecognizedKeyErrors,
  healOpenClawConfigInline,
  isValidConfigKey,
  sanitizeOpenClawConfigInPlace,
  withOpenClawConfigLock,
  writeOpenClawConfigIfChanged,
  ensureDefaultConfig,
  setJournalCronRun,
};
