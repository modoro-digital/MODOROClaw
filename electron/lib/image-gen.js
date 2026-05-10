// gpt-image-2 via 9router Codex Responses API — async job manager

const http = require('http');
const fs = require('fs');
const path = require('path');

const NINE_ROUTER_BASE = 'http://127.0.0.1:20128';
const JOB_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_GENERATED = 20;
const MAX_ASSET_B64_SIZE = 4 * 1024 * 1024;
const JOB_TTL_MS = 30 * 60 * 1000;
const MAX_JOBS = 50;
const IMAGE_ASSET_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const IMAGE_ASSET_TYPES = new Set(['brand', 'product', 'generated', 'knowledge_image', 'pdf_page']);

const VALID_IMAGE_SIZES = new Set([
  '1024x1024', '1024x1536', '1536x1024',
  '1024x1792', '1792x1024', 'auto',
]);
const SIZE_ALIASES = {
  landscape: '1792x1024', ngang: '1792x1024', horizontal: '1792x1024', wide: '1792x1024',
  portrait: '1024x1792', doc: '1024x1792', dọc: '1024x1792', vertical: '1024x1792', tall: '1024x1792',
  square: '1024x1024', vuông: '1024x1024', vuong: '1024x1024',
};

function normalizeImageSize(raw) {
  if (!raw) return '1024x1024';
  const s = String(raw).trim().toLowerCase();
  if (SIZE_ALIASES[s]) return SIZE_ALIASES[s];
  if (VALID_IMAGE_SIZES.has(s)) return s;
  if (/^\d{3,4}x\d{3,4}$/.test(s)) return s;
  return '1024x1024';
}

const _jobs = new Map();

function generateJobId() {
  return 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
}

function pruneJobs() {
  if (_jobs.size <= MAX_JOBS) return;
  const now = Date.now();
  for (const [id, job] of _jobs) {
    if (now - job.startedAt > JOB_TTL_MS) _jobs.delete(id);
  }
  if (_jobs.size <= MAX_JOBS) return;
  const sorted = [..._jobs.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt);
  while (sorted.length > MAX_JOBS) {
    const [id] = sorted.shift();
    _jobs.delete(id);
  }
}

function isAssetPathSafe(baseDir, filename) {
  if (!filename || typeof filename !== 'string') return false;
  if (filename.includes('\0')) return false;
  const resolved = path.resolve(baseDir, filename);
  return resolved.startsWith(baseDir + path.sep) || resolved === baseDir;
}

function isSupportedAssetImage(filePath) {
  return IMAGE_ASSET_EXTENSIONS.has(path.extname(filePath || '').toLowerCase());
}

function resolveAssetPath(brandAssetsDir, name) {
  if (!name || typeof name !== 'string') return null;
  if (isAssetPathSafe(brandAssetsDir, name)) {
    const resolved = path.resolve(brandAssetsDir, name);
    if (fs.existsSync(resolved) && isSupportedAssetImage(resolved)) return resolved;
  }
  try {
    const media = require('./media-library');
    const asset = media.findMediaAsset(name);
    if (asset?.path && IMAGE_ASSET_TYPES.has(asset.type) && fs.existsSync(asset.path) && isSupportedAssetImage(asset.path)) {
      return asset.path;
    }
  } catch {}
  return null;
}

function loadAssets(brandAssetsDir, assetNames) {
  console.log(`[image-gen] loadAssets called: brandDir=${brandAssetsDir}, names=${JSON.stringify(assetNames)}`);
  const loaded = [];
  const skipped = [];
  for (const name of assetNames) {
    const resolved = resolveAssetPath(brandAssetsDir, name);
    if (!resolved || !fs.existsSync(resolved)) {
      console.warn(`[image-gen] asset SKIP "${name}": resolved=${resolved}, exists=${resolved ? fs.existsSync(resolved) : false}`);
      skipped.push({ name, reason: 'not_found' });
      continue;
    }
    let buf;
    try {
      buf = fs.readFileSync(resolved);
    } catch (e) {
      console.error(`[image-gen] asset READ FAILED "${name}": ${e.message}`);
      skipped.push({ name, reason: 'read_error', error: e.message });
      continue;
    }
    if (!buf || buf.length === 0) {
      console.warn(`[image-gen] asset SKIP "${name}": file is empty (0 bytes)`);
      skipped.push({ name, reason: 'empty_file' });
      continue;
    }
    const b64Len = Math.ceil(buf.length / 3) * 4;
    if (b64Len > MAX_ASSET_B64_SIZE) {
      const sizeMB = (b64Len / 1024 / 1024).toFixed(1);
      console.error(`[image-gen] asset REJECTED "${name}": ${sizeMB} MB exceeds ${(MAX_ASSET_B64_SIZE / 1024 / 1024).toFixed(0)} MB limit`);
      skipped.push({ name, reason: 'too_large', sizeMB });
      continue;
    }
    const b64 = buf.toString('base64');
    const ext = path.extname(resolved).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    loaded.push({ name: path.basename(resolved), base64: b64, mime });
    console.log(`[image-gen] asset LOADED "${name}" → ${resolved} (${(buf.length / 1024).toFixed(0)} KB, ${mime})`);
  }
  console.log(`[image-gen] loadAssets result: ${loaded.length} loaded, ${skipped.length} skipped of ${assetNames.length} requested`);
  return { loaded, skipped };
}

