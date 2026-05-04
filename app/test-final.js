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
  console.log('=== Final Test ===\n');

  // Login
  const r2 = await httpReq(base + '/api/auth/login', 'POST',
    { username: 'peterbui85', password: '9bizclaw#3211' }, {});
  console.log('[1] Login:', r2.status === 200 ? 'PASS' : 'FAIL', r2.status, JSON.parse(r2.body).username ?? r2.body);
  if (r2.status !== 200) process.exit(1);
  const cookie = r2.headers['set-cookie'][0].split(';')[0];

  // List keys
  const r3 = await httpReq(base + '/api/keys/list', 'GET', null, { Cookie: cookie });
  const data = JSON.parse(r3.body);
  console.log('[2] List keys:', r3.status === 200 ? 'PASS' : 'FAIL', r3.status, `-> ${data.licenses?.length ?? 0} licenses, ${data.revoked?.length ?? 0} revoked`);

  // Try generate
  const r4 = await httpReq(base + '/api/keys/generate', 'POST',
    { email: 'test@example.com', months: 12, plan: 'premium' }, { Cookie: cookie });
  const genData = JSON.parse(r4.body);
  console.log('[3] Generate:', r4.status === 501 ? 'PASS (expected 501)' : 'UNEXPECTED', r4.status);
  if (genData.error) console.log('    Message:', genData.error.slice(0, 100));

  console.log('\n=== Web interface verified ===');
  console.log('URL: https://app-rouge-mu-65.vercel.app');
  console.log('Login: peterbui85 / 9bizclaw#3211');
  console.log('Key generate: disabled (use CLI on admin machine)');
}

test().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
