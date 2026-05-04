function httpReq(url, method, body, headers) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const opts = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    const req = require('https').request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : null);
  });
}

async function test() {
  const base = 'https://app-rouge-mu-65.vercel.app';
  
  // Test 1: GET /api/keys/list (unauthenticated → should redirect to /)
  console.log('[1] GET /api/keys/list (no auth):');
  const r1 = await httpReq(base + '/api/keys/list', 'GET', null, {});
  console.log('    Status:', r1.status);
  console.log('    Location:', r1.headers['location'] || '(none)');
  
  // Test 2: POST /api/auth/login with correct credentials
  console.log('\n[2] POST /api/auth/login (correct credentials):');
  const r2 = await httpReq(base + '/api/auth/login', 'POST', { username: 'peterbui85', password: '9bizclaw#3211' }, {});
  console.log('    Status:', r2.status);
  try { console.log('    Body:', JSON.parse(r2.body)); } catch { console.log('    Raw:', r2.body.slice(0, 200)); }
  const cookie = r2.headers['set-cookie'];
  console.log('    Cookie set:', cookie ? cookie[0].slice(0, 80) + '...' : '(none)');
  
  if (r2.status !== 200) process.exit(1);
  
  // Extract cookie
  const cookieVal = cookie ? cookie[0].split(';')[0] : '';
  
  // Test 3: GET /api/keys/list with cookie
  console.log('\n[3] GET /api/keys/list (with auth cookie):');
  const r3 = await httpReq(base + '/api/keys/list', 'GET', null, { Cookie: cookieVal });
  console.log('    Status:', r3.status);
  try {
    const j = JSON.parse(r3.body);
    console.log('    Licenses:', j.licenses?.length, '| Revoked:', j.revoked?.length);
  } catch { console.log('    Raw:', r3.body.slice(0, 200)); }
  
  // Test 4: POST /api/keys/generate
  console.log('\n[4] POST /api/keys/generate:');
  const r4 = await httpReq(base + '/api/keys/generate', 'POST', {
    email: 'test-' + Date.now() + '@example.com',
    months: 12, plan: 'premium'
  }, { Cookie: cookieVal });
  console.log('    Status:', r4.status);
  try {
    const j = JSON.parse(r4.body);
    if (j.error) console.log('    Error:', j.error);
    else console.log('    Key generated, hash:', j.keyHash, 'email:', j.email);
  } catch { console.log('    Raw:', r4.body.slice(0, 300)); }
}

test().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
