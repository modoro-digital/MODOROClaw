// vendor-patches.js — all vendor source-code patches in one place.
// Shared by: main.js (runtime, defense-in-depth) and prebuild-vendor.js (build-time).
// Every function is idempotent via markers — safe to call from both.

const fs = require('fs');
const path = require('path');

const OPENZALO_FORK_VERSION = 'fork-v24-partial-hex-filter';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _logPatchFailure(homeDir, functionName, detail) {
  try {
    const auditDir = path.join(homeDir, '.openclaw', 'logs');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.appendFileSync(
      path.join(auditDir, 'patch-failures.log'),
      `${new Date().toISOString()} ${functionName}: ${detail}\n`
    );
  } catch {}
}

function _getOpenclawDistDir(vendorDir) {
  if (!vendorDir) return null;
  const d = path.join(vendorDir, 'node_modules', 'openclaw', 'dist');
  return fs.existsSync(d) ? d : null;
}

// Generic: inject `return true;` at the top of a named function in matching files.
function _patchFunctionReturnTrue(distDir, homeDir, { filePrefix, funcSig, marker, logTag }) {
  if (!distDir) return;
  const files = fs.readdirSync(distDir).filter(f => f.startsWith(filePrefix) && f.endsWith('.js'));
  for (const file of files) {
    const fp = path.join(distDir, file);
    let src = fs.readFileSync(fp, 'utf-8');
    if (src.includes(marker)) continue;
    if (!src.includes(funcSig)) {
      console.warn(`[${logTag}] WARNING: ${file} exists but FUNC_SIG missing — upstream refactor detected`);
      _logPatchFailure(homeDir, logTag, `FUNC_SIG missing in ${file}`);
      continue;
    }
    const injected = `${funcSig}\n\treturn true; // ${marker}`;
    const patched = src.replace(funcSig, injected);
    if (patched !== src) {
      fs.writeFileSync(fp, patched, 'utf-8');
      console.log(`[${logTag}] applied to ${file}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Vision patches (layers 1-4): force vision ON for all models via 9Router
// ---------------------------------------------------------------------------

function ensureVisionFix(vendorDir, homeDir) {
  try {
    const distDir = _getOpenclawDistDir(vendorDir);
    if (!distDir) return;
    const MARKER_V1 = '// MODOROClaw VISION PATCH — default vision ON for unknown models (9Router proxy)';
    const MARKER_V2 = '// 9BizClaw VISION PATCH V2 — unconditional vision ON';
    const FUNC_SIG = 'async function resolveGatewayModelSupportsImages(params) {';
    const files = fs.readdirSync(distDir).filter(f => f.startsWith('session-utils-') && f.endsWith('.js'));
    for (const file of files) {
      const fp = path.join(distDir, file);
      let src = fs.readFileSync(fp, 'utf-8');
      if (src.includes(MARKER_V2)) continue;
      if (!src.includes(FUNC_SIG)) {
        console.warn(`[vision-fix] WARNING: ${file} exists but FUNC_SIG missing`);
        _logPatchFailure(homeDir, 'ensureVisionFix', `FUNC_SIG missing in ${file}`);
        continue;
      }
      if (src.includes(MARKER_V1)) {
        src = src.split('\n').filter(l => !l.includes(MARKER_V1)).join('\n');
      }
      const injected = `${FUNC_SIG}\n\treturn true; ${MARKER_V2}`;
      const patched = src.replace(FUNC_SIG, injected);
      if (patched !== src) {
        fs.writeFileSync(fp, patched, 'utf-8');
        console.log('[vision-fix] V2 applied to', file);
      }
    }
  } catch (e) {
    console.warn('[vision-fix] non-fatal:', e?.message);
  }
}

function ensureVisionCatalogFix(vendorDir, homeDir) {
  try {
    const distDir = _getOpenclawDistDir(vendorDir);
    _patchFunctionReturnTrue(distDir, homeDir, {
      filePrefix: 'model-catalog-',
      funcSig: 'function modelSupportsVision(entry) {',
      marker: '9BizClaw VISION-CATALOG PATCH — unconditional modelSupportsVision',
      logTag: 'vision-catalog-fix',
    });
  } catch (e) {
    console.warn('[vision-catalog-fix] non-fatal:', e?.message);
  }
}

function ensureVisionSerializationFix(vendorDir, homeDir) {
  try {
    const distDir = _getOpenclawDistDir(vendorDir);
    if (!distDir) return;
    const targets = [
      {
        prefix: 'model-context-tokens-',
        funcSig: 'function supportsImageInput(modelOverride) {',
        marker: '9BizClaw VISION-SERIALIZE PATCH — supportsImageInput always-true',
      },
      {
        prefix: 'stream-',
        funcSig: 'function supportsExplicitImageInput(model) {',
        marker: '9BizClaw VISION-STREAM PATCH — supportsExplicitImageInput always-true',
      },
    ];
    const allFiles = fs.readdirSync(distDir);
    for (const target of targets) {
      const candidates = allFiles.filter(f => f.startsWith(target.prefix) && f.endsWith('.js'));
      let patched = false;
      for (const file of candidates) {
        const fp = path.join(distDir, file);
        let src = fs.readFileSync(fp, 'utf-8');
        if (src.includes(target.marker)) { patched = true; continue; }
        if (!src.includes(target.funcSig)) continue;
        const injected = `${target.funcSig}\n\treturn true; // ${target.marker}`;
        const out = src.replace(target.funcSig, injected);
        if (out !== src) {
          fs.writeFileSync(fp, out, 'utf-8');
          console.log('[vision-serialize-fix] applied to', file);
          patched = true;
        }
      }
      if (!patched) {
        console.warn(`[vision-serialize-fix] WARNING: FUNC_SIG "${target.funcSig}" not found`);
        _logPatchFailure(homeDir, 'ensureVisionSerializationFix', `FUNC_SIG "${target.funcSig}" missing`);
      }
    }
  } catch (e) {
    console.warn('[vision-serialize-fix] non-fatal:', e?.message);
  }
}

