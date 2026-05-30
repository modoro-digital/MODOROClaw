'use strict';
const path = require('path');

module.exports = async function handler(event, context) {
  let defense;
  try {
    let libPath;
    try {
      const libPathFile = path.join(__dirname, '.lib-path');
      libPath = require('fs').readFileSync(libPathFile, 'utf-8').trim();
    } catch {
      libPath = process.env.MODORO_LIB_PATH || path.join(__dirname, '..', '..', 'lib');
    }
    defense = require(path.join(libPath, 'inbound-defense'));
  } catch {
    return;
  }

  const channelId = context?.channel || context?.channelId || '';

  if (event === 'message:received') {
    const msg = context?.message || context;
    const result = defense.runInboundDefense(channelId, msg);
    if (result.action === 'drop') {
      console.log(`[inbound-defense] ${channelId}: dropped (${result.reason})`);
      return { cancel: true };
    }
    if (result.action === 'rewrite') {
      console.log(`[inbound-defense] ${channelId}: rewritten (${result.reason})`);
      if (context.message) context.message.body = result.body;
      return;
    }
  }

  if (event === 'message_sending') {
    const text = context?.text || '';
    const result = defense.runOutboundDefense(channelId, text);
    if (result.blocked) {
      console.log(`[inbound-defense] ${channelId}: outbound filtered`);
      context.text = result.text;
    }
  }
};
