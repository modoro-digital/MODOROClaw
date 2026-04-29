'use strict';
const fs = require('fs');
const path = require('path');
const ctx = require('./context');
const { writeJsonAtomic } = require('./util');
const { getWorkspace, getOpenclawAgentWorkspace, auditLog } = require('./workspace');
const { sendTelegram, sendZaloTo, isChannelPaused } = require('./channels');

// ============================================
//  APPOINTMENTS — local calendar driven by CEO via Telegram prompts
// ============================================
//
// Data: workspace/appointments.json (array of appointment objects).
// Engine: dispatcher tick every 60s — fires reminders + push targets.
// Bot writes via filesystem tool (rules in AGENTS.md). Dashboard is view + fallback.
//
// Schema: see normalizeAppointment() below. Each appointment has:
//   - start/end (ISO8601 with TZ), meetingUrl, location, note
//   - reminderMinutes + reminderChannels (telegram/zalo) — 1 shot before start
//   - pushTargets[] — {channel, toId, toName, atTime, daily, template}
//     channel = telegram | zalo_user | zalo_group
//     atTime = 'HH:MM' local, daily=true => repeat each day until appointment passes
//   - status = scheduled | done | canceled

function getAppointmentsPath() {
  // Bot (openclaw agent process) writes to agents.defaults.workspace.
  // Dispatcher MUST read from the same path or split-brain occurs. Prefer bot's
  // workspace, fallback to Electron workspace, last resort HOME.
  try {
    const botWs = getOpenclawAgentWorkspace();
    if (botWs) return path.join(botWs, 'appointments.json');
  } catch {}
  const ws = getWorkspace();
  if (ws) return path.join(ws, 'appointments.json');
  return path.join(ctx.HOME, 'appointments.json');
}

function readAppointments() {
  try {
    const p = getAppointmentsPath();
    if (!fs.existsSync(p)) return [];
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error('[appointments] read error:', e.message);
    return [];
  }
}

function writeAppointments(arr) {
  const p = getAppointmentsPath();
  const tmp = p + '.tmp';
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), 'utf-8');
  } catch (e) {
    console.error('[appointments] write error (tmp):', e.message);
    return false;
  }
  // Windows + antivirus can transiently hold `appointments.json` and make
  // renameSync throw EBUSY/EPERM. Retry a few times with short backoff before
  // giving up so an AV scan doesn't cause silent mutation loss.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      fs.renameSync(tmp, p);
      return true;
    } catch (e) {
      const code = e && e.code;
      if ((code === 'EBUSY' || code === 'EPERM' || code === 'EEXIST') && attempt < 3) {
        const wait = 30 + attempt * 50;
        const until = Date.now() + wait;
        while (Date.now() < until) { /* spin briefly, synchronous on purpose */ }
        continue;
      }
      console.error(`[appointments] write error (rename attempt ${attempt + 1}):`, e.message);
      try { fs.unlinkSync(tmp); } catch {}
      return false;
    }
  }
  return false;
}

