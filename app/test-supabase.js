const https = require('https');

const SB_URL = 'ndssbmedzbjutnfznale.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5kc3NibWVkemJqdXRuZnpuYWxlIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3Nzg4MjgwMywiZXhwIjoyMDkzNDU4ODAzfQ.-KlUesP2svgf2GWhUF0fNmcP3csmCnC4PwfTe22J9Jo';

function sbFetch(path, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = {
      'apikey': SB_KEY,
      'Authorization': 'Bearer ' + SB_KEY,
      'Content-Type': 'application/json',
    };
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const opts = {
      hostname: SB_URL, path: '/rest/v1/' + path,
      method, headers,
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function main() {
  console.log('=== Supabase REST API Test ===');
  
  // Test 1: List licenses
  const r1 = await sbFetch('licenses?select=*&order=created_at.desc');
  console.log('\n[1] GET /licenses:', r1.status);
  try { const j = JSON.parse(r1.body); console.log('    Count:', j.length, 'licenses'); }
  catch { console.log('    Raw:', r1.body.slice(0, 200)); }
  
  // Test 2: List revoked keys
  const r2 = await sbFetch('revoked_keys?select=*&order=revoked_at.desc');
  console.log('\n[2] GET /revoked_keys:', r2.status);
  try { const j = JSON.parse(r2.body); console.log('    Count:', j.length, 'revoked'); }
  catch { console.log('    Raw:', r2.body.slice(0, 200)); }
  
  // Test 3: Try to insert a license
  const newKey = {
    key_hash: 'test-' + Date.now().toString(36),
    payload: { e: 'test@example.com', p: 'premium', i: '2026-05-04', v: '2027-05-04' }
  };
  const r3 = await sbFetch('licenses', 'POST', newKey);
  console.log('\n[3] POST /licenses:', r3.status, r3.body.slice(0, 100));
}

main().catch(e => console.error('Error:', e.message));
