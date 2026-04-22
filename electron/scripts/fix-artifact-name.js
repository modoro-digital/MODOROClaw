const fs = require('fs');
const path = require('path');

const rawVersion = require('../package.json').version;
const distDir = path.join(__dirname, '..', '..', 'dist');

if (!fs.existsSync(distDir)) process.exit(0);

const files = fs.readdirSync(distDir);
const newSetup = files.find(f => f === `9BizClaw Setup ${rawVersion}.exe`);
if (newSetup) {
  console.log('[fix-artifact-name] correct filename already exists, skipping');
  process.exit(0);
}

const setupPattern = /^9BizClaw Setup (.+)\.(exe|exe\.blockmap)$/;
for (const file of files) {
  const m = file.match(setupPattern);
  if (!m) continue;
  const foundVersion = m[1];
  if (foundVersion === rawVersion) continue;
  const correct = `9BizClaw Setup ${rawVersion}.${m[2]}`;
  const src = path.join(distDir, file);
  const dst = path.join(distDir, correct);
  if (fs.existsSync(dst)) fs.unlinkSync(dst);
  fs.renameSync(src, dst);
  console.log(`[fix-artifact-name] ${file} -> ${correct}`);
}
