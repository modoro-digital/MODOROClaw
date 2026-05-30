#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const dashboardPath = path.join(__dirname, '..', 'ui', 'dashboard.html');
const dashboard = fs.readFileSync(dashboardPath, 'utf8');

const requiredWiring = [
  'openAiModelsBrowser()',
  'openAdvancedSettings()',
  'copyAndShowGatewayToken()',
  "if (page === '9router' || page === 'openclaw')",
  'http://127.0.0.1:20128/',
  'http://127.0.0.1:18789/',
];

const missing = requiredWiring.filter((needle) => !dashboard.includes(needle));

if (missing.length) {
  console.error('[openclaw-launchers] FAIL missing dashboard wiring:');
  for (const needle of missing) console.error('  - ' + needle);
  process.exit(1);
}

console.log('[openclaw-launchers] PASS OpenClaw native chat and launcher wiring present');