// ---------------------------------------------------------------------------
// SSRF localhost bypass: allow web_fetch to 127.0.0.1 for cron API
// ---------------------------------------------------------------------------

function ensureWebFetchLocalhostFix(vendorDir, homeDir) {
  try {
    const distDir = _getOpenclawDistDir(vendorDir);
    if (!distDir) return;

    // Part 1: SSRF allow 127.0.0.1
    const files = fs.readdirSync(distDir).filter(f => f.startsWith('ssrf-') && f.endsWith('.js') && !f.includes('policy') && !f.includes('runtime'));
    const MARKER = '// 9BizClaw SSRF LOCALHOST PATCH — allow 127.0.0.1 for cron API';
    const FUNC_SIG = 'function isBlockedHostnameOrIp(hostname, policy) {';
    for (const file of files) {
      const fp = path.join(distDir, file);
      let src = fs.readFileSync(fp, 'utf-8');
      if (src.includes(MARKER)) continue;
      if (!src.includes(FUNC_SIG)) {
        console.warn(`[ssrf-localhost-fix] WARNING: ${file} anchor missing`);
        _logPatchFailure(homeDir, 'ensureWebFetchLocalhostFix', `FUNC_SIG missing in ${file}`);
        continue;
      }
      const injected = `${FUNC_SIG}\n\tconst _n = normalizeHostname(hostname); if (_n === '127.0.0.1') return false; ${MARKER}`;
      const patched = src.replace(FUNC_SIG, injected);
      if (patched !== src) {
        fs.writeFileSync(fp, patched, 'utf-8');
        console.log('[ssrf-localhost-fix] applied to', file);
      }
    }

    // Part 2: strip SECURITY NOTICE wrapper from localhost web_fetch responses
    const toolFiles = fs.readdirSync(distDir).filter(f => f.startsWith('openclaw-tools-') && f.endsWith('.js'));
    const NOWRAP_MARKER = '// 9BizClaw LOCALHOST NOWRAP PATCH';
    const NOWRAP_FUNC = 'function normalizeProviderWebFetchPayload(params) {';
    const NOWRAP_INJECT = `function normalizeProviderWebFetchPayload(params) {\n\tif (params.requestedUrl && /^https?:\\/\\/127\\.0\\.0\\.1:20200(\\\/|$)/.test(params.requestedUrl)) { const _lp = isRecord(params.payload) ? params.payload : {}; const _lt = typeof _lp.text === 'string' ? _lp.text : ''; const _ls = typeof _lp.status === 'number' ? Math.floor(_lp.status) : 200; return { url: params.requestedUrl, finalUrl: params.requestedUrl, status: _ls, extractMode: params.extractMode, extractor: params.providerId, externalContent: { untrusted: false, source: 'web_fetch', wrapped: false }, truncated: false, length: _lt.length, rawLength: _lt.length, wrappedLength: _lt.length, fetchedAt: new Date().toISOString(), tookMs: typeof _lp.tookMs === 'number' ? Math.max(0, Math.floor(_lp.tookMs)) : 0, text: _lt }; } ${NOWRAP_MARKER}`;
    for (const file of toolFiles) {
      const fp = path.join(distDir, file);
      let src = fs.readFileSync(fp, 'utf-8');
      if (src.includes(NOWRAP_MARKER)) continue;
      if (!src.includes(NOWRAP_FUNC)) {
        console.warn(`[ssrf-nowrap-fix] WARNING: ${file} anchor missing`);
        _logPatchFailure(homeDir, 'ensureWebFetchLocalhostFix-nowrap', `anchor missing in ${file}`);
        continue;
      }
      const patched = src.replace(NOWRAP_FUNC, NOWRAP_INJECT);
      if (patched !== src) {
        fs.writeFileSync(fp, patched, 'utf-8');
        console.log('[ssrf-nowrap-fix] applied to', file);
      }
    }
  } catch (e) {
    console.warn('[ssrf-localhost-fix] non-fatal:', e?.message);
  }
}

