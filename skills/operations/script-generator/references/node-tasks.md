# Node.js script tasks

Cho task không cần Python (JSON, HTTP, file ops, fast scripts). Node 18+ có fetch native.

## Native fetch (no deps)

```js
// HTTP GET JSON → stdout
'use strict';
const url = process.argv[2];
if (!url) { console.error('usage: node script.js <url>'); process.exit(1); }
(async () => {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': '9BizClaw/1.0' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(JSON.stringify({ error: e.message }));
    process.exit(1);
  }
})();
```

## Read JSON workspace files

```js
'use strict';
const fs = require('fs');
const path = require('path');
const ws = process.env['9BIZ_WORKSPACE'] || '.';
const cronsPath = path.join(ws, 'custom-crons.json');
if (!fs.existsSync(cronsPath)) { console.error('no custom-crons.json'); process.exit(1); }
const crons = JSON.parse(fs.readFileSync(cronsPath, 'utf-8'));
console.log(JSON.stringify(crons.filter(c => c.enabled), null, 2));
```

## Bulk JSON transform

```js
// Read JSON array, filter + map, write new file
'use strict';
const fs = require('fs');
const [input, output] = process.argv.slice(2);
if (!input || !output) { console.error('usage: node x.js <input.json> <output.json>'); process.exit(1); }
const data = JSON.parse(fs.readFileSync(input, 'utf-8'));
const transformed = data
  .filter(item => item.enabled !== false)
  .map(item => ({ id: item.id, name: item.name, summary: (item.content || '').slice(0, 100) }));
fs.writeFileSync(output, JSON.stringify(transformed, null, 2));
console.log('OK', transformed.length, 'items →', output);
```

## When to use Node vs Python

| Task | Prefer |
|---|---|
| Pure JSON manipulation | Node (1-line fast) |
| Excel/Sheet (pandas) | Python |
| HTTP API call | Either; Node simpler nếu no deps |
| sqlite query | Python (sqlite3 stdlib) |
| Browser automation | Python (playwright more stable) hoặc Node (puppeteer) |
| Image batch | Python (Pillow more mature) |
| File ops | Either |

## Notes

- Node binary lúc nào cũng có (`process.execPath` = Electron's Node binary)
- Cold start <100ms vs Python 200-500ms
- `9BIZ_WORKSPACE` env var auto-set by gateway
- Stdlib enough cho 80% task → tránh `npm install`
