#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dashboard = fs.readFileSync(path.join(root, 'ui', 'dashboard.html'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const gateway = fs.readFileSync(path.join(root, 'lib', 'gateway.js'), 'utf8');
const vendorPatches = fs.readFileSync(path.join(root, 'lib', 'vendor-patches.js'), 'utf8');
const packageJson = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
const sources = [dashboard, main, gateway, vendorPatches, packageJson];

const failures = [];
const mustInclude = [
  ['theme boot helper', 'applySavedThemeBeforePaint'],
  ['executive neutral theme name', 'Executive Neutral premium theme'],
  ['executive neutral dark selector', ':root[data-theme="dark"]'],
  ['executive neutral light selector', ':root[data-theme="light"]'],
  ['champagne accent variable', '--accent:#c8a75a'],
  ['warm light surface variable', '--surface:#ffffff'],
  ['theme mode helper', 'setThemeMode(mode)'],
  ['system theme media listener', "matchMedia('(prefers-color-scheme: dark)')"],
  ['theme mode segmented control', 'data-theme-mode="system"'],
  ['premium entrance overlay', 'id="premium-entrance"'],
  ['premium entrance helper', 'function maybeShowPremiumEntrance()'],
  ['premium entrance one-session key', 'premiumEntranceSeen'],
  ['premium entrance reduced motion guard', 'prefers-reduced-motion: reduce'],
  ['clean chat shell class', 'chat-shell'],
  ['chat prewarm helper', 'prewarmChatEmbed'],
  ['silent embed load option', 'ensureEmbedLoaded(name, options = {})'],
  ['9BizClaw update button preserved', 'id="check-update-btn"'],
  ['9BizClaw update banner preserved', 'function showUpdateBanner(info) {'],
  ['9BizClaw manual update preserved', 'async function manualCheckUpdate() {'],
  ['9BizClaw boot update check preserved', 'checkForUpdates().catch'],
  ['OpenClaw update patch wrapper', 'ensureOpenclawUpdateUiDisabled'],
  ['OpenClaw update UI patch marker', '9BIZCLAW_OPENCLAW_UPDATE_UI_DISABLED'],
  ['OpenClaw update run patch marker', '9BIZCLAW_OPENCLAW_UPDATE_RUN_DISABLED'],
  ['OpenClaw update check patch marker', '9BIZCLAW_OPENCLAW_UPDATE_CHECK_DISABLED'],
];

const mustNotInclude = [
  ['fixed premium boot theme', "document.documentElement.setAttribute('data-theme', 'premium')"],
  ['fixed premium storage write', "localStorage.setItem('theme', 'premium')"],
  ['black gold theme name', 'Black Gold Executive premium theme'],
  ['premium theme selector', ':root[data-theme="premium"]'],
  ['old static premium label', 'Giao diện Premium'],
  ['visible chat local URL', 'http://127.0.0.1:18789/chat</code>'],
  ['disabled app update banner', 'function showUpdateBanner(info) { return; }'],
  ['disabled manual app update', 'async function manualCheckUpdate() { return; }'],
  ['disabled app boot update comment', 'User-facing update checks are disabled in this premium build.'],
];

for (const [label, needle] of mustInclude) {
  if (!sources.some(source => source.includes(needle))) failures.push(`${label}: missing ${needle}`);
}
for (const [label, needle] of mustNotInclude) {
  if (sources.some(source => source.includes(needle))) failures.push(`${label}: still contains ${needle}`);
}

if (failures.length) {
  console.error('[premium-theme-no-updates] FAIL');
  for (const failure of failures) console.error('  - ' + failure);
  process.exit(1);
}

console.log('[premium-theme-no-updates] PASS executive neutral theme, chat prewarm, and OpenClaw update UI disabled');