// ---------------------------------------------------------------------------
// OpenRouter pricing fail-fast: rewrite URLs to unreachable local addr
// ---------------------------------------------------------------------------

function ensureOpenclawPricingFix(vendorDir) {
  try {
    if (!vendorDir) return;
    const distDir = path.join(vendorDir, 'node_modules', 'openclaw', 'dist');
    if (!fs.existsSync(distDir)) return;

    const urlPattern = /"https:\/\/openrouter\.ai\/api\/v1([^"]*)"/g;
    const markerStr = '// 9BIZCLAW_OPENROUTER_DISABLED';
    const allFiles = fs.readdirSync(distDir).filter(f => f.endsWith('.js'));
    let patchedCount = 0, scannedCount = 0;

    for (const fname of allFiles) {
      const filePath = path.join(distDir, fname);
      let content;
      try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
      if (!urlPattern.test(content)) continue;
      scannedCount++;
      urlPattern.lastIndex = 0;
      if (content.includes(markerStr)) continue;
      const patched = content.replace(urlPattern, '"http://127.0.0.1:1/disabled$1"') + `\n${markerStr}\n`;
      try {
        fs.writeFileSync(filePath, patched, 'utf-8');
        patchedCount++;
        console.log(`[openclaw-pricing-fix] patched ${fname}`);
      } catch (e) {
        console.warn(`[openclaw-pricing-fix] write failed ${fname}: ${e.message}`);
      }
    }
    if (patchedCount > 0) console.log(`[openclaw-pricing-fix] ${patchedCount}/${scannedCount} file(s) patched`);
    else if (scannedCount > 0) console.log(`[openclaw-pricing-fix] already patched — skipping`);
  } catch (e) {
    console.warn('[openclaw-pricing-fix] error:', e?.message);
  }
}

// ---------------------------------------------------------------------------
// Prewarm disable: skip 4+ min model catalog fetch at boot
// ---------------------------------------------------------------------------

function ensureOpenclawPrewarmFix(vendorDir) {
  try {
    if (!vendorDir) return;
    const distDir = path.join(vendorDir, 'node_modules', 'openclaw', 'dist');
    if (!fs.existsSync(distDir)) return;

    const files = fs.readdirSync(distDir).filter(f => /^server\.impl-[A-Za-z0-9_-]+\.js$/.test(f));
    const markerStr = '9BIZCLAW_PREWARM_DISABLED';
    const funcSignature = 'async function prewarmConfiguredPrimaryModel(params) {';
    let patchedCount = 0;

    for (const fname of files) {
      const filePath = path.join(distDir, fname);
      let content;
      try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
      if (content.includes(markerStr)) continue;
      if (!content.includes(funcSignature)) continue;
      const patched = content.replace(
        funcSignature,
        funcSignature + '\n\treturn; // ' + markerStr + ' — avoid 4+min openrouter.ai model catalog fetch'
      );
      if (patched === content) continue;
      try {
        fs.writeFileSync(filePath, patched, 'utf-8');
        patchedCount++;
        console.log(`[openclaw-prewarm-fix] patched ${fname}`);
      } catch (e) {
        console.warn(`[openclaw-prewarm-fix] write failed ${fname}: ${e.message}`);
      }
    }
    if (patchedCount > 0) console.log(`[openclaw-prewarm-fix] ${patchedCount} file(s) patched`);
  } catch (e) {
    console.warn('[openclaw-prewarm-fix] error:', e?.message);
  }
}

