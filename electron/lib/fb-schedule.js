'use strict';

// Facebook scheduled auto-posting with CEO approval flow.
//
// Two-phase cron architecture:
//   Phase 1 (generate): fires at postTime minus leadMinutes. Generates image
//     via image-gen, sends preview to CEO via Telegram, writes pending file.
//   Phase 2 (publish): fires at postTime. Checks pending status. If approved
//     → post to Facebook. If still pending → skip + notify. If rejected → skip.
//
// Data files (inside workspace):
//   fb-scheduled-posts.json   — array of schedule configs
//   fb-pending/<id>_<YYYY-MM-DD>.json — one pending file per schedule per day

const fs = require('fs');
const path = require('path');
const { getWorkspace, getBrandAssetsDir, readFbConfig, auditLog } = require('./workspace');
const { sendTelegram: _sendTelegram, sendTelegramPhoto: _sendTelegramPhoto } = require('./channels');

// ─── Constants ─────────────────────────────────────────────────────
const SCHEDULES_FILE = 'fb-scheduled-posts.json';
const PENDING_DIR = 'fb-pending';
const DEFAULT_LEAD_MINUTES = 120;
const PENDING_TTL_DAYS = 7;

// ─── Helpers ───────────────────────────────────────────────────────

function getSchedulesPath() {
  return path.join(getWorkspace(), SCHEDULES_FILE);
}

