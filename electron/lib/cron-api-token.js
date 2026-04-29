'use strict';

const TOKEN_BLOCK_START = '<!-- 9bizclaw-cron-api-token:start -->';
const TOKEN_BLOCK_END = '<!-- 9bizclaw-cron-api-token:end -->';
const TOKEN_BLOCK_RE = new RegExp('\\n?' + TOKEN_BLOCK_START + '[\\s\\S]*?' + TOKEN_BLOCK_END + '\\n?', 'i');

function buildTokenBlock(token) {
  return [
    TOKEN_BLOCK_START,
    '## Token API noi bo hien tai',
    '',
    'Dung token: ' + token,
    '',
    'Khi goi `http://127.0.0.1:20200/api/*` co yeu cau token, them query param `token=' + token + '`.',
    'Neu token nay da co trong huong dan thi KHONG goi `/api/auth/token` nua.',
    TOKEN_BLOCK_END,
  ].join('\n');
}

function refreshCronApiTokenInAgents(content, token) {
  if (typeof content !== 'string') return content;
  if (!/^[a-f0-9]{48}$/i.test(String(token || ''))) return content;

  const tokenBlock = buildTokenBlock(token);
  let out = content.replace(/\{\{CRON_API_TOKEN\}\}/g, token);
  out = out.replace(/(token=)[a-f0-9]{48}\b/gi, '$1' + token);
  out = out.replace(/((?:Dùng|Dung|Use)\s+token:\s*)[a-f0-9]{48}\b/giu, '$1' + token);
  if (TOKEN_BLOCK_RE.test(out)) {
    out = out.replace(TOKEN_BLOCK_RE, '\n' + tokenBlock + '\n');
  } else {
    const googleIdx = out.indexOf('\n## Google Workspace');
    if (googleIdx !== -1) {
      out = out.slice(0, googleIdx) + '\n' + tokenBlock + '\n' + out.slice(googleIdx);
    } else {
      out = out.replace(/\s*$/, '\n\n' + tokenBlock + '\n');
    }
  }
  return out;
}

module.exports = {
  refreshCronApiTokenInAgents,
  buildTokenBlock,
};
