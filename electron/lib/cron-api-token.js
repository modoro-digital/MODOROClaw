'use strict';

function refreshCronApiTokenInAgents(content, token) {
  if (typeof content !== 'string') return content;
  if (!/^[a-f0-9]{48}$/i.test(String(token || ''))) return content;

  let out = content.replace(/\{\{CRON_API_TOKEN\}\}/g, token);
  out = out.replace(/(token=)[a-f0-9]{48}\b/gi, '$1' + token);
  out = out.replace(/((?:Dùng|Dung|Use)\s+token:\s*)[a-f0-9]{48}\b/giu, '$1' + token);
  return out;
}

module.exports = {
  refreshCronApiTokenInAgents,
};