const BRAND_ASSET_PREFIX = 'CRITICAL INSTRUCTION: The attached reference image(s) are brand assets. You MUST reproduce them EXACTLY as they appear — preserve every detail: exact colors, exact shapes, exact text/typography, exact proportions, exact art style. Do NOT redraw, reinterpret, reimagine, or stylize them. Composite the ORIGINAL image unchanged into the scene.\n\n';

function get9RouterApiKey() {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.openclaw', 'openclaw.json'), 'utf-8'));
    return cfg?.models?.providers?.ninerouter?.apiKey || null;
  } catch { return null; }
}

function findImageConnectionId() {
  try {
    const { primary } = findAllImageConnectionIds();
    return primary[0] || null;
  } catch { return null; }
}

function categorizeCodexConnections(conns) {
  const codex = conns.filter(c =>
    c.provider === 'codex' && c.isActive !== false &&
    typeof c['modelLock_gpt-5.4-image'] !== 'string'
  );
  const plus = codex.filter(c => c.providerSpecificData?.chatgptPlanType === 'plus');
  const team = codex.filter(c => c.providerSpecificData?.chatgptPlanType === 'team');
  const free = codex.filter(c => {
    const plan = c.providerSpecificData?.chatgptPlanType;
    return !plan || plan === 'free';
  });
  return {
    primary: [...plus.map(c => c.id), ...team.map(c => c.id)],
    free: free.map(c => c.id),
  };
}

function findAllImageConnectionIds() {
  const result = { primary: [], free: [] };
  try {
    const appData = process.env.APPDATA || (process.platform === 'darwin'
      ? path.join(process.env.HOME || '', 'Library', 'Application Support')
      : process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config'));
    const dbPath = path.join(appData, '9router', 'db.json');
    if (!fs.existsSync(dbPath)) {
      console.warn('[image-gen] 9router db.json not found at', dbPath);
      return result;
    }
    const db = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
    const conns = db.providerConnections || db.connections || db.providers || [];
    if (!Array.isArray(conns) || conns.length === 0) {
      console.warn('[image-gen] no provider connections in db.json (keys: ' + Object.keys(db).join(', ') + ')');
      return result;
    }
    const cat = categorizeCodexConnections(conns);
    if (cat.primary.length === 0 && cat.free.length === 0) {
      const allCodex = conns.filter(c => c.provider === 'codex');
      console.warn(`[image-gen] 0 eligible codex connections (${allCodex.length} total codex, ${conns.length} total providers)`);
      if (allCodex.length > 0) {
        console.warn('[image-gen] codex exclusion reasons:', allCodex.map(c =>
          `${(c.id || '').slice(0, 8)}: isActive=${c.isActive}, modelLock=${c['modelLock_gpt-5.4-image']}`
        ).join('; '));
      }
    }
    result.primary = cat.primary;
    result.free = cat.free;
  } catch (e) {
    console.error('[image-gen] findAllImageConnectionIds error:', e.message);
  }
  return result;
}

function buildCodexRequest(prompt, assets, size, options = {}) {
  const normalizedSize = normalizeImageSize(size);
  const finalPrompt = assets.length > 0 ? BRAND_ASSET_PREFIX + prompt : prompt;
  console.log(`[image-gen] buildCodexRequest: ${assets.length} assets attached, size=${normalizedSize}, hasPrefix=${assets.length > 0}, promptLen=${finalPrompt.length}`);
  if (assets.length > 0) console.log(`[image-gen] attached assets: ${assets.map(a => a.name + ' (' + (a.base64.length / 1024).toFixed(0) + 'KB b64)').join(', ')}`);
  const content = [{ type: 'input_text', text: finalPrompt }];
  for (const asset of assets) {
    content.push({
      type: 'input_image',
      image_url: `data:${asset.mime};base64,${asset.base64}`
    });
  }
  const body = {
    model: 'cx/gpt-5.4',
    input: [{ role: 'user', content }],
    tools: [{ type: 'image_generation', model: 'gpt-image-2', size: normalizedSize, quality: 'high' }],
    stream: true,
    store: false
  };
  if (options.toolChoice !== false) body.tool_choice = { type: 'image_generation' };
  return body;
}

function findConnectionIdsViaApi() {
  return new Promise(resolve => {
    const req = http.request({
      hostname: '127.0.0.1', port: 20128,
      path: '/api/providers', method: 'GET',
      headers: { 'Accept': 'application/json' },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const body = JSON.parse(data);
          // API returns { connections: [...] } — different key from db.json's providerConnections
          const conns = body.connections || body.providers || body.providerConnections || [];
          const cat = categorizeCodexConnections(Array.isArray(conns) ? conns : []);
          const ids = [...cat.primary, ...cat.free];
          console.log(`[image-gen] API fallback found ${ids.length} codex connections`);
          resolve(ids);
        } catch (e) {
          console.warn('[image-gen] API fallback parse error:', e.message);
          resolve([]);
        }
      });
    });
    req.on('error', (e) => {
      console.warn('[image-gen] API fallback request error:', e.message);
      resolve([]);
    });
    req.setTimeout(5000, () => { req.destroy(); resolve([]); });
    req.end();
  });
}

