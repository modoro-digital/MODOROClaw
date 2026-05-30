const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

const SKILLS = [
  { subpath: 'skills/docx',  dest: 'skills/anthropic-docx' },
  { subpath: 'skills/pdf',   dest: 'skills/anthropic-pdf' },
  { subpath: 'skills/pptx',  dest: 'skills/anthropic-pptx' },
  { subpath: 'skills/xlsx',  dest: 'skills/anthropic-xlsx' },
];

function httpsDownload(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, res => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        httpsDownload(res.headers.location, destPath).then(resolve).catch(reject);
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', err => { fs.unlink(destPath, () => {}); reject(err); });
  });
}

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, shell: true });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('close', code => code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(' ')} failed: ${err}`)));
  });
}

function dirHasFiles(dir) {
  try {
    const entries = fs.readdirSync(dir);
    return entries.some(f => fs.statSync(path.join(dir, f)).isFile());
  } catch (e) { return false; }
}

async function main() {
  const tmpTar = path.join(os.tmpdir(), 'anthropics-skills.tar.gz');
  const tmpDir = path.join(os.tmpdir(), 'anthropics-skills-extract');

  for (const skill of SKILLS) {
    if (dirHasFiles(skill.dest)) {
      console.log(`Skipping ${skill.dest}/ (already populated)`);
      continue;
    }
  }

  console.log('Downloading Anthropics skills tarball...');
  try {
    await httpsDownload('https://github.com/anthropics/skills/archive/refs/heads/main.tar.gz', tmpTar);
  } catch (e) {
    console.error('Download failed:', e.message);
    return;
  }

  console.log('Extracting...');
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  fs.mkdirSync(tmpDir);

  try {
    await run('tar', ['-xzf', tmpTar, '-C', tmpDir], tmpDir);
  } catch (e) {
    console.error('tar extract failed:', e.message);
    return;
  }

  const extractRoot = path.join(tmpDir, 'skills-main');
  for (const skill of SKILLS) {
    const srcDir = path.join(extractRoot, skill.subpath);
    const destDir = skill.dest;
    if (!fs.existsSync(srcDir)) {
      console.log(`Source not found: ${srcDir}`);
      continue;
    }
    if (dirHasFiles(destDir)) {
      console.log(`Skipping ${destDir}/ (already populated)`);
      continue;
    }
    console.log(`Copying ${srcDir} -> ${destDir}`);
    fs.mkdirSync(path.dirname(destDir), { recursive: true });
    fs.cpSync(srcDir, destDir, { recursive: true });
    const count = fs.readdirSync(destDir, { recursive: true }).filter(f => fs.statSync(path.join(destDir, f)).isFile()).length;
    console.log(`  -> ${count} files`);
  }

  fs.unlinkSync(tmpTar);
  fs.rmSync(tmpDir, { recursive: true });
  console.log('\nDone.');
}

main().catch(e => console.error('Fatal:', e.message));
