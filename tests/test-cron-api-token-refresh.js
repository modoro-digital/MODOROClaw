const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { refreshCronApiTokenInAgents } = require(path.join(__dirname, '..', 'electron', 'lib', 'cron-api-token'));

const oldToken = 'a'.repeat(48);
const newToken = 'b'.repeat(48);

const freshTemplate = [
  'Dùng token: {{CRON_API_TOKEN}}',
  'web_fetch http://127.0.0.1:20200/api/zalo/send?token={{CRON_API_TOKEN}}&groupId=123&text=hello',
  'web_fetch http://127.0.0.1:20200/api/cron/create?token={{CRON_API_TOKEN}}&label=test&content=hello',
].join('\n');

const staleBootPrompt = [
  `Dùng token: ${oldToken}`,
  `web_fetch http://127.0.0.1:20200/api/zalo/send?token=${oldToken}&groupId=123&text=hello`,
  `web_fetch http://127.0.0.1:20200/api/cron/create?token=${oldToken}&label=test&content=hello`,
].join('\n');

for (const input of [freshTemplate, staleBootPrompt]) {
  const refreshed = refreshCronApiTokenInAgents(input, newToken);
  assert(!refreshed.includes(oldToken), 'stale token is removed from AGENTS prompt');
  assert(!refreshed.includes('{{CRON_API_TOKEN}}'), 'placeholder is replaced');
  assert(refreshed.includes(`token=${newToken}`), 'URL token is refreshed');
  assert(refreshed.includes(`Dùng token: ${newToken}`), 'standalone token instruction is refreshed');
}

const invalid = refreshCronApiTokenInAgents(`token=${oldToken}`, 'not-a-token');
assert(invalid.includes(oldToken), 'invalid replacement token is ignored');

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf-8');
assert(mainSrc.includes('refreshCronApiTokenInAgents(content, _cronApiToken)'), 'startCronApi refreshes AGENTS prompt token every boot');
assert(mainSrc.includes("['content', 'text', 'prompt']"), 'GET parser preserves literal web_fetch text/prompt fields');

console.log('cron API token refresh tests passed');