function newAppointmentId() {
  return `apt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

// Serialize all in-process mutations so IPC handlers + dispatcher tick don't race.
// Returns null on write failure (caller must check) or if mutator throws/returns
// non-array (abort). Guards against reentrant calls that would deadlock the queue.
let _apptWriteQueue = Promise.resolve();
let _apptMutating = false;
function mutateAppointments(mutatorFn) {
  if (_apptMutating) {
    console.error('[appointments] recursive mutateAppointments call refused — would deadlock');
    return Promise.resolve(null);
  }
  const next = _apptWriteQueue.then(async () => {
    _apptMutating = true;
    try {
      const list = readAppointments();
      const result = await mutatorFn(list);
      if (!Array.isArray(result)) return null;
      if (!writeAppointments(result)) return null;
      return result;
    } catch (e) {
      console.error('[appointments] mutate error:', e.message);
      return null;
    } finally {
      _apptMutating = false;
    }
  });
  _apptWriteQueue = next.catch(() => null);
  return next;
}

// VN timezone helpers — engine must always display/compare VN local time
// regardless of machine timezone (demo machines may run UTC/PST).
function vnHHMM(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    if (!Number.isFinite(d.getTime())) return '';
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(d);
  } catch { return ''; }
}
function vnDDMM(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    if (!Number.isFinite(d.getTime())) return '';
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Ho_Chi_Minh',
      day: '2-digit', month: '2-digit',
    }).format(d);
  } catch { return ''; }
}
function vnHHMMNow() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
}
function vnDateKeyNow() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function normalizeAppointment(a) {
  if (!a || typeof a !== 'object') return null;
  const clean = (v, max) => String(v == null ? '' : v).slice(0, max);
  return {
    id: a.id || newAppointmentId(),
    title: clean(a.title, 200),
    customerName: clean(a.customerName, 100),
    phone: clean(a.phone, 30),
    start: a.start || null,
    end: a.end || null,
    meetingUrl: clean(a.meetingUrl, 500),
    location: clean(a.location, 200),
    note: clean(a.note, 1000),
    reminderMinutes: Number.isFinite(Number(a.reminderMinutes)) ? Number(a.reminderMinutes) : 15,
    reminderChannels: Array.isArray(a.reminderChannels) && a.reminderChannels.length
      ? a.reminderChannels.filter(c => c === 'telegram' || c === 'zalo') : ['telegram'],
    pushTargets: Array.isArray(a.pushTargets) ? a.pushTargets.map(t => ({
      channel: ['telegram', 'zalo_user', 'zalo_group'].includes(t?.channel) ? t.channel : 'telegram',
      toId: clean(t?.toId, 100),
      toName: clean(t?.toName, 200),
      atTime: /^\d{2}:\d{2}$/.test(t?.atTime || '') ? t.atTime : null,
      daily: !!t?.daily,
      template: clean(t?.template, 1000),
    })) : [],
    status: ['scheduled', 'done', 'canceled'].includes(a.status) ? a.status : 'scheduled',
    reminderFiredAt: a.reminderFiredAt || null,
    pushedAt: (a.pushedAt && typeof a.pushedAt === 'object') ? a.pushedAt : {},
    createdBy: a.createdBy || 'telegram',
    createdAt: a.createdAt || new Date().toISOString(),
  };
}

// isZaloListenerAlive + sendZaloTo moved to lib/channels.js

function substituteApptTemplate(tpl, apt) {
  if (!tpl) return '';
  const hhmm = vnHHMM(apt.start);
  const ddmm = vnDDMM(apt.start);
  return String(tpl)
    .replace(/\{title\}/g, apt.title || '')
    .replace(/\{customerName\}/g, apt.customerName || '')
    .replace(/\{phone\}/g, apt.phone || '')
    .replace(/\{meetingUrl\}/g, apt.meetingUrl || '')
    .replace(/\{location\}/g, apt.location || '')
    .replace(/\{note\}/g, apt.note || '')
    .replace(/\{startHHMM\}/g, hhmm)
    .replace(/\{startDate\}/g, ddmm);
}

function defaultApptPushTemplate(apt) {
  let t = 'Lịch hẹn: {title}';
  if (apt.start) t += ' lúc {startHHMM} ({startDate})';
  if (apt.customerName) t += ' với {customerName}';
  if (apt.meetingUrl) t += '\nLink: {meetingUrl}';
  if (apt.location) t += '\nĐịa điểm: {location}';
  return t;
}

function buildApptReminderText(apt) {
  const hhmm = vnHHMM(apt.start);
  let txt = `Nhắc lịch: ${apt.title || 'Cuộc hẹn'}`;
  if (hhmm) txt += ` lúc ${hhmm}`;
  if (apt.customerName) txt += ` với ${apt.customerName}`;
  if (apt.meetingUrl) txt += `\nLink: ${apt.meetingUrl}`;
  if (apt.location) txt += `\nĐịa điểm: ${apt.location}`;
  if (apt.note) txt += `\nGhi chú: ${apt.note}`;
  return txt;
}

async function fireApptPushTarget(apt, target) {
  const tpl = target.template || defaultApptPushTemplate(apt);
  const text = substituteApptTemplate(tpl, apt);
  try {
    let ok = false;
    if (target.channel === 'telegram') {
      ok = !!(await sendTelegram(text));
    } else if (target.channel === 'zalo_user' || target.channel === 'zalo_group') {
      if (isChannelPaused('zalo')) {
        // Zalo paused — don't silently drop. Alert CEO on Telegram so they know
        // push was skipped, and return false so pushedAt is NOT marked → retries
        // on next tick after they resume Zalo.
        try {
          await sendTelegram(`[Cảnh báo] Zalo đang tạm dừng, không push được "${apt.title}" vào ${target.toName || target.toId}. Resume Zalo ở Dashboard.`);
        } catch {}
        return false;
      }
      ok = !!(await sendZaloTo({ id: target.toId, isGroup: target.channel === 'zalo_group' }, text));
    }
    if (ok) {
      try { auditLog('appt_push', { id: apt.id, channel: target.channel, to: target.toName || target.toId }); } catch {}
    }
    return ok;
  } catch (e) {
    console.error('[fireApptPushTarget] failed:', e.message);
    return false;
  }
}

let _apptDispatcherInterval = null;
let _apptDispatcherInitialTimeout = null;
function startAppointmentDispatcher() {
  // Track both interval + initial timeout so a second startAppointmentDispatcher
  // call (cold-boot + wizard-complete both call this) doesn't leak a second
  // initial tick scheduled before the first completed.
  if (_apptDispatcherInterval) clearInterval(_apptDispatcherInterval);
  if (_apptDispatcherInitialTimeout) clearTimeout(_apptDispatcherInitialTimeout);
  _apptDispatcherInterval = setInterval(() => {
    apptDispatcherTick().catch(e => console.error('[apptDispatcher] tick error:', e.message));
  }, 60 * 1000);
  _apptDispatcherInitialTimeout = setTimeout(() => {
    _apptDispatcherInitialTimeout = null;
    apptDispatcherTick().catch(() => {});
  }, 10_000);
  console.log('[apptDispatcher] started (60s tick)');
}

async function apptDispatcherTick() {
  await mutateAppointments(async (list) => {
    if (!list.length) return null;
    let changed = false;
    const now = Date.now();
    const hhmm = vnHHMMNow();
    const todayKey = vnDateKeyNow();
    // Grace window for catch-up reminders after Electron restart / missed tick.
    // If start time passed within GRACE_MS and reminder never fired, still send
    // it with "[Trễ]" prefix so CEO knows.
    const GRACE_MS = 15 * 60_000;

    for (const apt of list) {
      if (apt.status !== 'scheduled') continue;

      // 1) Reminder (with catch-up): fire if in window, or in grace window past start.
      if (apt.start && !apt.reminderFiredAt) {
        const startMs = new Date(apt.start).getTime();
        if (Number.isFinite(startMs)) {
          const reminderMs = startMs - (Number(apt.reminderMinutes) || 0) * 60_000;
          const late = now > startMs;
          const withinLiveWindow = now >= reminderMs && now < startMs;
          const withinGrace = late && now <= startMs + GRACE_MS;
          if (withinLiveWindow || withinGrace) {
            let text = buildApptReminderText(apt);
            if (late) text = '[Trễ] ' + text;
            const channels = apt.reminderChannels && apt.reminderChannels.length ? apt.reminderChannels : ['telegram'];
            let anySent = false;
            for (const ch of channels) {
              try {
                if (ch === 'telegram') anySent = !!(await sendTelegram(text)) || anySent;
                else if (ch === 'zalo') { console.log('[apptDispatcher] Zalo reminder skipped — direct CEO send disabled, use Telegram'); }
              } catch (e) { console.error('[apptDispatcher] reminder send:', e.message); }
            }
            if (anySent) {
              apt.reminderFiredAt = new Date().toISOString();
              try { auditLog('appt_reminder', { id: apt.id, title: apt.title, late }); } catch {}
              changed = true;
            }
          }
        }
      }

      // 2) Auto-mark done after end + 5 min.
      if (apt.end) {
        const endMs = new Date(apt.end).getTime();
        if (Number.isFinite(endMs) && now > endMs + 5 * 60_000) {
          apt.status = 'done';
          changed = true;
        }
      }

      // 3) Push targets at atTime — only mark pushedAt if send actually succeeded.
      if (Array.isArray(apt.pushTargets)) {
        for (let i = 0; i < apt.pushTargets.length; i++) {
          const t = apt.pushTargets[i];
          if (!t || !t.atTime) continue;
          if (t.atTime !== hhmm) continue;

          const startMs = apt.start ? new Date(apt.start).getTime() : null;
          if (t.daily) {
            if (startMs && now > startMs + 24 * 60 * 60_000) continue;
            const pushKey = `${i}_${todayKey}`;
            if (apt.pushedAt && apt.pushedAt[pushKey]) continue;
            const ok = await fireApptPushTarget(apt, t);
            if (ok) {
              apt.pushedAt = apt.pushedAt || {};
              apt.pushedAt[pushKey] = new Date().toISOString();
              changed = true;
            }
          } else {
            const pushKey = `${i}`;
            if (apt.pushedAt && apt.pushedAt[pushKey]) continue;
            if (startMs) {
              if (now > startMs) continue;
              if (now < startMs - 7 * 24 * 60 * 60_000) continue;
            }
            const ok = await fireApptPushTarget(apt, t);
            if (ok) {
              apt.pushedAt = apt.pushedAt || {};
              apt.pushedAt[pushKey] = new Date().toISOString();
              changed = true;
            }
          }
        }
      }
    }

    return changed ? list : null;
  });
}

function cleanupAppointmentTimers() {
  if (_apptDispatcherInterval) { clearInterval(_apptDispatcherInterval); _apptDispatcherInterval = null; }
  if (_apptDispatcherInitialTimeout) { clearTimeout(_apptDispatcherInitialTimeout); _apptDispatcherInitialTimeout = null; }
}

module.exports = {
  getAppointmentsPath, readAppointments, writeAppointments,
  newAppointmentId, mutateAppointments,
  vnHHMM, vnDDMM, vnHHMMNow, vnDateKeyNow,
  normalizeAppointment,
  substituteApptTemplate, defaultApptPushTemplate, buildApptReminderText,
  fireApptPushTarget, startAppointmentDispatcher, apptDispatcherTick,
  cleanupAppointmentTimers,
};
