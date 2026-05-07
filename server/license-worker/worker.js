// 9BizClaw License Server — Cloudflare Worker
// KV binding: LICENSE_KV, Secret: ADMIN_SECRET

const KEY_CHARSET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const KEY_SEGMENT_LEN = 4;
const KEY_SEGMENTS = 3;
const VALID_DAYS = 90;
const KEY_FORMAT_RE = /^CLAW-[23456789A-HJKMNP-Z]{4}-[23456789A-HJKMNP-Z]{4}-[23456789A-HJKMNP-Z]{4}$/;

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

function generateKey() {
  // Rejection sampling to avoid modulo bias (31 chars, 31*8=248)
  const totalChars = KEY_SEGMENT_LEN * KEY_SEGMENTS; // 12
  const bytes = new Uint8Array(totalChars * 2); // extra bytes for rejections
  crypto.getRandomValues(bytes);
  let result = 'CLAW-';
  let ri = 0;
  for (let i = 0; i < totalChars; i++) {
    if (i > 0 && i % KEY_SEGMENT_LEN === 0) result += '-';
    let b;
    do {
      if (ri >= bytes.length) {
        // Extremely unlikely: ran out of bytes, refill
        crypto.getRandomValues(bytes);
        ri = 0;
      }
      b = bytes[ri++];
    } while (b >= 248); // 248 = 31 * 8, reject to eliminate bias
    result += KEY_CHARSET[b % 31];
  }
  return result;
}

function validUntilFromNow() {
  const d = new Date();
  d.setDate(d.getDate() + VALID_DAYS);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function isAdmin(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  return verifyAdmin(token, env.ADMIN_SECRET);
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
      else response = jsonResponse({ ok: false, error: 'not_found' }, 404);
    } else {
      response = jsonResponse({ ok: false, error: 'not_found' }, 404);
    }

    const cors = corsHeaders(request, env);
    for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
    return response;
  },
};
