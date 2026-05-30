const fs = require('fs');
const path = require('path');

const pkg = require('../package.json');
const rawVersion = pkg.version;
const productName = (pkg.build && pkg.build.productName) || pkg.name || '9BizClaw';
const distDir = path.join(__dirname, '..', '..', 'dist');

if (!fs.existsSync(distDir)) process.exit(0);

// electron-builder mangles 4-segment versions:
//   "2.3.47.3" → NSIS: "2.3.4-7.3.exe", DMG: "2.3.47-3.dmg"
// Regex: version-like pattern (with optional prerelease) followed by .ext or -arch
const VERSION_RE = /(\d+\.\d+\.\d+(?:-[\d.]+\d)?)(?=[\.\-][a-zA-Z])/;
const now = Date.now();
const TEN_MINUTES = 10 * 60 * 1000;
const files = fs.readdirSync(distDir);
let renamed = 0;

for (const file of files) {
  if (file.includes(rawVersion)) continue;
  // Only touch product artifacts (9BizClaw Setup*, 9BizClaw-*, latest*.yml)
  const isProduct = file.startsWith(productName) || file.startsWith('latest');
  if (!isProduct) continue;

  const filePath = path.join(distDir, file);
  const stat = fs.statSync(filePath);
  if (now - stat.mtimeMs > TEN_MINUTES) continue;

  const m = file.match(VERSION_RE);
  if (!m) continue;

  const mangled = m[1];
  if (mangled === rawVersion) continue;

  const correct = file.replace(mangled, rawVersion);
  if (correct === file) continue;

  const dst = path.join(distDir, correct);
  if (fs.existsSync(dst)) fs.unlinkSync(dst);
  fs.renameSync(filePath, dst);
  console.log(`[fix-artifact-name] ${file} -> ${correct}`);
  renamed++;
}

if (renamed === 0) {
  console.log('[fix-artifact-name] no mangled filenames found');
}
