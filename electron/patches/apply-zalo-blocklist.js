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
const CURRENT_MARKER = '9BizClaw BLOCKLIST PATCH v2';
if (content.includes('9BizClaw BLOCKLIST PATCH')) {
  if (content.includes(CURRENT_MARKER)) {
    console.log('already patched');
    process.exit(0);
  }
  content = content.replace(/\n\s*\/\/ === 9BizClaw BLOCKLIST PATCH ===[\s\S]*?\/\/ === END 9BizClaw BLOCKLIST PATCH ===/g, '');
  console.log('removed old blocklist patch, upgrading to v2');
}
const anchor = '  if (!rawBody && !hasMedia) {\n    return;\n  }';
if (!content.includes(anchor)) {
  console.error('anchor not found');
  process.exit(1);
}
const injection = `

  // === 9BizClaw BLOCKLIST PATCH ===
  // 9BizClaw BLOCKLIST PATCH v2: runtime path resolution + fail closed.
  // Drop messages from senders listed in zalo-blocklist.json (Dashboard → Zalo → Bạn bè).
  try {
    const __mzFs = require("node:fs");
    const __mzPath = require("node:path");
    const __mzOs = require("node:os");
    const __mzHome = __mzOs.homedir();
    const __mzAppDir = "9bizclaw";
    const __mzCandidates: string[] = [];
    if (process.env['9BIZ_WORKSPACE']) {
      __mzCandidates.push(__mzPath.join(process.env['9BIZ_WORKSPACE'], "zalo-blocklist.json"));
    }
    if (process.platform === "darwin") {
      __mzCandidates.push(__mzPath.join(__mzHome, "Library", "Application Support", __mzAppDir, "zalo-blocklist.json"));
    } else if (process.platform === "win32") {
      const __mzAppData = process.env.APPDATA || __mzPath.join(__mzHome, "AppData", "Roaming");
      __mzCandidates.push(__mzPath.join(__mzAppData, __mzAppDir, "zalo-blocklist.json"));
    } else {
      const __mzConfig = process.env.XDG_CONFIG_HOME || __mzPath.join(__mzHome, ".config");
      __mzCandidates.push(__mzPath.join(__mzConfig, __mzAppDir, "zalo-blocklist.json"));
    }
    __mzCandidates.push(__mzPath.join(__mzHome, ".openclaw", "workspace", "zalo-blocklist.json"));
    let __mzBlocked: string[] = [];
    let __mzPolicyError = false;
    const __mzSeen = new Set<string>();
    for (const __p of __mzCandidates) {
      try {
        const __resolved = __mzPath.resolve(__p);
        if (__mzSeen.has(__resolved)) continue;
        __mzSeen.add(__resolved);
        if (!__mzFs.existsSync(__resolved)) continue;
        const __raw = __mzFs.readFileSync(__resolved, "utf-8");
        const __parsed = JSON.parse(__raw);
        if (!Array.isArray(__parsed)) {
          __mzPolicyError = true;
          runtime.log?.(\`openzalo: blocklist invalid at \${__resolved} → fail closed\`);
          break;
        }
        __mzBlocked = __parsed.map((x: any) => String(x || "").trim()).filter(Boolean);
        break;
      } catch (__mzReadErr) {
        __mzPolicyError = true;
        runtime.log?.(\`openzalo: blocklist parse error: \${String(__mzReadErr)}\`);
        break;
      }
    }
    if (__mzPolicyError) {
      runtime.log?.("openzalo: blocklist policy error → fail closed");
      return;
    }
    const __sender = String(message.senderId || "").trim();
    if (__sender && __mzBlocked.includes(__sender)) {
      runtime.log?.(\`openzalo: drop sender=\${__sender} (9BizClaw blocklist)\`);
      return;
    }
  } catch (__e) { runtime.log?.(\`openzalo: blocklist check error: \${String(__e)}\`); return; }
  // === END 9BizClaw BLOCKLIST PATCH ===
`;
content = content.replace(anchor, anchor + injection);
fs.writeFileSync(pluginFile, content, 'utf-8');
console.log('patched');
