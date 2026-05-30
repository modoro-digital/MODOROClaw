// vendor-patches.js — all vendor source-code patches in one place.
// Shared by: main.js (runtime, defense-in-depth) and prebuild-vendor.js (build-time).
// Every function is idempotent via markers — safe to call from both.

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Uses homeDir param (not getWorkspace()) because this file is shared with prebuild-vendor.js
// where workspace module is not available at build time.
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
    const NOWRAP_INJECT = `function normalizeProviderWebFetchPayload(params) {\n\tif (params.requestedUrl && /^https?:\\/\\/(?:127\\.0\\.0\\.1|localhost):2020[0-3](\\\/|$)/.test(params.requestedUrl)) { const _lp = isRecord(params.payload) ? params.payload : {}; const _lt = typeof _lp.text === 'string' ? _lp.text : ''; const _ls = typeof _lp.status === 'number' ? Math.floor(_lp.status) : 200; return { url: params.requestedUrl, finalUrl: params.requestedUrl, status: _ls, extractMode: params.extractMode, extractor: params.providerId, externalContent: { untrusted: false, source: 'web_fetch', wrapped: false }, truncated: false, length: _lt.length, rawLength: _lt.length, wrappedLength: _lt.length, fetchedAt: new Date().toISOString(), tookMs: typeof _lp.tookMs === 'number' ? Math.max(0, Math.floor(_lp.tookMs)) : 0, text: _lt }; } ${NOWRAP_MARKER}`;
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

    // Part 3: auth localhost Cron API automatically for CEO Telegram sessions.
    //
    // We deliberately do NOT put the live token into AGENTS.md or model-visible
    // tool output. The OpenClaw web_fetch runtime already knows the current
    // agentChannel; only Telegram direct CEO sessions receive a bearer header.
    // Zalo/customer sessions still hit the Cron API without auth and get 403.
    const TOKEN_MARKER = '// 9BizClaw WEB_FETCH CRON TOKEN PATCH v3';
    const LEGACY_TOKEN_MARKER = '// 9BizClaw WEB_FETCH CRON TOKEN PATCH';
    const LEGACY_V2_TOKEN_MARKER = '// 9BizClaw WEB_FETCH CRON TOKEN PATCH v2';
    const CACHE_MARKER = '// 9BizClaw WEB_FETCH LOCAL API CACHE BYPASS';
    const RUN_FUNC = 'async function runWebFetch(params) {';
    const HEADER_BLOCK = `init: { headers: {\n\t\t\t\tAccept: "text/markdown, text/html;q=0.9, */*;q=0.1",\n\t\t\t\t"User-Agent": params.userAgent,\n\t\t\t\t"Accept-Language": "en-US,en;q=0.9"\n\t\t\t} }`;
    const HEADER_HELPER = `async function maybeBuild9BizClawWebFetchHeaders(params) {\n\tconst headers = { Accept: "text/markdown, text/html;q=0.9, */*;q=0.1", "User-Agent": params.userAgent, "Accept-Language": "en-US,en;q=0.9" };\n\ttry {\n\t\tconst agentChannel = String(params.agentChannel || "").trim().toLowerCase();\n\t\tconst sessionKey = String(params.agentSessionKey || "");\n\t\tconst isTelegram = agentChannel === "telegram";\n\t\tif (isTelegram && /^https?:\\/\\/(?:127\\.0\\.0\\.1|localhost):2020[0-3](?:\\/|$)/.test(String(params.url || ""))) {\n\t\t\tconst candidates = [path.join(process.cwd(), "cron-api-token.txt")];\n\t\t\tif (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, "9bizclaw", "cron-api-token.txt"));\n\t\t\tfor (const tokenPath of candidates) {\n\t\t\t\ttry {\n\t\t\t\t\tconst token = String(await fs.readFile(tokenPath, "utf8")).trim();\n\t\t\t\t\tif (/^[a-f0-9]{48}$/i.test(token)) { headers.Authorization = "Bearer " + token; headers["X-9BizClaw-Agent-Channel"] = "telegram"; headers["X-Source-Channel"] = "telegram"; break; }\n\t\t\t\t} catch {}\n\t\t\t}\n\t\t}\n\t} catch {}\n\treturn headers;\n}\n${TOKEN_MARKER}\n`;
    const LEGACY_HELPER_RE = /async function maybeBuild9BizClawWebFetchHeaders\(params\) \{[\s\S]*?\/\/ 9BizClaw WEB_FETCH CRON TOKEN PATCH\n/;
    for (const file of toolFiles) {
      const fp = path.join(distDir, file);
      let src = fs.readFileSync(fp, 'utf-8');
      let changed = false;
      if (!src.includes(TOKEN_MARKER)) {
        // Remove any legacy version (v1 or v2) before re-injecting v3
        const LEGACY_V2_RE = /async function maybeBuild9BizClawWebFetchHeaders\(params\) \{[\s\S]*?\/\/ 9BizClaw WEB_FETCH CRON TOKEN PATCH v2\n/;
        if (LEGACY_V2_RE.test(src)) {
          src = src.replace(LEGACY_V2_RE, '');
          console.log('[web-fetch-token-fix] removed legacy v2 helper');
        }
        if (src.includes(LEGACY_TOKEN_MARKER) && LEGACY_HELPER_RE.test(src)) {
          src = src.replace(LEGACY_HELPER_RE, HEADER_HELPER);
          changed = true;
        } else if (!src.includes(RUN_FUNC)) {
          console.warn(`[web-fetch-token-fix] WARNING: ${file} runWebFetch anchor missing`);
          _logPatchFailure(homeDir, 'ensureWebFetchLocalhostFix-token-helper', `runWebFetch anchor missing in ${file}`);
        } else {
          src = src.replace(RUN_FUNC, HEADER_HELPER + RUN_FUNC);
          changed = true;
        }
      }
      if (src.includes(HEADER_BLOCK)) {
        src = src.replace(HEADER_BLOCK, 'init: { headers: await maybeBuild9BizClawWebFetchHeaders(params) }');
        changed = true;
      }
      // Part 3b: auto-convert localhost GET-with-params to POST-with-JSON-body.
      // web_fetch is GET-only (no method/body in schema). Vietnamese text in URL
      // query params gets mangled on Windows (codepage issue). POST with JSON body
      // is always UTF-8 safe.
      const POST_CONVERT_MARKER = '// 9BizClaw LOCALHOST AUTO-POST';
      const POST_CONVERT_ANCHOR = 'init: { headers: await maybeBuild9BizClawWebFetchHeaders(params) }';
      if (!src.includes(POST_CONVERT_MARKER) && src.includes(POST_CONVERT_ANCHOR)) {
        const POST_CONVERT_CODE = `(() => { const _h = maybeBuild9BizClawWebFetchHeaders(params); const _lre = /^https?:\\/\\/(?:127\\.0\\.0\\.1|localhost):2020[0-3]\\//; if (_lre.test(String(params.url || ""))) { const _u = new URL(params.url); if (typeof params.body === "string" && params.body.trim()) { return _h.then(h => ({ headers: { ...h, "Content-Type": "application/json; charset=utf-8" }, method: String(params.method || "POST").toUpperCase(), body: params.body })); } if (_u.search.length > 1) { const _b = {}; for (const [k,v] of _u.searchParams) _b[k] = v; _u.search = ""; params.url = _u.toString(); return _h.then(h => ({ headers: { ...h, "Content-Type": "application/json; charset=utf-8" }, method: "POST", body: JSON.stringify(_b) })); } return _h.then(h => ({ headers: h })); } return _h.then(h => ({ headers: h })); })() ${POST_CONVERT_MARKER}`;
        src = src.replace(POST_CONVERT_ANCHOR, 'init: await ' + POST_CONVERT_CODE);
        changed = true;
        console.log('[web-fetch-token-fix] added localhost auto-POST conversion');
      }
      const WEBFETCH_CACHE_BLOCK = 'const cacheKey = normalizeCacheKey(`fetch:${params.url}:${params.extractMode}:${params.maxChars}${allowRfc2544BenchmarkRange ? ":allow-rfc2544" : ""}`);\n\tconst cached = readCache(FETCH_CACHE, cacheKey);';
      if (!src.includes(CACHE_MARKER) && src.includes(WEBFETCH_CACHE_BLOCK)) {
        src = src.replace(WEBFETCH_CACHE_BLOCK, `${CACHE_MARKER}\n\tconst skip9BizClawLocalApiCache = /^https?:\\/\\/(?:127\\.0\\.0\\.1|localhost):2020[0-3](?:\\/|$)/.test(String(params.url || ""));\n\tconst cacheKey = normalizeCacheKey(\`fetch:\${params.url}:\${params.extractMode}:\${params.maxChars}\${allowRfc2544BenchmarkRange ? ":allow-rfc2544" : ""}\`);\n\tconst cached = skip9BizClawLocalApiCache ? null : readCache(FETCH_CACHE, cacheKey);`);
        changed = true;
      }
      const WEBFETCH_WRITE_CACHE_LINE = '\t\twriteCache(FETCH_CACHE, cacheKey, payload, params.cacheTtlMs);';
      if (src.includes(CACHE_MARKER) && src.includes(WEBFETCH_WRITE_CACHE_LINE)) {
        src = src.replace(WEBFETCH_WRITE_CACHE_LINE, '\t\tif (!skip9BizClawLocalApiCache) writeCache(FETCH_CACHE, cacheKey, payload, params.cacheTtlMs);');
        changed = true;
      }
      // Part 3d: compact successful localhost web_fetch results too. The earlier
      // nowrap patch only covered provider fallback responses; direct successful
      // JSON responses still included SECURITY NOTICE wrappers and echoed huge
      // prompt URLs in finalUrl, which can overflow long AUTO-MODE tool loops.
      const DIRECT_COMPACT_MARKER = '// 9BizClaw LOCALHOST DIRECT COMPACT';
      const DIRECT_COMPACT_ANCHOR = 'const wrappedWarning = wrapWebFetchField(responseTruncatedWarning);\n\t\tconst payload = {';
      if (!src.includes(DIRECT_COMPACT_MARKER) && src.includes(DIRECT_COMPACT_ANCHOR)) {
        const DIRECT_COMPACT_CODE = `const wrappedWarning = wrapWebFetchField(responseTruncatedWarning);\n\t\tif (/^https?:\\/\\/(?:127\\.0\\.0\\.1|localhost):2020[0-3](?:\\/|$)/.test(String(params.url || finalUrl || ""))) { const _lw = wrapWebFetchContent(text, params.maxChars); const _scrub = (_url) => { try { const _u = new URL(String(_url || params.url || "")); if (/^(?:127\\.0\\.0\\.1|localhost)$/i.test(_u.hostname) && _u.pathname.startsWith("/api/")) { _u.search = ""; return _u.toString(); } } catch {} return String(_url || params.url || ""); }; return { url: _scrub(params.url), finalUrl: _scrub(finalUrl), status: res.status, contentType: normalizedContentType, title: wrappedTitle, extractMode: params.extractMode, extractor, externalContent: { untrusted: false, source: "web_fetch", wrapped: false }, truncated: _lw.truncated, length: _lw.wrappedLength, rawLength: _lw.rawLength, wrappedLength: _lw.wrappedLength, fetchedAt: new Date().toISOString(), tookMs: Date.now() - start, text: _lw.text, warning: wrappedWarning }; } ${DIRECT_COMPACT_MARKER}\n\t\tconst payload = {`;
        src = src.replace(DIRECT_COMPACT_ANCHOR, DIRECT_COMPACT_CODE);
        changed = true;
      }
      const WEBFETCH_OPTIONS_BLOCK = `const webFetchTool = createWebFetchTool({\n\t\tconfig: options?.config,\n\t\tsandboxed: options?.sandboxed,\n\t\truntimeWebFetch: runtimeWebTools?.fetch\n\t});`;
      if (src.includes(WEBFETCH_OPTIONS_BLOCK)) {
        src = src.replace(WEBFETCH_OPTIONS_BLOCK, `const webFetchTool = createWebFetchTool({\n\t\tconfig: options?.config,\n\t\tsandboxed: options?.sandboxed,\n\t\truntimeWebFetch: runtimeWebTools?.fetch,\n\t\tagentSessionKey: options?.agentSessionKey,\n\t\tagentChannel: options?.agentChannel\n\t});`);
        changed = true;
      }
      const WEBFETCH_OPTIONS_SESSION_ONLY_BLOCK = `const webFetchTool = createWebFetchTool({\n\t\tconfig: options?.config,\n\t\tsandboxed: options?.sandboxed,\n\t\truntimeWebFetch: runtimeWebTools?.fetch,\n\t\tagentSessionKey: options?.agentSessionKey\n\t});`;
      if (src.includes(WEBFETCH_OPTIONS_SESSION_ONLY_BLOCK)) {
        src = src.replace(WEBFETCH_OPTIONS_SESSION_ONLY_BLOCK, `const webFetchTool = createWebFetchTool({\n\t\tconfig: options?.config,\n\t\tsandboxed: options?.sandboxed,\n\t\truntimeWebFetch: runtimeWebTools?.fetch,\n\t\tagentSessionKey: options?.agentSessionKey,\n\t\tagentChannel: options?.agentChannel\n\t});`);
        changed = true;
      }
      const WEBFETCH_RUN_PARAMS_BLOCK = `lookupFn: options?.lookupFn,\n\t\t\t\tresolveProviderFallback\n\t\t\t}));`;
      if (src.includes(WEBFETCH_RUN_PARAMS_BLOCK)) {
        src = src.replace(WEBFETCH_RUN_PARAMS_BLOCK, `lookupFn: options?.lookupFn,\n\t\t\t\tresolveProviderFallback,\n\t\t\t\tagentSessionKey: options?.agentSessionKey,\n\t\t\t\tagentChannel: options?.agentChannel\n\t\t\t}));`);
        changed = true;
      }
      const WEBFETCH_RUN_PARAMS_SESSION_ONLY_BLOCK = `lookupFn: options?.lookupFn,\n\t\t\t\tresolveProviderFallback,\n\t\t\t\tagentSessionKey: options?.agentSessionKey\n\t\t\t}));`;
      if (src.includes(WEBFETCH_RUN_PARAMS_SESSION_ONLY_BLOCK)) {
        src = src.replace(WEBFETCH_RUN_PARAMS_SESSION_ONLY_BLOCK, `lookupFn: options?.lookupFn,\n\t\t\t\tresolveProviderFallback,\n\t\t\t\tagentSessionKey: options?.agentSessionKey,\n\t\t\t\tagentChannel: options?.agentChannel\n\t\t\t}));`);
        changed = true;
      }
      if (changed) {
        fs.writeFileSync(fp, src, 'utf-8');
        console.log('[web-fetch-token-fix] applied to', file);
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
// OpenClaw self-update disable: hide upstream update UI and disable update.run
// ---------------------------------------------------------------------------

function ensureOpenclawUpdateUiDisabled(vendorDir, homeDir) {
  try {
    if (!vendorDir) return;
    const distDir = path.join(vendorDir, 'node_modules', 'openclaw', 'dist');
    if (!fs.existsSync(distDir)) return;

    let patchedCount = 0;

    const serverFiles = fs.readdirSync(distDir).filter(f => /^server\.impl-[A-Za-z0-9_-]+\.js$/.test(f));
    for (const fname of serverFiles) {
      const filePath = path.join(distDir, fname);
      let content;
      try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
      let next = content;

      const updateCheckMarker = '9BIZCLAW_OPENCLAW_UPDATE_CHECK_DISABLED';
      if (!next.includes(updateCheckMarker)) {
        next = next.replace(
          'function getUpdateAvailable() {',
          'function getUpdateAvailable() {\n\treturn null; // ' + updateCheckMarker
        );
        next = next.replace(
          'function scheduleGatewayUpdateCheck(params) {',
          'function scheduleGatewayUpdateCheck(params) {\n\treturn () => {}; // ' + updateCheckMarker
        );
      }

      const updateRunMarker = '9BIZCLAW_OPENCLAW_UPDATE_RUN_DISABLED';
      if (!next.includes(updateRunMarker)) {
        next = next.replace(
          'const updateHandlers = { "update.run": async ({ params, respond, client, context }) => {',
          'const updateHandlers = { "update.run": async ({ params, respond, client, context }) => {\n\trespond(true, { ok: false, result: { status: "disabled", reason: "OpenClaw self-update is disabled in 9BizClaw." } }, void 0); return; // ' + updateRunMarker
        );
      }

      if (next !== content) {
        fs.writeFileSync(filePath, next, 'utf-8');
        patchedCount++;
        console.log(`[openclaw-update-disable] patched server ${fname}`);
      } else if (!content.includes(updateCheckMarker) || !content.includes(updateRunMarker)) {
        _logPatchFailure(homeDir, 'ensureOpenclawUpdateUiDisabled', `server anchors missing in ${fname}`);
      }
    }

    const statusFiles = fs.readdirSync(distDir).filter(f => /^status\.update-[A-Za-z0-9_-]+\.js$/.test(f));
    for (const fname of statusFiles) {
      const filePath = path.join(distDir, fname);
      let content;
      try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
      const marker = '9BIZCLAW_OPENCLAW_UPDATE_CHECK_DISABLED';
      if (content.includes(marker)) continue;
      let next = content
        .replace(
          'function resolveUpdateAvailability(update) {',
          'function resolveUpdateAvailability(update) {\n\treturn { available: false, hasGitUpdate: false, hasRegistryUpdate: false, latestVersion: null, gitBehind: null }; // ' + marker
        )
        .replace(
          'function formatUpdateAvailableHint(update) {',
          'function formatUpdateAvailableHint(update) {\n\treturn null; // ' + marker
        );
      if (next !== content) {
        fs.writeFileSync(filePath, next, 'utf-8');
        patchedCount++;
        console.log(`[openclaw-update-disable] patched status ${fname}`);
      } else {
        _logPatchFailure(homeDir, 'ensureOpenclawUpdateUiDisabled', `status anchors missing in ${fname}`);
      }
    }

    const controlAssetsDir = path.join(distDir, 'control-ui', 'assets');
    if (fs.existsSync(controlAssetsDir)) {
      const uiFiles = fs.readdirSync(controlAssetsDir).filter(f => f.endsWith('.js'));
      for (const fname of uiFiles) {
        const filePath = path.join(controlAssetsDir, fname);
        let content;
        try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
        let next = content;
        const marker = '9BIZCLAW_OPENCLAW_UPDATE_UI_DISABLED';
        if (next.includes(marker)) continue;

        next = next.replace(
          'e.updateAvailable&&e.updateAvailable.latestVersion!==e.updateAvailable.currentVersion&&!GM(e.updateAvailable)?i`<div class="update-banner callout danger"',
          'false&&e.updateAvailable&&e.updateAvailable.latestVersion!==e.updateAvailable.currentVersion&&!GM(e.updateAvailable)?i`<div class="update-banner callout danger"'
        );
        next = next.replace(
          'async function Or(e){',
          'async function Or(e){return;/* 9BIZCLAW_OPENCLAW_UPDATE_RUN_DISABLED */'
        );
        next = next.replace(
          /<button class="btn btn--sm" \?disabled=\$\{!ne\} @click=\$\{e\.onUpdate\}>[\s\S]*?\$\{e\.updating\?`Updating…`:`Update`\}\s*<\/button>/,
          ''
        );
        next = next.replace('{key:`update`,label:`Updates`},', '');

        if (next !== content) {
          if (!next.includes(marker)) next += `\n/* ${marker} */\n`;
          fs.writeFileSync(filePath, next, 'utf-8');
          patchedCount++;
          console.log(`[openclaw-update-disable] patched ui ${fname}`);
        }
      }
    }

    if (patchedCount > 0) console.log(`[openclaw-update-disable] ${patchedCount} file(s) patched`);
  } catch (e) {
    console.warn('[openclaw-update-disable] error:', e?.message);
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
// applyAllVendorPatches — one call from boot or build script
// ---------------------------------------------------------------------------

function applyAllVendorPatches({ vendorDir, homeDir, workspaceDir }) {
  const results = {};

  // Openclaw dist patches (build-time safe)
  results.pricing = _tryPatch('pricing', () => ensureOpenclawPricingFix(vendorDir));
  results.prewarm = _tryPatch('prewarm', () => ensureOpenclawPrewarmFix(vendorDir));
  results.openclawUpdate = _tryPatch('openclawUpdate', () => ensureOpenclawUpdateUiDisabled(vendorDir, homeDir));
  results.vision = _tryPatch('vision', () => ensureVisionFix(vendorDir, homeDir));
  results.visionCatalog = _tryPatch('visionCatalog', () => ensureVisionCatalogFix(vendorDir, homeDir));
  results.visionSerialization = _tryPatch('visionSerialization', () => ensureVisionSerializationFix(vendorDir, homeDir));
  results.ssrf = _tryPatch('ssrf', () => ensureWebFetchLocalhostFix(vendorDir, homeDir));
  results.friendEvent = _tryPatch('friendEvent', () => ensureOpenzcaFriendEventFix(vendorDir, workspaceDir));
  results.authCacheTtl = _tryPatch('authCacheTtl', () => ensureAuthCacheTtlExtension(vendorDir));
  results.sessionFreeze = _tryPatch('sessionFreeze', () => ensureSessionFreezePatches(vendorDir));

  return results;
}

function _tryPatch(name, fn) {
  try { fn(); return 'ok'; }
  catch (e) { console.error(`[vendor-patches] ${name} failed:`, e?.message); return 'error'; }
}

// ---------------------------------------------------------------------------
// Auth cache TTL extension (15min → 1hr)
// openclaw caches auth-profiles for 15min (9e5 ms). After 15min idle, next
// message pays full auth sync cost (~10-15s). Extending to 1hr (36e5) keeps
// the cache warm for typical CEO usage patterns.
// ---------------------------------------------------------------------------

function ensureAuthCacheTtlExtension(vendorDir) {
  if (!vendorDir) return;
  const distDir = path.join(vendorDir, 'node_modules', 'openclaw', 'dist');
  if (!fs.existsSync(distDir)) return;
  // Find store file by content (hash suffix changes on update)
  const files = fs.readdirSync(distDir).filter(f => f.startsWith('store-') && f.endsWith('.js'));
  for (const file of files) {
    const fp = path.join(distDir, file);
    let content;
    try { content = fs.readFileSync(fp, 'utf-8'); } catch { continue; }
    if (!content.includes('syncedAtMs')) continue;
    // Already patched?
    const AUTH_TTL_MARKER = '/* 9BizClaw AUTH_CACHE_TTL_EXTENDED */';
    if (content.includes(AUTH_TTL_MARKER)) {
      console.log('[vendor-patches] auth-cache-ttl: already patched');
      return;
    }
    // Find and replace the TTL
    const original = 'Date.now() - cached.syncedAtMs >= 9e5';
    if (!content.includes(original)) {
      console.warn('[vendor-patches] auth-cache-ttl: anchor not found in ' + file);
      return;
    }
    const patched = content.replace(original, 'Date.now() - cached.syncedAtMs >= 36e5 ' + AUTH_TTL_MARKER);
    fs.writeFileSync(fp, patched, 'utf-8');
    console.log(`[vendor-patches] auth-cache-ttl: extended 15min → 1hr in ${file}`);
    return;
  }
  console.warn('[vendor-patches] auth-cache-ttl: no store file with syncedAtMs found');
}

// ---------------------------------------------------------------------------
// Session Freeze: Bootstrap file cache (Patch 1/3)
// ---------------------------------------------------------------------------

function ensureBootstrapFileCache(vendorDir) {
  if (!vendorDir) return;
  const distDir = path.join(vendorDir, 'node_modules', 'openclaw', 'dist');
  if (!fs.existsSync(distDir)) return;
  const files = fs.readdirSync(distDir).filter(f => f.startsWith('bootstrap-files-') && f.endsWith('.js'));
  for (const file of files) {
    const fp = path.join(distDir, file);
    let content;
    try { content = fs.readFileSync(fp, 'utf-8'); } catch { continue; }
    if (!content.includes('resolveBootstrapContextForRun')) continue;
    const MARKER = '/* 9BizClaw SESSION_FREEZE_BOOTSTRAP */';
    if (content.includes(MARKER)) {
      console.log('[session-freeze] bootstrap-cache: already patched');
      return;
    }
    // Replace the entire function (small, 10 lines) with a cached version
    const originalFunc =
      'async function resolveBootstrapContextForRun(params) {\n' +
      '\tconst bootstrapFiles = await resolveBootstrapFilesForRun(params);\n' +
      '\treturn {\n' +
      '\t\tbootstrapFiles,\n' +
      '\t\tcontextFiles: buildBootstrapContextFiles(bootstrapFiles, {\n' +
      '\t\t\tmaxChars: resolveBootstrapMaxChars(params.config),\n' +
      '\t\t\ttotalMaxChars: resolveBootstrapTotalMaxChars(params.config),\n' +
      '\t\t\twarn: params.warn\n' +
      '\t\t})\n' +
      '\t};\n' +
      '}';
    if (!content.includes(originalFunc)) {
      console.warn('[session-freeze] bootstrap-cache: full function anchor not found in ' + file + ' — upstream may have changed');
      return;
    }
    const cachedFunc =
      `async function resolveBootstrapContextForRun(params) { ${MARKER}\n` +
      '\tconst __sfT0 = Date.now();\n' +
      '\tconst __sfSyncFs = (await import(\'node:fs\')).default;\n' +
      '\tconst __sfWs = params.workspaceDir || \'\';\n' +
      '\tconst __sfCache = global.__mcBootstrapCache || (global.__mcBootstrapCache = new Map());\n' +
      '\tconst __sfEntry = __sfCache.get(__sfWs);\n' +
      '\tif (__sfEntry) {\n' +
      '\t\tlet __sfOk = true;\n' +
      '\t\tfor (const [__sfF, __sfMt] of Object.entries(__sfEntry.mt)) {\n' +
      '\t\t\ttry { if (__sfSyncFs.statSync(__sfF).mtimeMs !== __sfMt) { __sfOk = false; break; } }\n' +
      '\t\t\tcatch { __sfOk = false; break; }\n' +
      '\t\t}\n' +
      '\t\tif (__sfOk) { console.log(`[session-freeze] bootstrap CACHE HIT (${Date.now()-__sfT0}ms)`); return { bootstrapFiles: [...__sfEntry.r.bootstrapFiles], contextFiles: [...__sfEntry.r.contextFiles] }; }\n' +
      '\t\tconsole.log(`[session-freeze] bootstrap CACHE MISS — mtime changed (${Date.now()-__sfT0}ms)`);\n' +
      '\t}\n' +
      '\tconst bootstrapFiles = await resolveBootstrapFilesForRun(params);\n' +
      '\tconst result = {\n' +
      '\t\tbootstrapFiles,\n' +
      '\t\tcontextFiles: buildBootstrapContextFiles(bootstrapFiles, {\n' +
      '\t\t\tmaxChars: resolveBootstrapMaxChars(params.config),\n' +
      '\t\t\ttotalMaxChars: resolveBootstrapTotalMaxChars(params.config),\n' +
      '\t\t\twarn: params.warn\n' +
      '\t\t})\n' +
      '\t};\n' +
      '\tconst __sfMt = {};\n' +
      '\tfor (const bf of bootstrapFiles) {\n' +
      '\t\tif (bf.path) try { __sfMt[bf.path] = __sfSyncFs.statSync(bf.path).mtimeMs; } catch {}\n' +
      '\t}\n' +
      '\t__sfCache.set(__sfWs, { r: result, mt: __sfMt });\n' +
      '\tconsole.log(`[session-freeze] bootstrap CACHE MISS — cold (${Date.now()-__sfT0}ms, ${bootstrapFiles.length} files)`);\n' +
      '\treturn { bootstrapFiles: [...result.bootstrapFiles], contextFiles: [...result.contextFiles] };\n' +
      '}';
    const patched = content.replace(originalFunc, cachedFunc);
    if (patched !== content) {
      fs.writeFileSync(fp, patched, 'utf-8');
      console.log(`[session-freeze] bootstrap-cache: applied to ${file}`);
    }
    return;
  }
  console.warn('[session-freeze] bootstrap-cache: no bootstrap-files file found');
}

// ---------------------------------------------------------------------------
// Session Freeze: External CLI sync skip (Patch 2/3)
// ---------------------------------------------------------------------------

function ensureExternalCliSyncSkip(vendorDir) {
  if (!vendorDir) return;
  const distDir = path.join(vendorDir, 'node_modules', 'openclaw', 'dist');
  if (!fs.existsSync(distDir)) return;
  const files = fs.readdirSync(distDir).filter(f => f.startsWith('store-') && f.endsWith('.js'));
  for (const file of files) {
    const fp = path.join(distDir, file);
    let content;
    try { content = fs.readFileSync(fp, 'utf-8'); } catch { continue; }
    if (!content.includes('shouldSyncExternalCliCredentials')) continue;
    const MARKER = '/* 9BizClaw SESSION_FREEZE_CLI_SYNC */';
    if (content.includes(MARKER)) {
      console.log('[session-freeze] cli-sync-skip: already patched');
      return;
    }
    const anchor = 'function shouldSyncExternalCliCredentials(options) {\n\treturn options?.syncExternalCli !== false;\n}';
    if (!content.includes(anchor)) {
      console.warn('[session-freeze] cli-sync-skip: anchor not found in ' + file);
      return;
    }
    const patched = content.replace(anchor,
      `function shouldSyncExternalCliCredentials(options) { ${MARKER}\n` +
      `\tif (global.__mcCliSyncDone) { console.log('[session-freeze] cli-sync SKIPPED (already synced this boot)'); return false; }\n` +
      `\treturn options?.syncExternalCli !== false;\n` +
      `}`
    );
    if (patched !== content) {
      fs.writeFileSync(fp, patched, 'utf-8');
      console.log(`[session-freeze] cli-sync-skip: applied to ${file}`);
    }
    // Also mark sync as done after first successful sync
    const syncAnchor = 'if (shouldSyncExternalCliCredentials(options)) syncExternalCliCredentialsTimed(asStore';
    if (patched.includes(syncAnchor)) {
      const syncPatched = patched.replace(syncAnchor,
        'if (shouldSyncExternalCliCredentials(options)) { syncExternalCliCredentialsTimed(asStore'
      ).replace(
        'syncExternalCliCredentialsTimed(asStore, { log: !readOnly });',
        'syncExternalCliCredentialsTimed(asStore, { log: !readOnly }); global.__mcCliSyncDone = true; }'
      );
      if (syncPatched !== patched) {
        fs.writeFileSync(fp, syncPatched, 'utf-8');
        console.log(`[session-freeze] cli-sync-done-marker: applied to ${file}`);
      }
    }
    return;
  }
  console.warn('[session-freeze] cli-sync-skip: no store file found');
}

// ---------------------------------------------------------------------------
// Session Freeze: System prompt freeze (Patch 3/3)
// ---------------------------------------------------------------------------

function ensureSystemPromptFreeze(vendorDir) {
  if (!vendorDir) return;
  const distDir = path.join(vendorDir, 'node_modules', 'openclaw', 'dist');
  if (!fs.existsSync(distDir)) return;
  const files = fs.readdirSync(distDir).filter(f => f.startsWith('pi-embedded-runner-') && f.endsWith('.js'));
  for (const file of files) {
    const fp = path.join(distDir, file);
    let content;
    try { content = fs.readFileSync(fp, 'utf-8'); } catch { continue; }
    if (!content.includes('createSystemPromptOverride')) continue;
    const MARKER = '/* 9BizClaw SESSION_FREEZE_PROMPT */';
    if (content.includes(MARKER)) {
      console.log('[session-freeze] prompt-freeze: already patched');
      return;
    }
    const anchor = 'let systemPromptText = createSystemPromptOverride(appendPrompt)();';
    if (!content.includes(anchor)) {
      console.warn('[session-freeze] prompt-freeze: anchor not found in ' + file);
      return;
    }
    const replacement = `${MARKER}
\t\t\tconst __sfPT0 = Date.now();
\t\t\tconst __sfPHash = crypto.createHash('sha256').update(appendPrompt).digest('hex');
\t\t\tlet systemPromptText;
\t\t\tif (global.__mcPromptHash === __sfPHash && global.__mcPromptText) {
\t\t\t\tsystemPromptText = global.__mcPromptText;
\t\t\t\tconsole.log(\`[session-freeze] prompt CACHE HIT (\${Date.now()-__sfPT0}ms, hash=\${__sfPHash.slice(0,8)})\`);
\t\t\t} else {
\t\t\t\tsystemPromptText = createSystemPromptOverride(appendPrompt)();
\t\t\t\tglobal.__mcPromptHash = __sfPHash;
\t\t\t\tglobal.__mcPromptText = systemPromptText;
\t\t\t\tconsole.log(\`[session-freeze] prompt CACHE MISS (\${Date.now()-__sfPT0}ms, \${appendPrompt.length} chars, hash=\${__sfPHash.slice(0,8)})\`);
\t\t\t}`;
    const patched = content.replace(anchor, replacement);
    if (patched !== content) {
      fs.writeFileSync(fp, patched, 'utf-8');
      console.log(`[session-freeze] prompt-freeze: applied to ${file}`);
    }
    return;
  }
  console.warn('[session-freeze] prompt-freeze: no pi-embedded-runner file found');
}

// ---------------------------------------------------------------------------
// Session Freeze: apply all 3 patches
// ---------------------------------------------------------------------------

function ensureSessionFreezePatches(vendorDir) {
  if (process.env.MODOROCLAW_DISABLE_SESSION_FREEZE === '1') {
    console.log('[session-freeze] disabled via MODOROCLAW_DISABLE_SESSION_FREEZE=1');
    return;
  }
  ensureBootstrapFileCache(vendorDir);
  ensureExternalCliSyncSkip(vendorDir);
  ensureSystemPromptFreeze(vendorDir);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  ensureVisionFix,
  ensureVisionCatalogFix,
  ensureVisionSerializationFix,
  ensureWebFetchLocalhostFix,
  ensureOpenclawPricingFix,
  ensureOpenclawPrewarmFix,
  ensureOpenclawUpdateUiDisabled,
  ensureOpenzcaFriendEventFix,
  ensureAuthCacheTtlExtension,
  ensureSessionFreezePatches,
  applyAllVendorPatches,
};
