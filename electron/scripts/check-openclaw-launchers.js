#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const dashboardPath = path.join(__dirname, '..', 'ui', 'dashboard.html');
const dashboard = fs.readFileSync(dashboardPath, 'utf8');

const requiredWiring = [
  'data-page="chat"',
  'id="page-chat"',
  'openAiModelsBrowser()',
  'openAdvancedSettings()',
  'copyAndShowGatewayToken()',
  'prewarmChatEmbed',
  "ensureEmbedLoaded('chat', { silent: true })",
  "if (page === '9router' || page === 'openclaw' || page === 'chat')",
  'http://127.0.0.1:20128/',
  'http://127.0.0.1:18789/',
];

const missing = requiredWiring.filter((needle) => !dashboard.includes(needle));

if (missing.length) {
  console.error('[openclaw-launchers] FAIL missing dashboard wiring:');
  for (const needle of missing) console.error('  - ' + needle);
  process.exit(1);
}

console.log('[openclaw-launchers] PASS OpenClaw chat and launcher wiring present');
