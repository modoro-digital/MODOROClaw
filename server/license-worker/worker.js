// 9BizClaw License Server — Cloudflare Worker
// KV binding: LICENSE_KV, Secrets: ADMIN_SECRET, ED25519_PRIVATE_KEY_B64

const VALID_DAYS = 90;
const DEFAULT_MONTHS = 12;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Constant-time string comparison (crypto.subtle.timingSafeEqual not available in Workers)
function verifyAdmin(token, secret) {
  if (!token || !secret) return false;
  const a = new TextEncoder().encode(token);
  const b = new TextEncoder().encode(secret);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// IP-based rate limiting via KV with TTL
async function checkRateLimit(env, ip, endpoint, maxPerMinute) {
  const rlKey = `rl:${ip}:${endpoint}`;
  const current = parseInt(await env.LICENSE_KV.get(rlKey) || '0', 10);
  if (current >= maxPerMinute) return false;
  await env.LICENSE_KV.put(rlKey, String(current + 1), { expirationTtl: 60 });
  return true;
}

function base64urlEncode(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sha256hex(str) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
    .then(buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join(''));
}

async function importEd25519PrivateKey(b64) {
  const clean = b64.replace(/[\r\n\s]/g, '');
  const der = Uint8Array.from(atob(clean), c => c.charCodeAt(0));
  // Try native Ed25519 first (compatibility_date >= 2024-09-23), fallback to NODE-ED25519
  try {
    return await crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign']);
  } catch {
    return await crypto.subtle.importKey('pkcs8', der,
      { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' }, false, ['sign']);
  }
}

async function signEd25519(privateKey, data) {
  try {
    return await crypto.subtle.sign('Ed25519', privateKey, data);
  } catch {
    return await crypto.subtle.sign('NODE-ED25519', privateKey, data);
  }
}

async function generateEd25519Key(env, email, months) {
  const now = new Date();
  const expiry = new Date(now);
  expiry.setMonth(expiry.getMonth() + (months || DEFAULT_MONTHS));
  const payload = {
    e: email,
    p: 'premium',
    i: now.toISOString().slice(0, 10),
    v: expiry.toISOString().slice(0, 10),
  };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const privateKey = await importEd25519PrivateKey(env.ED25519_PRIVATE_KEY_B64);
  const signature = await signEd25519(privateKey, payloadBytes);
  const combined = new Uint8Array(payloadBytes.length + signature.byteLength);
  combined.set(payloadBytes, 0);
  combined.set(new Uint8Array(signature), payloadBytes.length);
  const key = 'CLAW-' + base64urlEncode(combined);
  const keyHash = (await sha256hex(key)).slice(0, 16);
  return { key, keyHash, payload };
}

function validUntilFromNow() {
  const d = new Date();
  d.setDate(d.getDate() + VALID_DAYS);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function isAdmin(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  return verifyAdmin(token, (env.ADMIN_SECRET || '').trim());
}

// --- Handlers ---

async function handleActivate(request, body, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!await checkRateLimit(env, ip, 'activate', 10)) {
    return jsonResponse({ ok: false, error: 'rate_limited' }, 429);
  }

  const { key, machineId, hostname, appVersion } = body;
  if (!key || !machineId) {
    return jsonResponse({ ok: false, error: 'missing_fields' }, 400);
  }
  if (!KEY_FORMAT_RE.test(key)) {
    return jsonResponse({ ok: false, error: 'invalid_key_format' }, 400);
  }

  const raw = await env.LICENSE_KV.get(`key:${key}`, 'json');
  if (!raw) return jsonResponse({ ok: false, error: 'invalid_key' });
  if (raw.revokedAt) return jsonResponse({ ok: false, error: 'revoked' });

  const machines = raw.machines || [];
  const existing = machines.find((m) => m.machineId === machineId);

  if (existing) {
    // Re-activation: update metadata, return ok
    existing.hostname = hostname || existing.hostname;
    existing.appVersion = appVersion || existing.appVersion;
    existing.lastSeen = new Date().toISOString();
    await env.LICENSE_KV.put(`key:${key}`, JSON.stringify(raw));
    return jsonResponse({ ok: true, validUntil: validUntilFromNow() });
  }

  const maxMachines = raw.maxMachines || 1;
  if (machines.length >= maxMachines) {
    return jsonResponse({ ok: false, error: 'max_machines', max: maxMachines }, 403);
  }

  machines.push({
    machineId,
    hostname: hostname || '',
    appVersion: appVersion || '',
    activatedAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  });
  raw.machines = machines;
  await env.LICENSE_KV.put(`key:${key}`, JSON.stringify(raw));

  // Race-condition mitigation: re-read and verify count
  // KV has no atomic CAS — two concurrent activations can both pass the
  // length check above. Re-read after write to detect and roll back.
  const verify = await env.LICENSE_KV.get(`key:${key}`, 'json');
  if (verify && (verify.machines || []).length > maxMachines) {
    verify.machines = (verify.machines || []).filter(m => m.machineId !== machineId);
    await env.LICENSE_KV.put(`key:${key}`, JSON.stringify(verify));
    return jsonResponse({ ok: false, error: 'max_machines', max: maxMachines }, 403);
  }

  return jsonResponse({ ok: true, validUntil: validUntilFromNow() });
}

async function handleValidate(request, body, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!await checkRateLimit(env, ip, 'validate', 20)) {
    return jsonResponse({ ok: false, error: 'rate_limited' }, 429);
  }

  const { key, machineId } = body;
  if (!key || !machineId) {
    return jsonResponse({ ok: false, error: 'missing_fields' }, 400);
  }
  if (!KEY_FORMAT_RE.test(key)) {
    return jsonResponse({ ok: false, error: 'invalid_key_format' }, 400);
  }

  const raw = await env.LICENSE_KV.get(`key:${key}`, 'json');
  if (!raw) return jsonResponse({ ok: false, error: 'invalid_key' });
  if (raw.revokedAt) return jsonResponse({ ok: false, error: 'revoked' });

  const machines = raw.machines || [];
  const bound = machines.find((m) => m.machineId === machineId);
  if (!bound) return jsonResponse({ ok: false, error: 'machine_not_bound' });

  // Update lastSeen
  bound.lastSeen = new Date().toISOString();
  await env.LICENSE_KV.put(`key:${key}`, JSON.stringify(raw));

  return jsonResponse({ ok: true, validUntil: validUntilFromNow() });
}

async function handleAdminGenerate(body, env) {
  const count = Math.min(Math.max(parseInt(body.count, 10) || 1, 1), 100);
  const maxMachines = Math.max(parseInt(body.maxMachines, 10) || 2, 1);
  const note = body.note || '';

  const keys = [];
  for (let i = 0; i < count; i++) {
    const key = generateKey();
    const record = {
      key,
      createdAt: new Date().toISOString(),
      maxMachines,
      machines: [],
      note,
    };
    await env.LICENSE_KV.put(`key:${key}`, JSON.stringify(record));
    keys.push(key);
  }

  return jsonResponse({ ok: true, keys });
}

async function handleAdminCreateClient(body, env) {
  const name = (body.name || '').trim();
  if (!name) return jsonResponse({ ok: false, error: 'missing_client_name' }, 400);
  const keysPerClient = Math.min(Math.max(parseInt(body.keysPerClient, 10) || 3, 1), 10);
  const months = Math.max(parseInt(body.months, 10) || DEFAULT_MONTHS, 1);
  const note = body.note || '';

  if (!env.ED25519_PRIVATE_KEY_B64) {
    return jsonResponse({ ok: false, error: 'signing_key_not_configured' }, 500);
  }

  try {
    const clientId = 'cl_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const now = new Date().toISOString();
    const keys = [];

    for (let i = 0; i < keysPerClient; i++) {
      const email = name + (i + 1) + '@gmail.com';
      const { key, keyHash, payload } = await generateEd25519Key(env, email, months);
      const record = {
        key,
        keyHash,
        clientId,
        clientName: name,
        createdAt: now,
        maxMachines: 1,
        machines: [],
        note: note || (email + ' | ' + payload.p + ' | ' + payload.i + ' to ' + payload.v),
      };
      await env.LICENSE_KV.put(`key:${keyHash}`, JSON.stringify(record));
      keys.push(key);
    }

    const client = { id: clientId, name, createdAt: now, keys, keysPerClient, maxMachines: 1, note };
    await env.LICENSE_KV.put(`client:${clientId}`, JSON.stringify(client));

    return jsonResponse({ ok: true, client });
  } catch (e) {
    return jsonResponse({ ok: false, error: 'keygen_failed', detail: e.message }, 500);
  }
}

async function handleAdminListClients(env) {
  const allKeys = [];
  let cursor = undefined;
  while (true) {
    const list = await env.LICENSE_KV.list({ prefix: 'key:', cursor });
    for (const item of list.keys) {
      const record = await env.LICENSE_KV.get(item.name, 'json');
      if (record) allKeys.push(record);
    }
    if (list.list_complete) break;
    cursor = list.cursor;
  }

  const clients = new Map();
  const ungrouped = [];

  for (const k of allKeys) {
    if (k.clientId) {
      if (!clients.has(k.clientId)) {
        clients.set(k.clientId, { id: k.clientId, name: k.clientName || k.clientId, keys: [] });
      }
      clients.get(k.clientId).keys.push(k);
    } else {
      ungrouped.push(k);
    }
  }

  const clientList = Array.from(clients.values());
  clientList.sort((a, b) => {
    const aDate = Math.max(...a.keys.map(k => new Date(k.createdAt).getTime()));
    const bDate = Math.max(...b.keys.map(k => new Date(k.createdAt).getTime()));
    return bDate - aDate;
  });

  return jsonResponse({ ok: true, clients: clientList, ungrouped });
}

async function handleAdminRevokeClient(body, env) {
  const { clientId } = body;
  if (!clientId) return jsonResponse({ ok: false, error: 'missing_client_id' }, 400);

  let cursor = undefined;
  let revokedCount = 0;
  const now = new Date().toISOString();
  while (true) {
    const list = await env.LICENSE_KV.list({ prefix: 'key:', cursor });
    for (const item of list.keys) {
      const record = await env.LICENSE_KV.get(item.name, 'json');
      if (record && record.clientId === clientId && !record.revokedAt) {
        record.revokedAt = now;
        await env.LICENSE_KV.put(item.name, JSON.stringify(record));
        revokedCount++;
      }
    }
    if (list.list_complete) break;
    cursor = list.cursor;
  }

  return jsonResponse({ ok: true, revokedCount });
}

async function handleAdminList(env) {
  const allKeys = [];
  let cursor = undefined;

  // KV list with prefix, paginate through all
  while (true) {
    const list = await env.LICENSE_KV.list({ prefix: 'key:', cursor });
    for (const item of list.keys) {
      const record = await env.LICENSE_KV.get(item.name, 'json');
      if (record) allKeys.push(record);
    }
    if (list.list_complete) break;
    cursor = list.cursor;
  }

  return jsonResponse({ ok: true, keys: allKeys });
}

async function handleDeactivate(request, body, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!await checkRateLimit(env, ip, 'deactivate', 5)) {
    return jsonResponse({ ok: false, error: 'rate_limited' }, 429);
  }
  const { key, machineId } = body;
  if (!key || !machineId) return jsonResponse({ ok: false, error: 'missing_fields' }, 400);
  if (!KEY_FORMAT_RE.test(key)) {
    return jsonResponse({ ok: false, error: 'invalid_key_format' }, 400);
  }

  const data = await env.LICENSE_KV.get(`key:${key}`, 'json');
  if (!data) return jsonResponse({ ok: false, error: 'key_not_found' }, 404);

  data.machines = (data.machines || []).filter(m => m.machineId !== machineId);
  await env.LICENSE_KV.put(`key:${key}`, JSON.stringify(data));
  return jsonResponse({ ok: true, remaining_machines: data.machines.length });
}

async function handleAdminRevoke(body, env) {
  const { key } = body;
  if (!key) return jsonResponse({ ok: false, error: 'missing_key' }, 400);

  const raw = await env.LICENSE_KV.get(`key:${key}`, 'json');
  if (!raw) return jsonResponse({ ok: false, error: 'invalid_key' });

  raw.revokedAt = new Date().toISOString();
  await env.LICENSE_KV.put(`key:${key}`, JSON.stringify(raw));

  return jsonResponse({ ok: true });
}

// --- Router ---

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ADMIN_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const headers = {};
  if (allowed.length === 0 || allowed.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin || '*';
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    headers['Access-Control-Max-Age'] = '86400';
  }
  return headers;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    if (request.method !== 'POST') {
      return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405);
    }

    const url = new URL(request.url);
    const path = url.pathname;

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ ok: false, error: 'invalid_json' }, 400);
    }

    let response;

    // Public endpoints
    if (path === '/api/activate') response = await handleActivate(request, body, env);
    else if (path === '/api/validate') response = await handleValidate(request, body, env);
    else if (path === '/api/deactivate') response = await handleDeactivate(request, body, env);

    // Admin endpoints
    else if (path.startsWith('/api/admin/')) {
      if (!isAdmin(request, env)) {
        response = jsonResponse({ ok: false, error: 'unauthorized' }, 401);
      } else if (path === '/api/admin/generate') response = await handleAdminGenerate(body, env);
      else if (path === '/api/admin/list') response = await handleAdminList(env);
      else if (path === '/api/admin/revoke') response = await handleAdminRevoke(body, env);
      else if (path === '/api/admin/create-client') response = await handleAdminCreateClient(body, env);
      else if (path === '/api/admin/list-clients') response = await handleAdminListClients(env);
      else if (path === '/api/admin/revoke-client') response = await handleAdminRevokeClient(body, env);
      else response = jsonResponse({ ok: false, error: 'not_found' }, 404);
    } else {
      response = jsonResponse({ ok: false, error: 'not_found' }, 404);
    }

    const cors = corsHeaders(request, env);
    for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
    return response;
  },
};