function parseSSEForImage(rawData) {
  const lines = rawData.split('\n');
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    try {
      const evt = JSON.parse(line.slice(6));
      if (evt.type === 'response.output_item.done' &&
          evt.item?.type === 'image_generation_call' &&
          evt.item?.result) {
        return Buffer.from(evt.item.result, 'base64');
      }
    } catch {}
  }
  const match = rawData.match(/"result":"(iVBOR[A-Za-z0-9+/=]+)"/);
  if (match) return Buffer.from(match[1], 'base64');
  return null;
}

function callCodexAPI(requestBody, connectionId) {
  return new Promise((resolve, reject) => {
    const apiKey = get9RouterApiKey();
    if (!apiKey) return reject(new Error('9Router API key not configured'));
    const connId = connectionId || findImageConnectionId();
    if (!connId) return reject(new Error('No codex provider connection available for image generation'));
    const payload = JSON.stringify(requestBody);
    const url = new URL(NINE_ROUTER_BASE + '/codex/responses');
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'Authorization': `Bearer ${apiKey}`,
      'x-connection-id': connId,
    };
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname,
      method: 'POST', headers,
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`9router ${res.statusCode}: ${data.slice(0, 300)}`));
        const imgBuf = parseSSEForImage(data);
        if (!imgBuf) return reject(new Error('No image in response'));
        resolve(imgBuf);
      });
    });
    req.on('error', reject);
    req.setTimeout(JOB_TIMEOUT_MS, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

function isImageToolChoiceUnsupported(err) {
  return /tool choice ['"]?image_generation['"]? not found|image_generation.*not found in ['"]?tools/i.test(err?.message || '');
}

async function callCodexAPIWithFallback(prompt, assets, size) {
  let { primary, free } = findAllImageConnectionIds();
  let allIds = [...primary, ...free];
  if (allIds.length === 0) {
    const apiIds = await findConnectionIdsViaApi();
    allIds = apiIds;
  }
  if (allIds.length === 0) throw new Error('No codex provider connection available for image generation');

  let lastErr = null;
  for (const connId of allIds) {
    const body = buildCodexRequest(prompt, assets, size);
    try {
      return await callCodexAPI(body, connId);
    } catch (err) {
      lastErr = err;
      if (isImageToolChoiceUnsupported(err)) {
        try {
          const noTc = buildCodexRequest(prompt, assets, size, { toolChoice: false });
          return await callCodexAPI(noTc, connId);
        } catch (e2) { lastErr = e2; }
      }
      console.warn(`[image-gen] connection ${connId.slice(0, 8)}… failed: ${err.message}, trying next`);
      continue;
    }
  }
  throw lastErr;
}

function cleanupGenerated(generatedDir) {
  try {
    const files = fs.readdirSync(generatedDir)
      .filter(f => f.endsWith('.png'))
      .map(f => ({ name: f, time: fs.statSync(path.join(generatedDir, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
    while (files.length > MAX_GENERATED) {
      const old = files.pop();
      const oldPath = path.join(generatedDir, old.name);
      try { fs.unlinkSync(oldPath); } catch {}
      try {
        const media = require('./media-library');
        media.removeAssetByPath(oldPath);
      } catch {}
    }
  } catch {}
}

let _genWriteChain = Promise.resolve();
function withGenLock(fn) {
  let release;
  const gate = new Promise(r => { release = r; });
  const prev = _genWriteChain;
  _genWriteChain = gate;
  return prev.then(fn).finally(() => release());
}

function startJob(jobId, prompt, brandAssetsDir, assetNames, size, onComplete) {
  const job = { status: 'generating', imagePath: null, relPath: null, mediaId: null, error: null, startedAt: Date.now(), waiters: [] };
  let _settled = false;
  _jobs.set(jobId, job);
  pruneJobs();

  function settle(err, imgPath) {
    if (_settled) return;
    _settled = true;
    const waiters = job.waiters || [];
    job.waiters = [];
    for (const waiter of waiters) {
      try { waiter(); } catch {}
    }
    if (onComplete) onComplete(err, imgPath);
  }

  const { loaded: assets, skipped: assetSkips } = loadAssets(brandAssetsDir, assetNames || []);
  if (assetSkips.length > 0) {
    job.assetWarnings = assetSkips;
  }

  callCodexAPIWithFallback(prompt, assets, size).then(imgBuf => {
    return withGenLock(() => {
      if (_settled) return;
      const generatedDir = path.join(brandAssetsDir, 'generated');
      fs.mkdirSync(generatedDir, { recursive: true });
      const outPath = path.join(generatedDir, jobId + '.png');
      fs.writeFileSync(outPath, imgBuf);
      job.status = 'done';
      job.imagePath = outPath;
      job.relPath = path.join('brand-assets', 'generated', jobId + '.png');
      try {
        const mediaAsset = require('./media-library').registerExistingMediaFile(outPath, {
          type: 'generated',
          visibility: 'internal',
          title: jobId,
          source: 'image-generation',
          status: 'ready',
          description: prompt,
        });
        job.mediaId = mediaAsset?.id || null;
      } catch (e) { console.warn('[image-gen] media register failed:', e.message); }
      cleanupGenerated(generatedDir);
      settle(null, outPath);
    });
  }).catch(err => {
    if (_settled) return;
    job.status = 'failed';
    job.error = err.message;
    settle(err, null);
  });

  setTimeout(() => {
    if (job.status === 'generating') {
      job.status = 'failed';
      job.error = 'Timeout sau 15 phut';
      settle(new Error(job.error), null);
    }
  }, JOB_TIMEOUT_MS);

  return jobId;
}

function getJobStatus(jobId) {
  const job = _jobs.get(jobId);
  if (!job) return { status: 'not_found' };
  const warnings = job.assetWarnings?.length ? { assetWarnings: job.assetWarnings } : {};
  if (job.status === 'done') return { status: 'done', imagePath: job.relPath || job.imagePath, mediaId: job.mediaId || null, ...warnings };
  if (job.status === 'failed') return { status: 'failed', error: job.error, ...warnings };
  return { status: 'generating', ...warnings };
}

function waitForJobResult(jobId, timeoutMs = 3000) {
  const job = _jobs.get(jobId);
  if (!job) return Promise.resolve({ status: 'not_found' });
  if (job.status !== 'generating') return Promise.resolve(getJobStatus(jobId));
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(getJobStatus(jobId)), timeoutMs);
    job.waiters.push(() => {
      clearTimeout(timer);
      resolve(getJobStatus(jobId));
    });
  });
}

module.exports = {
  startJob,
  getJobStatus,
  generateJobId,
  waitForJobResult,
  normalizeImageSize,
  _test: {
    buildCodexRequest,
    isImageToolChoiceUnsupported,
    findImageConnectionId,
  }
};