// ---------------------------------------------------------------------------
// Openzca friend-event: auto-accept friend requests + cache refresh
// ---------------------------------------------------------------------------

function ensureOpenzcaFriendEventFix(vendorDir, workspaceDir) {
  try {
    if (!vendorDir) {
      console.log('[openzca-friend-event] no bundled vendor — skipping');
      return;
    }
    const cliPath = path.join(vendorDir, 'node_modules', 'openzca', 'dist', 'cli.js');
    if (!fs.existsSync(cliPath)) {
      console.warn('[openzca-friend-event] cli.js not found at', cliPath);
      return;
    }
    let content = fs.readFileSync(cliPath, 'utf-8');
    if (content.includes('9BIZCLAW FRIEND-EVENT PATCH')) {
      console.log('[openzca-friend-event] already patched');
      return;
    }

    const anchor = 'api.listener.on("message", async (message) => {';
    const anchorIdx = content.indexOf(anchor);
    if (anchorIdx === -1) {
      console.error('[openzca-friend-event] CRITICAL: anchor not found');
      try {
        const diagPath = path.join(workspaceDir || '.', 'logs', 'boot-diagnostic.txt');
        fs.mkdirSync(path.dirname(diagPath), { recursive: true });
        fs.appendFileSync(diagPath,
          `\n[${new Date().toISOString()}] [openzca-friend-event] anchor regex failed — openzca cli.js structure changed\n`,
          'utf-8');
      } catch {}
      return;
    }

    const injection = `// === 9BIZCLAW FRIEND-EVENT PATCH ===
        api.listener.on("friend_event", async (event) => {
          try {
            if (!event || typeof event.type !== "number") return;
            console.log("[friend_event] type=" + event.type + " threadId=" + (event.threadId || ""));
            if (event.type === 2) {
              const fromUid = event.data && event.data.fromUid;
              if (fromUid) {
                try {
                  await api.acceptFriendRequest(fromUid);
                  console.log("[friend_event] auto-accepted friend request from " + fromUid);
                } catch (acceptErr) {
                  console.error("[friend_event] auto-accept failed:", acceptErr && acceptErr.message ? acceptErr.message : String(acceptErr));
                }
              }
            }
            if (event.type === 0 || event.type === 2 || event.type === 7) {
              try {
                await refreshCacheForProfile(profile, api);
                console.log("[friend_event] cache refreshed for " + profile);
              } catch (refreshErr) {
                console.error("[friend_event] cache refresh failed:", refreshErr && refreshErr.message ? refreshErr.message : String(refreshErr));
              }
            }
            if (event.type === 0) {
              try {
                const newFriendUid = event.data && (event.data.fromUid || event.threadId);
                if (newFriendUid) {
                  let friendName = "";
                  try {
                    const __welFs = require("fs");
                    const __welPath = require("path");
                    const __welOs = require("os");
                    const cachePath = __welPath.join(__welOs.homedir(), ".openzca", "profiles", "default", "cache", "friends.json");
                    if (__welFs.existsSync(cachePath)) {
                      const friends = JSON.parse(__welFs.readFileSync(cachePath, "utf-8"));
                      if (Array.isArray(friends)) {
                        const match = friends.find(f => String(f.userId || f.uid || f.id || "").trim() === String(newFriendUid).trim());
                        if (match) friendName = String(match.displayName || match.name || match.zaloName || "").trim();
                      }
                    }
                  } catch {}
                  let pronoun = "ban";
                  if (friendName) {
                    const lastName = friendName.split(/\\s+/).pop() || "";
                    const maleNames = ["huy","minh","duc","hung","dung","tuan","thanh","long","quan","khanh","bao","hai","son","tu","duy","dat","kien","cuong","hoang","tri","nam","phuc","vinh"];
                    const femaleNames = ["huong","linh","trang","lan","mai","nga","ngoc","thao","vy","uyen","yen","hang","dung","thu","ha","nhung","hanh","chau","anh","quynh","my","nhi"];
                    const lnLower = lastName.toLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g, "");
                    if (maleNames.includes(lnLower)) pronoun = "anh " + friendName;
                    else if (femaleNames.includes(lnLower)) pronoun = "chi " + friendName;
                    else pronoun = "anh/chi " + friendName;
                  }
                  let botIntro = "tr\\u1EE3 l\\u00FD AI c\\u1EE7a doanh nghi\\u1EC7p";
                  try {
                    const __welFs2 = require("fs");
                    const __welPath2 = require("path");
                    const ws = process.env['9BIZ_WORKSPACE'] || "";
                    if (ws) {
                      const companyPath = __welPath2.join(ws, "COMPANY.md");
                      if (__welFs2.existsSync(companyPath)) {
                        const companyContent = __welFs2.readFileSync(companyPath, "utf-8");
                        const nameMatch = companyContent.match(/Ten cong ty[^:]*:\\\\s*(.+)/i) || companyContent.match(/^#\\\\s+(.+)/m);
                        if (nameMatch) botIntro = "tr\\u1EE3 l\\u00FD AI c\\u1EE7a " + nameMatch[1].trim();
                      }
                    }
                  } catch {}
                  const welcomeMsg = "Ch\\u00E0o " + pronoun + "! C\\u1EA3m \\u01A1n " + (pronoun.startsWith("anh") || pronoun.startsWith("chi") ? pronoun.split(" ")[0] : "b\\u1EA1n") + " \\u0111\\u00E3 k\\u1EBFt b\\u1EA1n.\\\\n\\\\n"
                    + "M\\u00ECnh l\\u00E0 " + botIntro + ". M\\u00ECnh c\\u00F3 th\\u1EC3 h\\u1ED7 tr\\u1EE3 " + (pronoun.startsWith("anh") || pronoun.startsWith("chi") ? pronoun.split(" ")[0] : "b\\u1EA1n") + ":\\\\n\\\\n"
                    + "1. Xem s\\u1EA3n ph\\u1EA9m / d\\u1ECBch v\\u1EE5\\\\n"
                    + "2. T\\u00ECm hi\\u1EC3u gi\\u00E1 c\\u1EA3\\\\n"
                    + "3. \\u0110\\u1EB7t l\\u1ECBch h\\u1EB9n / t\\u01B0 v\\u1EA5n\\\\n"
                    + "4. H\\u1ECFi c\\u00E2u h\\u1ECFi kh\\u00E1c\\\\n\\\\n"
                    + (pronoun.startsWith("anh") || pronoun.startsWith("chi") ? pronoun.split(" ")[0].charAt(0).toUpperCase() + pronoun.split(" ")[0].slice(1) : "B\\u1EA1n") + " ch\\u1EC9 c\\u1EA7n tr\\u1EA3 l\\u1EDDi s\\u1ED1 (1-4) \\u0111\\u1EC3 m\\u00ECnh h\\u1ED7 tr\\u1EE3 ngay!";
                  await api.sendMessage({ body: welcomeMsg }, newFriendUid, 0);
                  console.log("[friend_event] welcome message sent to new friend " + newFriendUid + " (" + friendName + ")");
                }
              } catch (welcomeErr) {
                console.error("[friend_event] welcome send failed:", welcomeErr && welcomeErr.message ? welcomeErr.message : String(welcomeErr));
              }
            }
          } catch (handlerErr) {
            console.error("[friend_event] handler error:", handlerErr && handlerErr.message ? handlerErr.message : String(handlerErr));
          }
        });
        // === END 9BIZCLAW FRIEND-EVENT PATCH ===
        `;

    const patched = content.slice(0, anchorIdx) + injection + content.slice(anchorIdx);
    fs.writeFileSync(cliPath, patched, 'utf-8');
    console.log('[openzca-friend-event] Injected friend_event listener');
  } catch (e) {
    console.error('[openzca-friend-event] error:', e?.message || e);
  }
}

