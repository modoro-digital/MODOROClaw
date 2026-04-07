// One-shot helper to apply the OpenZalo blocklist patch when running outside Electron.
// Normally `ensureZaloBlocklistFix()` in main.js handles this on every startOpenClaw().
const fs = require('fs');
const path = require('path');

const HOME = process.env.USERPROFILE || process.env.HOME;
const pluginFile = path.join(HOME, '.openclaw', 'extensions', 'openzalo', 'src', 'inbound.ts');
if (!fs.existsSync(pluginFile)) {
  console.error('plugin file not found:', pluginFile);
  process.exit(0);
}
let content = fs.readFileSync(pluginFile, 'utf-8');
if (content.includes('MODOROClaw BLOCKLIST PATCH')) {
  console.log('already patched');
  process.exit(0);
}
const anchor = '  if (!rawBody && !hasMedia) {\n    return;\n  }';
if (!content.includes(anchor)) {
  console.error('anchor not found');
  process.exit(1);
}
const ws = path.resolve(__dirname, '..', '..').replace(/\\/g, '/');
const blocklistPaths = [
  ws + '/zalo-blocklist.json',
  HOME.replace(/\\/g, '/') + '/.openclaw/workspace/zalo-blocklist.json',
];
const injection = `

  // === MODOROClaw BLOCKLIST PATCH ===
  // Drop messages from senders listed in zalo-blocklist.json (Dashboard → Zalo → Bạn bè).
  try {
    const __mzFs = require("node:fs");
    const __mzCandidates = ${JSON.stringify(blocklistPaths)};
    let __mzBlocked: string[] = [];
    for (const __p of __mzCandidates) {
      try {
        if (__mzFs.existsSync(__p)) {
          const __raw = __mzFs.readFileSync(__p, "utf-8");
          const __parsed = JSON.parse(__raw);
          if (Array.isArray(__parsed)) { __mzBlocked = __parsed.map((x: any) => String(x)); break; }
        }
      } catch {}
    }
    if (__mzBlocked.length > 0) {
      const __sender = String(message.senderId || "").trim();
      if (__sender && __mzBlocked.includes(__sender)) {
        runtime.log?.(\`openzalo: drop sender=\${__sender} (MODOROClaw blocklist)\`);
        return;
      }
    }
  } catch (__e) { runtime.log?.(\`openzalo: blocklist check error: \${String(__e)}\`); }
  // === END MODOROClaw BLOCKLIST PATCH ===
`;
content = content.replace(anchor, anchor + injection);
fs.writeFileSync(pluginFile, content, 'utf-8');
console.log('patched');
