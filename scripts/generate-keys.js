#!/usr/bin/env node
// 9BizClaw License Key Admin CLI
// Usage:
//   node scripts/generate-keys.js [count] [--max-machines N] [--note "text"]
//   node scripts/generate-keys.js list
//   node scripts/generate-keys.js revoke CLAW-XXXX-XXXX-XXXX
//
// Environment: LICENSE_SERVER_URL, ADMIN_SECRET

const SERVER = process.env.LICENSE_SERVER_URL;
const SECRET = process.env.ADMIN_SECRET;

if (!SERVER || !SECRET) {
  console.error('Missing environment variables: LICENSE_SERVER_URL and ADMIN_SECRET');
  console.error('');
  console.error('  export LICENSE_SERVER_URL=https://license.modoro.com.vn');
  console.error('  export ADMIN_SECRET=your-secret');
  process.exit(1);
}

async function api(path, body = {}) {
  const res = await fetch(`${SERVER.replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SECRET}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error(`Error: ${data.error || 'unknown'}`);
    process.exit(1);
  }
  return data;
}

function parseArgs(argv) {
  const args = { flags: {} };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--max-machines' && argv[i + 1]) {
      args.flags.maxMachines = parseInt(argv[++i], 10);
    } else if (a === '--note' && argv[i + 1]) {
      args.flags.note = argv[++i];
    } else if (!args.command) {
      args.command = a;
    } else {
      args.extra = a;
    }
    i++;
  }
  return args;
}

async function cmdGenerate(count, flags) {
  const body = {
    count,
    maxMachines: flags.maxMachines || 2,
    note: flags.note || '',
  };
  const data = await api('/api/admin/generate', body);
  console.log(`Generated ${data.keys.length} keys:`);
  for (const key of data.keys) {
    console.log(key);
  }
}

async function cmdList() {
  const data = await api('/api/admin/list');
  if (data.keys.length === 0) {
    console.log('No keys found.');
    return;
  }

  console.log(`Total: ${data.keys.length} keys\n`);

  for (const k of data.keys) {
    const status = k.revokedAt ? `REVOKED ${k.revokedAt}` : 'active';
    const machines = (k.machines || []).length;
    const max = k.maxMachines || '?';
    console.log(`${k.key}  [${status}]  machines: ${machines}/${max}  created: ${k.createdAt}`);
    if (k.note) console.log(`  note: ${k.note}`);
    for (const m of k.machines || []) {
      console.log(`    - ${m.machineId}  ${m.hostname || ''}  v${m.appVersion || '?'}  last: ${m.lastSeen || '?'}`);
    }
  }
}

async function cmdRevoke(key) {
  if (!key || !key.startsWith('CLAW-')) {
    console.error('Usage: node scripts/generate-keys.js revoke CLAW-XXXX-XXXX-XXXX');
    process.exit(1);
  }
  await api('/api/admin/revoke', { key });
  console.log(`Revoked: ${key}`);
}

// --- Main ---

const { command, extra, flags } = parseArgs(process.argv.slice(2));

if (command === 'list') {
  cmdList();
} else if (command === 'revoke') {
  cmdRevoke(extra);
} else if (command === 'help' || command === '--help') {
  console.log('Usage:');
  console.log('  node scripts/generate-keys.js [count] [--max-machines N] [--note "text"]');
  console.log('  node scripts/generate-keys.js list');
  console.log('  node scripts/generate-keys.js revoke CLAW-XXXX-XXXX-XXXX');
} else {
  const count = parseInt(command, 10) || 1;
  cmdGenerate(count, flags);
}
