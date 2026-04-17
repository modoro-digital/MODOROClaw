// electron/scripts/prebuild-models.js
// Download Xenova/multilingual-e5-small quantized ONNX to vendor/models/
// Verify SHA256 per file, cache so CI/rebuilds are idempotent.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const MODEL_DIR = path.join(__dirname, '..', 'vendor', 'models', 'Xenova', 'multilingual-e5-small');
// Pin to a specific git revision SHA of the HF repo, not `main` — this way
// an upstream model update cannot shift bytes under us silently.
// Get current HEAD SHA: https://huggingface.co/Xenova/multilingual-e5-small/commits/main
// Update this when intentionally upgrading the model.
const HF_REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78';
const BASE = `https://huggingface.co/Xenova/multilingual-e5-small/resolve/${HF_REVISION}`;
// Pin files + SHA256. Collected by running once then locking hashes.
// CI will FAIL if any sha256 is null — explicit lock required before commit.
const FILES = [
  { rel: 'tokenizer.json', sha256: '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39' },
  { rel: 'tokenizer_config.json', sha256: 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b' },
  { rel: 'config.json', sha256: 'cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1' },
  { rel: 'special_tokens_map.json', sha256: 'd05497f1da52c5e09554c0cd874037a083e1dc1b9cfd48034d1c717f1afc07a7' },
  { rel: 'onnx/model_quantized.onnx', sha256: 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193' },
];

// Assert all hashes + revision are locked before running — no null/placeholder slips into CI
for (const f of FILES) {
  if (!f.sha256 || f.sha256.length !== 64 || f.sha256.startsWith('<')) {
    throw new Error(`[prebuild-models] SHA256 not locked for ${f.rel} — run once locally, copy 64-char hex hash, commit before build`);
  }
}
if (!HF_REVISION || HF_REVISION.length !== 40 || HF_REVISION.startsWith('<')) {
  throw new Error('[prebuild-models] HF_REVISION not pinned — replace placeholder with 40-char git SHA from HF repo');
}

const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;

async function download(url, dest, redirectsRemaining = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      // HuggingFace responds with 307 relative redirects to /api/resolve-cache/...
      // Must handle 301/302/303/307/308 and resolve relative Location against current URL.
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        if (redirectsRemaining <= 0) {
          res.resume();
          return reject(new Error(`[prebuild-models] too many redirects for ${url}`));
        }
        res.resume();  // drain so socket can be reused
        const next = new URL(res.headers.location, url).toString();
        return download(next, dest, redirectsRemaining - 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      // Handle socket reset after headers received
      res.on('error', (err) => reject(new Error(`[prebuild-models] response stream error for ${url}: ${err.message}`)));
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', (err) => {
        // Best-effort: remove partial file so next run won't see half-downloaded bytes
        try { fs.unlinkSync(dest); } catch {}
        reject(err);
      });
    });
    req.on('error', reject);
    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      req.destroy(new Error(`[prebuild-models] download timeout after ${DOWNLOAD_TIMEOUT_MS}ms for ${url}`));
    });
  });
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function main() {
  fs.mkdirSync(path.join(MODEL_DIR, 'onnx'), { recursive: true });
  for (const f of FILES) {
    const dest = path.join(MODEL_DIR, f.rel);
    if (fs.existsSync(dest) && f.sha256) {
      const actual = await sha256(dest);
      if (actual === f.sha256) {
        console.log(`[prebuild-models] cached ${f.rel} (${actual.slice(0, 8)})`);
        continue;
      }
      console.log(`[prebuild-models] hash mismatch ${f.rel} — re-downloading`);
    }
    const url = `${BASE}/${f.rel}`;
    console.log(`[prebuild-models] downloading ${f.rel}...`);
    await download(url, dest);
    const actual = await sha256(dest);
    if (f.sha256 && actual !== f.sha256) {
      throw new Error(`[prebuild-models] SHA256 mismatch for ${f.rel}: expected ${f.sha256}, got ${actual}`);
    }
    console.log(`[prebuild-models] ${f.rel} OK (sha256=${actual})`);
  }
  console.log('[prebuild-models] all files ready at', MODEL_DIR);
}
main().catch((e) => { console.error(e); process.exit(1); });