// ---------------------------------------------------------------------------
// Openzalo fork: copy pre-patched TS files to extension directory
// ---------------------------------------------------------------------------

function _copyForkFiles(forkDir, targetSrcDir, files, label) {
  let copied = 0;
  for (const f of files) {
    const src = path.join(forkDir, f);
    const dst = path.join(targetSrcDir, f);
    if (!fs.existsSync(src)) continue;
    try {
      const tmpDst = dst + '.tmp.' + process.pid;
      fs.writeFileSync(tmpDst, fs.readFileSync(src));
      try { fs.renameSync(tmpDst, dst); } catch {
        const d = Date.now() + 20; while (Date.now() < d) {}
        fs.renameSync(tmpDst, dst);
      }
      copied++;
    } catch (e) {
      console.error('[openzalo-fork] failed to copy ' + f + ' to ' + label + ':', e?.message);
    }
  }
  return copied;
}

function applyOpenzaloFork(homeDir, forkDir, vendorDir) {
  const extSrcDir = path.join(homeDir, '.openclaw', 'extensions', 'openzalo', 'src');
  if (!fs.existsSync(extSrcDir)) return false;
  const markerPath = path.join(extSrcDir, '.fork-version');
  try {
    const existing = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf-8').trim() : '';
    if (existing === OPENZALO_FORK_VERSION) {
      console.log('[openzalo-fork] already at ' + OPENZALO_FORK_VERSION + ' — skip');
      return true;
    }
  } catch {}
  if (!forkDir) forkDir = path.join(__dirname, '..', 'patches', 'openzalo-fork');
  if (!fs.existsSync(forkDir)) {
    console.warn('[openzalo-fork] fork dir not found:', forkDir);
    return false;
  }
  const files = ['inbound.ts', 'send.ts', 'channel.ts', 'openzca.ts'];
  const copied = _copyForkFiles(forkDir, extSrcDir, files, 'extensions');
  // Also patch the vendor npm package — gateway may resolve the plugin from
  // vendor/node_modules/@tuyenhx/openzalo/ instead of ~/.openclaw/extensions/.
  // Without this, the command-block and output filter never execute.
  if (vendorDir) {
    const vendorSrcDir = path.join(vendorDir, 'node_modules', '@tuyenhx', 'openzalo', 'src');
    if (fs.existsSync(vendorSrcDir)) {
      const vc = _copyForkFiles(forkDir, vendorSrcDir, files, 'vendor');
      console.log('[openzalo-fork] vendor copy: ' + vc + '/' + files.length + ' files');
    }
  }
  if (copied === files.length) {
    try { fs.writeFileSync(markerPath, OPENZALO_FORK_VERSION, 'utf-8'); } catch {}
    console.log('[openzalo-fork] applied ' + OPENZALO_FORK_VERSION + ' (' + copied + '/' + files.length + ' files)');
  } else if (copied > 0) {
    console.warn('[openzalo-fork] partial copy ' + copied + '/' + files.length + ' — NOT writing version marker');
  }
  return copied === files.length;
}

