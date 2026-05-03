const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dashboard = fs.readFileSync(path.join(root, 'electron', 'ui', 'dashboard.html'), 'utf8');
const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');

function expectIn(text, pattern, message) {
  assert(pattern.test(text), message);
}

expectIn(
  dashboard,
  /data-page="chat"\s+onclick="switchPage\('chat'\)"/,
  'sidebar should expose a Chat navigation item'
);
expectIn(dashboard, /<div class="page" id="page-chat">/, 'dashboard should define the Chat page');
expectIn(dashboard, /id="embed-wrap-chat"/, 'Chat page should host its own embed wrapper');
expectIn(dashboard, /#page-chat\.page\.active/, 'Chat page should use the embedded-page flex layout');
expectIn(
  dashboard,
  /if \(page === '9router' \|\| page === 'openclaw' \|\| page === 'chat'\)\s*\{\s*ensureEmbedLoaded\(page\);/s,
  'switchPage should lazy-load the Chat webview'
);
expectIn(dashboard, /'chat': false/, 'embedLoaded should track the Chat webview');
expectIn(
  dashboard,
  /'chat': 'http:\/\/127\.0\.0\.1:18789\/chat\?themeMode=light'/,
  'Chat should load the OpenClaw chat route with light-mode hint'
);
expectIn(
  dashboard,
  /'chat': 'persist:embed-openclaw-chat'/,
  'Chat should use a dedicated OpenClaw chat webview partition'
);
expectIn(
  dashboard,
  /function forceOpenClawChatLightMode\(wv\)/,
  'dashboard should inject a light-mode override for the Chat webview'
);
expectIn(
  dashboard,
  /forceOpenClawChatLightMode\(wv\)/,
  'Chat webview load lifecycle should apply light mode'
);
expectIn(
  dashboard,
  /id: 'page-chat', label: 'Mở Chat', keywords: 'chat openclaw web chat'/,
  'command palette should expose the Chat page'
);
expectIn(
  main,
  /session\.fromPartition\('persist:embed-openclaw-chat'\)/,
  'main process should install embed header stripping on the Chat partition'
);
expectIn(
  main,
  /for \(const partName of \[[^\]]*'persist:embed-openclaw-chat'[^\]]*\]\)/s,
  'main process should route new windows from the Chat partition externally'
);

console.log('dashboard Chat tab contract OK');
