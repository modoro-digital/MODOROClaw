'use strict';

const TOKEN_BLOCK_START = '<!-- 9bizclaw-cron-api-token:start -->';
const TOKEN_BLOCK_END = '<!-- 9bizclaw-cron-api-token:end -->';
const TOKEN_BLOCK_RE = new RegExp('\\n?' + TOKEN_BLOCK_START + '[\\s\\S]*?' + TOKEN_BLOCK_END + '\\n?', 'i');

function buildTokenBlock() {
  return '';
}

function stripCronApiTokenFromAgents(content) {
  if (typeof content !== 'string') return content;
  return content
    .replace(TOKEN_BLOCK_RE, '\n')
    .replace(/\{\{CRON_API_TOKEN\}\}/g, '<lay-tu-api-auth-token>')
    .replace(/(token=)[a-f0-9]{48}\b/gi, '$1<lay-tu-api-auth-token>')
    .replace(/((?:Dùng|Dung|Use)\s+token:\s*)[a-f0-9]{48}\b/giu, '$1<lay-tu-api-auth-token>');
}

function refreshCronApiTokenInAgents(content) {
  return stripCronApiTokenFromAgents(content);
}

module.exports = {
  refreshCronApiTokenInAgents,
  stripCronApiTokenFromAgents,
  buildTokenBlock,
};