// ---------------------------------------------------------------------------
// applyAllVendorPatches — one call from boot or build script
// ---------------------------------------------------------------------------

function applyAllVendorPatches({ vendorDir, homeDir, forkDir, workspaceDir, skipFork }) {
  const results = {};

  // Openclaw dist patches (build-time safe)
  results.pricing = _tryPatch('pricing', () => ensureOpenclawPricingFix(vendorDir));
  results.prewarm = _tryPatch('prewarm', () => ensureOpenclawPrewarmFix(vendorDir));
  results.vision = _tryPatch('vision', () => ensureVisionFix(vendorDir, homeDir));
  results.visionCatalog = _tryPatch('visionCatalog', () => ensureVisionCatalogFix(vendorDir, homeDir));
  results.visionSerialization = _tryPatch('visionSerialization', () => ensureVisionSerializationFix(vendorDir, homeDir));
  results.ssrf = _tryPatch('ssrf', () => ensureWebFetchLocalhostFix(vendorDir, homeDir));
  results.friendEvent = _tryPatch('friendEvent', () => ensureOpenzcaFriendEventFix(vendorDir, workspaceDir));

  // Openzalo fork (runtime only — extension dir doesn't exist at build time)
  if (!skipFork) {
    results.fork = _tryPatch('fork', () => applyOpenzaloFork(homeDir, forkDir, vendorDir));
  }

  return results;
}

function _tryPatch(name, fn) {
  try { fn(); return 'ok'; }
  catch (e) { console.error(`[vendor-patches] ${name} failed:`, e?.message); return 'error'; }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  OPENZALO_FORK_VERSION,
  ensureVisionFix,
  ensureVisionCatalogFix,
  ensureVisionSerializationFix,
  ensureWebFetchLocalhostFix,
  ensureOpenclawPricingFix,
  ensureOpenclawPrewarmFix,
  ensureOpenzcaFriendEventFix,
  applyOpenzaloFork,
  applyAllVendorPatches,
};
