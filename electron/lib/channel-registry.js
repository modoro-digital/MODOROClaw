'use strict';

// Each channel entry has two identity fields:
//   key   — the lookup key used by 9BizClaw internally (matches the CHANNELS object key)
//   id    — the openclaw plugin name used in openclaw.json channels.* config
const CHANNELS = {
  telegram: {
    key: 'telegram',
    id: 'telegram',
    label: 'Telegram',
    icon: 'brand-telegram',
    role: 'ceo',
    hasAllowlist: false,
    hasPause: true,
    loginChannel: null,
    pluginPkg: null,
  },
  zalo: {
    key: 'zalo',
    id: 'modoro-zalo',
    label: 'Zalo',
    icon: 'brand-zalo',
    role: 'customer',
    hasAllowlist: true,
    hasPause: true,
    loginChannel: null,
    pluginPkg: null,
  },
};

function getChannel(key) { return CHANNELS[key] || null; }
function listChannels() { return Object.values(CHANNELS); }
function getChannelByOpenClawId(ocId) { return Object.values(CHANNELS).find(c => c.id === ocId) || null; }

module.exports = { CHANNELS, getChannel, listChannels, getChannelByOpenClawId };