function getPendingDir() {
  const dir = path.join(getWorkspace(), PENDING_DIR);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

function pendingFilename(scheduleId, dateStr) {
  return `${scheduleId}_${dateStr}.json`;
}

function todayStr() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parse "HH:MM" → { hour, minute } or null */
function parseTime(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const m = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** Subtract minutes from HH:MM, return new "HH:MM" (clamped to same day) */
function subtractMinutes(timeStr, minutes) {
  const parsed = parseTime(timeStr);
  if (!parsed) return null;
  let totalMin = parsed.hour * 60 + parsed.minute - minutes;
  if (totalMin < 0) totalMin = 0;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Convert "HH:MM" to node-cron expression "MM HH * * *" */
function timeToCron(timeStr) {
  const parsed = parseTime(timeStr);
  if (!parsed) return null;
  return `${parsed.minute} ${parsed.hour} * * *`;
}

/** Convert "HH:MM" + day-of-week spec to cron expression */
function timeToCronWithDays(timeStr, daysOfWeek) {
  const parsed = parseTime(timeStr);
  if (!parsed) return null;
  const dow = Array.isArray(daysOfWeek) && daysOfWeek.length > 0
    ? daysOfWeek.join(',')
    : '*';
  return `${parsed.minute} ${parsed.hour} * * ${dow}`;
}

// ─── Data: Schedules ───────────────────────────────────────────────

/**
 * Load all scheduled FB post configs.
 * Returns [] on missing/corrupt file.
 *
 * Schedule shape:
 * {
 *   id: string,
 *   label: string,
 *   postTime: "HH:MM",
 *   leadMinutes: number (default 120),
 *   enabled: boolean,
 *   autoPost: boolean (skip CEO approval),
 *   prompt: string (image generation prompt),
 *   caption: string (FB post caption template),
 *   assetNames: string[] (brand asset filenames for image-gen),
 *   imageSize: string (e.g. "1024x1024"),
 *   daysOfWeek: number[] (0=Sun..6=Sat, empty=every day),
 *   createdAt: ISO string,
 *   updatedAt: ISO string,
 * }
 */
function loadSchedules() {
  try {
    const raw = fs.readFileSync(getSchedulesPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function saveSchedules(schedules) {
  try {
    const p = getSchedulesPath();
    fs.writeFileSync(p, JSON.stringify(schedules, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('[fb-schedule] saveSchedules failed:', e.message);
    return false;
  }
}

// ─── Data: Pending files ───────────────────────────────────────────

/**
 * Pending shape:
 * {
 *   scheduleId: string,
 *   date: "YYYY-MM-DD",
 *   status: "pending" | "approved" | "rejected" | "published" | "skipped" | "regenerating",
 *   imagePath: string (absolute),
 *   caption: string,
 *   prompt: string,
 *   generatedAt: ISO string,
 *   approvedAt: ISO string | null,
 *   publishedAt: ISO string | null,
 *   postId: string | null,
 *   postUrl: string | null,
 *   error: string | null,
 *   autoPost: boolean,
 * }
 */
function loadPending(scheduleId, dateStr) {
  try {
    const p = path.join(getPendingDir(), pendingFilename(scheduleId, dateStr));
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function savePending(pending) {
  try {
    const dir = getPendingDir();
    const filename = pendingFilename(pending.scheduleId, pending.date);
    fs.writeFileSync(path.join(dir, filename), JSON.stringify(pending, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('[fb-schedule] savePending failed:', e.message);
    return false;
  }
}

function listPendingForDate(dateStr) {
  try {
    const dir = getPendingDir();
    if (!fs.existsSync(dir)) return [];
    const suffix = `_${dateStr}.json`;
    return fs.readdirSync(dir)
      .filter(f => f.endsWith(suffix))
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')); }
        catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ─── Phase 1: Generate image + send preview ────────────────────────

/**
 * Called by cron at (postTime - leadMinutes).
 * Generates image, sends preview to CEO via Telegram, writes pending file.
 */
async function handleGenerate(scheduleId) {
  const schedules = loadSchedules();
  const schedule = schedules.find(s => s.id === scheduleId);
  if (!schedule) {
    console.warn(`[fb-schedule] handleGenerate: schedule "${scheduleId}" not found`);
    return;
  }
  if (!schedule.enabled) {
    console.log(`[fb-schedule] handleGenerate: schedule "${scheduleId}" disabled, skipping`);
    return;
  }

  const date = todayStr();
  const existing = loadPending(scheduleId, date);
  if (existing && existing.status !== 'regenerating') {
    console.log(`[fb-schedule] handleGenerate: pending already exists for ${scheduleId} on ${date} (status: ${existing.status}), skipping`);
    return;
  }

  const prompt = schedule.prompt || '';
  const caption = schedule.caption || '';
  if (!prompt) {
    console.warn(`[fb-schedule] handleGenerate: schedule "${scheduleId}" has no prompt`);
    if (_sendTelegram) {
      try { await _sendTelegram(`[FB Schedule] Lịch "${schedule.label}" không có prompt tạo ảnh. Bỏ qua hôm nay.`); } catch {}
    }
    return;
  }

  // Write pending as "generating" so we know it's in progress
  const pending = {
    scheduleId,
    date,
    status: 'pending',
    imagePath: null,
    caption,
    prompt,
    generatedAt: null,
    approvedAt: null,
    publishedAt: null,
    postId: null,
    postUrl: null,
    error: null,
    autoPost: !!schedule.autoPost,
  };
  savePending(pending);

  // Generate image
  const imageGen = require('./image-gen');
  const jobId = imageGen.generateJobId();
  const brandAssetsDir = getBrandAssetsDir();
  const assetNames = Array.isArray(schedule.assetNames) ? schedule.assetNames : [];
  const imageSize = schedule.imageSize || '1024x1024';

  console.log(`[fb-schedule] generating image for "${schedule.label}" (jobId: ${jobId})`);
  auditLog('fb_schedule_generate_start', { scheduleId, date, jobId });

  try {
    const imagePath = await new Promise((resolve, reject) => {
      imageGen.startJob(jobId, prompt, brandAssetsDir, assetNames, imageSize, (err, imgPath) => {
        if (err) return reject(err);
        resolve(imgPath);
      });
    });

    if (!imagePath || !fs.existsSync(imagePath)) {
      throw new Error('Tạo ảnh thành công nhưng file không tồn tại');
    }

    pending.imagePath = imagePath;
    pending.generatedAt = new Date().toISOString();
    pending.status = 'pending';
    savePending(pending);

    auditLog('fb_schedule_generate_done', { scheduleId, date, jobId, imagePath });
    console.log(`[fb-schedule] image generated: ${imagePath}`);

    // Send preview to CEO via Telegram
    if (schedule.autoPost) {
      // Auto-post mode: mark as approved immediately
      pending.status = 'approved';
      pending.approvedAt = new Date().toISOString();
      savePending(pending);

      if (_sendTelegramPhoto) {
        try {
          await _sendTelegramPhoto(imagePath, `[FB Auto-post] "${schedule.label}"\n\nCaption:\n${caption}\n\nSẽ tự động đăng lúc ${schedule.postTime}. Trả lời "hủy ${scheduleId}" để hủy.`);
        } catch (e) {
          console.warn('[fb-schedule] failed to send auto-post preview:', e.message);
        }
      }
    } else {
      // Normal mode: send preview and wait for CEO approval
      if (_sendTelegramPhoto) {
        try {
          await _sendTelegramPhoto(imagePath, `[FB Preview] "${schedule.label}"\n\nCaption:\n${caption}\n\nTrả lời:\n• "ok" hoặc "đăng đi" → đăng ngay\n• "sửa caption: <nội dung mới>" → đổi caption\n• "tạo ảnh khác" → tạo lại ảnh\n• "hủy" → bỏ bài này`);
        } catch (e) {
          console.warn('[fb-schedule] failed to send preview:', e.message);
        }
      } else if (_sendTelegram) {
        try {
          await _sendTelegram(`[FB Preview] "${schedule.label}" — Ảnh đã tạo xong.\nCaption: ${caption}\n\nTrả lời "ok" để duyệt, "hủy" để bỏ.`);
        } catch (e) {
          console.warn('[fb-schedule] failed to send text preview:', e.message);
        }
      }
    }
  } catch (err) {
    pending.status = 'skipped';
    pending.error = err.message;
    savePending(pending);

    auditLog('fb_schedule_generate_failed', { scheduleId, date, jobId, error: err.message });
    console.error(`[fb-schedule] image generation failed for "${schedule.label}":`, err.message);

    if (_sendTelegram) {
      try {
        await _sendTelegram(`[FB Schedule] Tạo ảnh thất bại cho "${schedule.label}": ${err.message}`);
      } catch {}
    }
  }
}

// ─── Phase 2: Publish or skip ──────────────────────────────────────

/**
 * Called by cron at postTime.
 * Checks pending status and either publishes or skips.
 */
async function handlePublish(scheduleId) {
  const schedules = loadSchedules();
  const schedule = schedules.find(s => s.id === scheduleId);
  if (!schedule) {
    console.warn(`[fb-schedule] handlePublish: schedule "${scheduleId}" not found`);
    return;
  }
  if (!schedule.enabled) {
    console.log(`[fb-schedule] handlePublish: schedule "${scheduleId}" disabled, skipping`);
    return;
  }

  const date = todayStr();
  const pending = loadPending(scheduleId, date);

  if (!pending) {
    console.log(`[fb-schedule] handlePublish: no pending for ${scheduleId} on ${date}`);
    return;
  }

  if (pending.status === 'published') {
    console.log(`[fb-schedule] handlePublish: ${scheduleId} already published on ${date}`);
    return;
  }

  if (pending.status === 'rejected' || pending.status === 'skipped') {
    console.log(`[fb-schedule] handlePublish: ${scheduleId} was ${pending.status} on ${date}`);
    return;
  }

  if (pending.status === 'pending' || pending.status === 'regenerating') {
    // CEO hasn't approved yet — skip and notify
    pending.status = 'skipped';
    pending.error = 'CEO chưa duyệt trước giờ đăng';
    savePending(pending);

    auditLog('fb_schedule_skipped', { scheduleId, date, reason: 'not_approved' });
    console.log(`[fb-schedule] skipped ${scheduleId} on ${date}: CEO chưa duyệt`);

    if (_sendTelegram) {
      try {
        await _sendTelegram(`[FB Schedule] Bỏ qua bài "${schedule.label}" hôm nay — chưa được duyệt trước ${schedule.postTime}.`);
      } catch {}
    }
    return;
  }

  if (pending.status !== 'approved') {
    console.warn(`[fb-schedule] handlePublish: unexpected status "${pending.status}" for ${scheduleId} on ${date}`);
    return;
  }

  // Status is "approved" — publish now
  await publishPending(pending, schedule);
}

/**
 * Actually post to Facebook. Used by both handlePublish and immediate approve.
 */
async function publishPending(pending, schedule) {
  const cfg = readFbConfig();
  if (!cfg || !cfg.accessToken) {
    pending.status = 'skipped';
    pending.error = 'Facebook chưa kết nối (không có token)';
    savePending(pending);

    auditLog('fb_schedule_publish_failed', { scheduleId: pending.scheduleId, date: pending.date, error: pending.error });

    if (_sendTelegram) {
      try { await _sendTelegram(`[FB Schedule] Không đăng được "${schedule?.label || pending.scheduleId}": Facebook chưa kết nối.`); } catch {}
    }
    return;
  }

  const fbPub = require('./fb-publisher');
  const caption = pending.caption || '';
  const imagePath = pending.imagePath;

  try {
    let result;
    if (imagePath && fs.existsSync(imagePath)) {
      const imgBuf = fs.readFileSync(imagePath);
      result = await fbPub.postPhoto(cfg.pageId, cfg.accessToken, caption, imgBuf, imagePath);
    } else {
      result = await fbPub.postText(cfg.pageId, cfg.accessToken, caption);
    }

    pending.status = 'published';
    pending.publishedAt = new Date().toISOString();
    pending.postId = result.postId || null;
    pending.postUrl = result.postUrl || null;
    savePending(pending);

    auditLog('fb_schedule_published', {
      scheduleId: pending.scheduleId,
      date: pending.date,
      postId: result.postId,
      postUrl: result.postUrl,
    });
    console.log(`[fb-schedule] published ${pending.scheduleId} on ${pending.date}: ${result.postUrl}`);

    if (_sendTelegram) {
      try {
        await _sendTelegram(`[FB Schedule] Đã đăng "${schedule?.label || pending.scheduleId}" thành công.\n${result.postUrl || ''}`);
      } catch {}
    }
  } catch (err) {
    const isTokenExpired = err._isTokenExpired || err._httpStatus === 401 ||
      /OAuthException|expired|invalid.*token|session.*invalid/i.test(err.message);

    pending.status = 'skipped';
    pending.error = err.message;
    savePending(pending);

    auditLog('fb_schedule_publish_failed', {
      scheduleId: pending.scheduleId,
      date: pending.date,
      error: err.message,
      tokenExpired: isTokenExpired,
    });
    console.error(`[fb-schedule] publish failed for ${pending.scheduleId}:`, err.message);

    if (_sendTelegram) {
      const tokenMsg = isTokenExpired ? ' Token Facebook hết hạn — cần paste token mới vào Dashboard.' : '';
      try {
        await _sendTelegram(`[FB Schedule] Đăng thất bại "${schedule?.label || pending.scheduleId}": ${err.message}${tokenMsg}`);
      } catch {}
    }
  }
}

// ─── Approval actions ──────────────────────────────────────────────

/**
 * CEO approves a pending post. If postTime already passed, publish immediately.
 */
async function approvePending(scheduleId, dateStr) {
  const date = dateStr || todayStr();
  const pending = loadPending(scheduleId, date);
  if (!pending) return { success: false, error: 'Không tìm thấy bài chờ duyệt' };

  if (pending.status === 'published') return { success: false, error: 'Bài đã được đăng' };
  if (pending.status === 'rejected') return { success: false, error: 'Bài đã bị hủy' };

  pending.status = 'approved';
  pending.approvedAt = new Date().toISOString();
  savePending(pending);

  auditLog('fb_schedule_approved', { scheduleId, date });

  // Check if we should publish immediately (past postTime)
  const schedules = loadSchedules();
  const schedule = schedules.find(s => s.id === scheduleId);
  const postTime = schedule?.postTime;
  if (postTime) {
    const parsed = parseTime(postTime);
    if (parsed) {
      const now = new Date();
      const postMinutes = parsed.hour * 60 + parsed.minute;
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      if (nowMinutes >= postMinutes) {
        // Past post time — publish immediately
        await publishPending(pending, schedule);
        return { success: true, published: true, postId: pending.postId, postUrl: pending.postUrl };
      }
    }
  }

  return { success: true, published: false, message: 'Đã duyệt. Sẽ đăng lúc ' + (postTime || '?') };
}

/**
 * CEO rejects a pending post.
 */
function rejectPending(scheduleId, dateStr) {
  const date = dateStr || todayStr();
  const pending = loadPending(scheduleId, date);
  if (!pending) return { success: false, error: 'Không tìm thấy bài chờ duyệt' };

  if (pending.status === 'published') return { success: false, error: 'Bài đã được đăng rồi, không thể hủy' };

  pending.status = 'rejected';
  savePending(pending);

  auditLog('fb_schedule_rejected', { scheduleId, date });
  return { success: true };
}

/**
 * CEO edits the caption of a pending post.
 */
function editCaption(scheduleId, newCaption, dateStr) {
  const date = dateStr || todayStr();
  const pending = loadPending(scheduleId, date);
  if (!pending) return { success: false, error: 'Không tìm thấy bài chờ duyệt' };

  if (pending.status === 'published') return { success: false, error: 'Bài đã được đăng, không thể sửa' };
  if (pending.status === 'rejected' || pending.status === 'skipped') {
    return { success: false, error: 'Bài đã bị hủy hoặc bỏ qua' };
  }

  pending.caption = String(newCaption);
  savePending(pending);

  auditLog('fb_schedule_caption_edited', { scheduleId, date });
  return { success: true, caption: pending.caption };
}

/**
 * CEO requests a new image. Sets status to "regenerating" and triggers handleGenerate.
 */
async function regenerateImage(scheduleId, dateStr) {
  const date = dateStr || todayStr();
  const pending = loadPending(scheduleId, date);
  if (!pending) return { success: false, error: 'Không tìm thấy bài chờ duyệt' };

  if (pending.status === 'published') return { success: false, error: 'Bài đã được đăng' };

  pending.status = 'regenerating';
  pending.error = null;
  savePending(pending);

  auditLog('fb_schedule_regenerate', { scheduleId, date });

  // Fire handleGenerate async — it will detect "regenerating" status and re-create
  handleGenerate(scheduleId).catch(err => {
    console.error(`[fb-schedule] regenerateImage failed for ${scheduleId}:`, err.message);
  });

  return { success: true, message: 'Đang tạo ảnh mới...' };
}

// ─── Cron setup helper ─────────────────────────────────────────────

/**
 * Returns array of cron job definitions for main.js to schedule.
 * Each: { id, phase, cronExpr, handler }
 *   phase "generate" fires at postTime - leadMinutes
 *   phase "publish"  fires at postTime
 */
function getScheduledCronJobs() {
  const schedules = loadSchedules();
  const jobs = [];

  for (const schedule of schedules) {
    if (!schedule.enabled) continue;
    if (!schedule.postTime) continue;

    const postTimeParsed = parseTime(schedule.postTime);
    if (!postTimeParsed) continue;

    const lead = typeof schedule.leadMinutes === 'number' ? schedule.leadMinutes : DEFAULT_LEAD_MINUTES;
    const genTime = subtractMinutes(schedule.postTime, lead);
    if (!genTime) continue;

    const daysOfWeek = Array.isArray(schedule.daysOfWeek) && schedule.daysOfWeek.length > 0
      ? schedule.daysOfWeek
      : null;

    const genCron = daysOfWeek
      ? timeToCronWithDays(genTime, daysOfWeek)
      : timeToCron(genTime);
    const pubCron = daysOfWeek
      ? timeToCronWithDays(schedule.postTime, daysOfWeek)
      : timeToCron(schedule.postTime);

    if (!genCron || !pubCron) continue;

    const sid = schedule.id;

    jobs.push({
      id: `fb-gen-${sid}`,
      phase: 'generate',
      scheduleId: sid,
      cronExpr: genCron,
      handler: () => handleGenerate(sid),
    });

    jobs.push({
      id: `fb-pub-${sid}`,
      phase: 'publish',
      scheduleId: sid,
      cronExpr: pubCron,
      handler: () => handlePublish(sid),
    });
  }

  return jobs;
}

// ─── API route registrar ───────────────────────────────────────────

/**
 * Register FB schedule API routes onto the cron-api HTTP server.
 * Called from cron-api.js route handler.
 *
 * @param {string} urlPath - request URL path
 * @param {object} params - parsed request params
 * @param {function} jsonResp - (res, code, obj) response helper
 * @param {object} res - http response
 * @returns {boolean} true if route was handled, false if not a fb-schedule route
 */
function handleRoute(urlPath, params, jsonResp, res) {
  // List all schedules
  if (urlPath === '/api/fb/schedule/list') {
    const schedules = loadSchedules();
    const date = params.date || todayStr();
    const withPending = schedules.map(s => {
      const pending = loadPending(s.id, date);
      return { ...s, pending: pending || null };
    });
    jsonResp(res, 200, { success: true, schedules: withPending, date });
    return true;
  }

  // Create a new schedule
  if (urlPath === '/api/fb/schedule/create') {
    const { label, postTime, prompt, caption } = params;
    if (!postTime) { jsonResp(res, 400, { success: false, error: 'postTime required (HH:MM)' }); return true; }
    if (!parseTime(postTime)) { jsonResp(res, 400, { success: false, error: 'postTime phải có dạng HH:MM' }); return true; }
    if (!prompt) { jsonResp(res, 400, { success: false, error: 'prompt required' }); return true; }

    const schedules = loadSchedules();
    const id = 'fb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const now = new Date().toISOString();

    let leadMinutes = DEFAULT_LEAD_MINUTES;
    if (params.leadMinutes !== undefined) {
      const parsed = parseInt(params.leadMinutes, 10);
      if (!isNaN(parsed) && parsed >= 5 && parsed <= 480) leadMinutes = parsed;
    }

    let daysOfWeek = [];
    if (params.daysOfWeek) {
      try {
        const raw = typeof params.daysOfWeek === 'string' ? JSON.parse(params.daysOfWeek) : params.daysOfWeek;
        if (Array.isArray(raw)) {
          daysOfWeek = raw.map(Number).filter(n => n >= 0 && n <= 6);
        }
      } catch {}
    }

    const autoPost = params.autoPost === true || params.autoPost === 'true';
    let assetNames = [];
    if (params.assetNames) {
      try {
        const raw = typeof params.assetNames === 'string' ? JSON.parse(params.assetNames) : params.assetNames;
        if (Array.isArray(raw)) assetNames = raw.map(String);
      } catch {}
    }

    const newSchedule = {
      id,
      label: label || 'Bài đăng Facebook',
      postTime,
      leadMinutes,
      enabled: true,
      autoPost,
      prompt: String(prompt),
      caption: caption || '',
      assetNames,
      imageSize: params.imageSize || '1024x1024',
      daysOfWeek,
      createdAt: now,
      updatedAt: now,
    };

    schedules.push(newSchedule);
    saveSchedules(schedules);

    auditLog('fb_schedule_created', { id, label: newSchedule.label, postTime });

    if (autoPost && _sendTelegram) {
      _sendTelegram(`[FB Schedule] Đã tạo lịch "${newSchedule.label}" ở chế độ tự động đăng (không cần duyệt). Trả lời "tắt autopost ${id}" để bật duyệt thủ công.`).catch(() => {});
    }

    jsonResp(res, 200, { success: true, schedule: newSchedule });
    return true;
  }

  // Update a schedule
  if (urlPath === '/api/fb/schedule/update') {
    const { id } = params;
    if (!id) { jsonResp(res, 400, { success: false, error: 'id required' }); return true; }

    const schedules = loadSchedules();
    const idx = schedules.findIndex(s => s.id === id);
    if (idx === -1) { jsonResp(res, 404, { success: false, error: 'Không tìm thấy lịch' }); return true; }

    const existing = schedules[idx];

    if (params.label !== undefined) existing.label = String(params.label);
    if (params.postTime !== undefined) {
      if (!parseTime(params.postTime)) { jsonResp(res, 400, { success: false, error: 'postTime phải có dạng HH:MM' }); return true; }
      existing.postTime = params.postTime;
    }
    if (params.leadMinutes !== undefined) {
      const parsed = parseInt(params.leadMinutes, 10);
      if (!isNaN(parsed) && parsed >= 5 && parsed <= 480) existing.leadMinutes = parsed;
    }
    if (params.enabled !== undefined) existing.enabled = params.enabled === true || params.enabled === 'true';
    if (params.autoPost !== undefined) {
      const newAutoPost = params.autoPost === true || params.autoPost === 'true';
      if (newAutoPost && !existing.autoPost && _sendTelegram) {
        _sendTelegram(`[FB Schedule] Chuyển "${existing.label}" sang chế độ tự động đăng. Bài sẽ đăng không cần duyệt.`).catch(() => {});
      }
      existing.autoPost = newAutoPost;
    }
    if (params.prompt !== undefined) existing.prompt = String(params.prompt);
    if (params.caption !== undefined) existing.caption = String(params.caption);
    if (params.imageSize !== undefined) existing.imageSize = String(params.imageSize);
    if (params.assetNames !== undefined) {
      try {
        const raw = typeof params.assetNames === 'string' ? JSON.parse(params.assetNames) : params.assetNames;
        if (Array.isArray(raw)) existing.assetNames = raw.map(String);
      } catch {}
    }
    if (params.daysOfWeek !== undefined) {
      try {
        const raw = typeof params.daysOfWeek === 'string' ? JSON.parse(params.daysOfWeek) : params.daysOfWeek;
        if (Array.isArray(raw)) existing.daysOfWeek = raw.map(Number).filter(n => n >= 0 && n <= 6);
      } catch {}
    }

    existing.updatedAt = new Date().toISOString();
    schedules[idx] = existing;
    saveSchedules(schedules);

    auditLog('fb_schedule_updated', { id });
    jsonResp(res, 200, { success: true, schedule: existing });
    return true;
  }

  // Delete a schedule
  if (urlPath === '/api/fb/schedule/delete') {
    const { id } = params;
    if (!id) { jsonResp(res, 400, { success: false, error: 'id required' }); return true; }

    const schedules = loadSchedules();
    const idx = schedules.findIndex(s => s.id === id);
    if (idx === -1) { jsonResp(res, 404, { success: false, error: 'Không tìm thấy lịch' }); return true; }

    const removed = schedules.splice(idx, 1)[0];
    saveSchedules(schedules);

    auditLog('fb_schedule_deleted', { id, label: removed.label });
    jsonResp(res, 200, { success: true });
    return true;
  }

  // Approve pending
  if (urlPath === '/api/fb/schedule/approve') {
    const { id, date } = params;
    if (!id) { jsonResp(res, 400, { success: false, error: 'id required' }); return true; }
    approvePending(id, date).then(result => {
      jsonResp(res, result.success ? 200 : 400, result);
    }).catch(err => {
      jsonResp(res, 500, { success: false, error: err.message });
    });
    return true;
  }

  // Reject pending
  if (urlPath === '/api/fb/schedule/reject') {
    const { id, date } = params;
    if (!id) { jsonResp(res, 400, { success: false, error: 'id required' }); return true; }
    const result = rejectPending(id, date);
    jsonResp(res, result.success ? 200 : 400, result);
    return true;
  }

  // Edit caption
  if (urlPath === '/api/fb/schedule/edit-caption') {
    const { id, caption, date } = params;
    if (!id) { jsonResp(res, 400, { success: false, error: 'id required' }); return true; }
    if (caption === undefined) { jsonResp(res, 400, { success: false, error: 'caption required' }); return true; }
    const result = editCaption(id, caption, date);
    jsonResp(res, result.success ? 200 : 400, result);
    return true;
  }

  // Regenerate image
  if (urlPath === '/api/fb/schedule/regenerate') {
    const { id, date } = params;
    if (!id) { jsonResp(res, 400, { success: false, error: 'id required' }); return true; }
    regenerateImage(id, date).then(result => {
      jsonResp(res, result.success ? 200 : 400, result);
    }).catch(err => {
      jsonResp(res, 500, { success: false, error: err.message });
    });
    return true;
  }

  // Get pending details for a specific schedule + date
  if (urlPath === '/api/fb/schedule/pending') {
    const { id, date } = params;
    if (!id) { jsonResp(res, 400, { success: false, error: 'id required' }); return true; }
    const pending = loadPending(id, date || todayStr());
    if (!pending) { jsonResp(res, 404, { success: false, error: 'Không có bài chờ duyệt' }); return true; }
    jsonResp(res, 200, { success: true, pending });
    return true;
  }

  // Trigger manual generate (for testing)
  if (urlPath === '/api/fb/schedule/trigger-generate') {
    const { id } = params;
    if (!id) { jsonResp(res, 400, { success: false, error: 'id required' }); return true; }
    handleGenerate(id).then(() => {
      const pending = loadPending(id, todayStr());
      jsonResp(res, 200, { success: true, pending });
    }).catch(err => {
      jsonResp(res, 500, { success: false, error: err.message });
    });
    return true;
  }

  return false;
}

/**
 * Wrapper matching the export signature described in requirements.
 * Designed to be called from cron-api.js inside the request handler.
 */
function registerRoutes(urlPath, params, jsonResp, res) {
  return handleRoute(urlPath, params, jsonResp, res);
}

// ─── Cleanup old pending files ─────────────────────────────────────

function cleanupOldPending() {
  try {
    const dir = getPendingDir();
    if (!fs.existsSync(dir)) return 0;

    const now = Date.now();
    const cutoff = now - PENDING_TTL_DAYS * 24 * 60 * 60 * 1000;
    let removed = 0;

    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const fullPath = path.join(dir, file);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(fullPath);
          removed++;
        }
      } catch {}
    }

    if (removed > 0) {
      console.log(`[fb-schedule] cleaned up ${removed} old pending file(s)`);
      auditLog('fb_schedule_cleanup', { removed });
    }
    return removed;
  } catch (e) {
    console.error('[fb-schedule] cleanup failed:', e.message);
    return 0;
  }
}

// ─── Telegram command parser ───────────────────────────────────────

/**
 * Parse CEO Telegram reply for FB schedule actions.
 * Returns null if text is not a FB schedule command.
 * Returns { action, scheduleId?, caption?, date? } if it is.
 *
 * Recognized patterns:
 *   "ok", "đăng đi", "duyệt" → approve
 *   "hủy", "hủy <id>" → reject
 *   "sửa caption: <text>" → edit caption
 *   "tạo ảnh khác", "tạo lại ảnh" → regenerate
 *   "tắt autopost <id>" → disable autoPost
 */
function parseTelegramCommand(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim();

  // Approve
  if (/^(ok|đăng đi|duyệt|đăng|post|approve)$/i.test(t)) {
    return { action: 'approve' };
  }

  // Reject with optional id
  const rejectMatch = t.match(/^hủy(?:\s+(.+))?$/i);
  if (rejectMatch) {
    return { action: 'reject', scheduleId: rejectMatch[1]?.trim() || null };
  }

  // Edit caption
  const captionMatch = t.match(/^sửa\s+caption:\s*(.+)$/is);
  if (captionMatch) {
    return { action: 'editCaption', caption: captionMatch[1].trim() };
  }

  // Regenerate image
  if (/^(tạo ảnh khác|tạo lại ảnh|ảnh khác|regenerate|regen)$/i.test(t)) {
    return { action: 'regenerate' };
  }

  // Disable autoPost
  const autoMatch = t.match(/^tắt\s+autopost\s+(.+)$/i);
  if (autoMatch) {
    return { action: 'disableAutoPost', scheduleId: autoMatch[1].trim() };
  }

  return null;
}

/**
 * Handle a parsed Telegram command against the most recent pending post.
 * Returns { handled: boolean, response?: string } for the caller to reply.
 */
async function handleTelegramCommand(cmd) {
  if (!cmd) return { handled: false };

  const date = todayStr();
  const schedules = loadSchedules();

  // Find the most recent pending post for today
  function findActivePending(specificId) {
    if (specificId) {
      const pending = loadPending(specificId, date);
      const schedule = schedules.find(s => s.id === specificId);
      if (pending && schedule) return { pending, schedule };
      return null;
    }
    // Find first pending/approved post for today
    for (const s of schedules) {
      const pending = loadPending(s.id, date);
      if (pending && (pending.status === 'pending' || pending.status === 'approved' || pending.status === 'regenerating')) {
        return { pending, schedule: s };
      }
    }
    return null;
  }

  if (cmd.action === 'approve') {
    const found = findActivePending(cmd.scheduleId);
    if (!found) return { handled: true, response: 'Không có bài Facebook nào đang chờ duyệt hôm nay.' };
    const result = await approvePending(found.pending.scheduleId, date);
    if (!result.success) return { handled: true, response: result.error };
    if (result.published) {
      return { handled: true, response: `Đã duyệt và đăng thành công.\n${result.postUrl || ''}` };
    }
    return { handled: true, response: result.message || 'Đã duyệt.' };
  }

  if (cmd.action === 'reject') {
    const found = findActivePending(cmd.scheduleId);
    if (!found) return { handled: true, response: 'Không có bài Facebook nào đang chờ duyệt hôm nay.' };
    const result = rejectPending(found.pending.scheduleId, date);
    if (!result.success) return { handled: true, response: result.error };
    return { handled: true, response: `Đã hủy bài "${found.schedule.label}" hôm nay.` };
  }

  if (cmd.action === 'editCaption') {
    const found = findActivePending(cmd.scheduleId);
    if (!found) return { handled: true, response: 'Không có bài Facebook nào đang chờ duyệt hôm nay.' };
    const result = editCaption(found.pending.scheduleId, cmd.caption, date);
    if (!result.success) return { handled: true, response: result.error };
    return { handled: true, response: `Đã cập nhật caption:\n${cmd.caption}` };
  }

  if (cmd.action === 'regenerate') {
    const found = findActivePending(cmd.scheduleId);
    if (!found) return { handled: true, response: 'Không có bài Facebook nào đang chờ duyệt hôm nay.' };
    const result = await regenerateImage(found.pending.scheduleId, date);
    if (!result.success) return { handled: true, response: result.error };
    return { handled: true, response: 'Đang tạo ảnh mới. Sẽ gửi preview khi xong.' };
  }

  if (cmd.action === 'disableAutoPost') {
    const idx = schedules.findIndex(s => s.id === cmd.scheduleId);
    if (idx === -1) return { handled: true, response: `Không tìm thấy lịch "${cmd.scheduleId}".` };
    schedules[idx].autoPost = false;
    schedules[idx].updatedAt = new Date().toISOString();
    saveSchedules(schedules);
    auditLog('fb_schedule_autopost_disabled', { id: cmd.scheduleId });
    return { handled: true, response: `Đã tắt chế độ tự động đăng cho "${schedules[idx].label}". Từ nay sẽ cần duyệt trước khi đăng.` };
  }

  return { handled: false };
}

// ─── Module exports ────────────────────────────────────────────────

module.exports = {
  // Data
  loadSchedules,
  saveSchedules,
  loadPending,
  savePending,

  // Phase handlers (called from startCronJobs in main.js)
  handleGenerate,
  handlePublish,

  // Approval (called from API endpoints or Telegram command handler)
  approvePending,
  rejectPending,
  editCaption,
  regenerateImage,

  // API route registrar (called from cron-api.js request handler)
  registerRoutes,

  // Cron setup helper
  getScheduledCronJobs,

  // Telegram integration
  parseTelegramCommand,
  handleTelegramCommand,

  // Cleanup
  cleanupOldPending,
};
