const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dashboard = fs.readFileSync(path.join(root, 'electron', 'ui', 'dashboard.html'), 'utf8');
const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');

function expectIn(text, pattern, message) {
  assert(pattern.test(text), message);
}

assert(
  !/if\s*\(!token\s*\|\|\s*!uid\)/.test(dashboard),
  'Telegram modal must not require a new token when changing only User ID'
);
expectIn(
  dashboard,
  /const hasSavedToken = !!_tgCfgCache\.botTokenSet;/,
  'Telegram modal should know whether an existing bot token is saved'
);
expectIn(
  dashboard,
  /const tokenForTest = token \|\| undefined;/,
  'Telegram test should use existing saved token when token input is blank'
);
expectIn(
  dashboard,
  /const tokenForSave = token \|\| undefined;/,
  'Telegram save should preserve saved token when token input is blank'
);
expectIn(
  dashboard,
  /saveTelegramConfig\(tokenForSave, uid\)/,
  'Telegram modal should save the new User ID without forcing token re-entry'
);
expectIn(
  main,
  /const resolvedToken = \(typeof token === 'string' && token\.trim\(\)\) \|\| getTelegramConfig\(\)\.token;/,
  'test-telegram IPC should fall back to saved token for User ID changes'
);
expectIn(
  main,
  /if \(typeof botToken === 'string' && botToken\.trim\(\)\) config\.channels\.telegram\.botToken = botToken\.trim\(\);/,
  'save-telegram-config should ignore blank token instead of clearing the saved token'
);
expectIn(
  main,
  /persistStickyChatId\(config\.channels\.telegram\.botToken, uid\);/,
  'saving Telegram User ID should refresh the sticky chat id'
);

console.log('telegram config edit contract OK');
