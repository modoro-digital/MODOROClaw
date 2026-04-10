/**
 * Google Calendar API — raw HTTPS, no googleapis package.
 *
 * Functions: listEvents, getFreeBusy, createEvent, getFreeSlotsForDay
 * All use getAccessToken() from auth.js for Authorization header.
 */

'use strict';

const { getAccessToken, httpsGet, httpsPostJson } = require('./auth');
const gcalConfig = require('./config');

// ---------------------------------------------------------------------------
// List upcoming events
// ---------------------------------------------------------------------------

async function listEvents(maxResults = 10) {
  const token = await getAccessToken();
  const now = new Date().toISOString();
  const params = new URLSearchParams({
    timeMin: now,
    maxResults: String(maxResults),
    singleEvents: 'true',
    orderBy: 'startTime',
  });
  const resp = await httpsGet(
    'www.googleapis.com',
    `/calendar/v3/calendars/primary/events?${params.toString()}`,
    token
  );
  return (resp.items || []).map(ev => ({
    id: ev.id,
    summary: ev.summary || '(Khong co tieu de)',
    description: ev.description || '',
    start: ev.start?.dateTime || ev.start?.date || '',
    end: ev.end?.dateTime || ev.end?.date || '',
    htmlLink: ev.htmlLink || '',
    location: ev.location || '',
    status: ev.status || 'confirmed',
  }));
}

// ---------------------------------------------------------------------------
// FreeBusy query
// ---------------------------------------------------------------------------

async function getFreeBusy(dateFrom, dateTo) {
  const token = await getAccessToken();
  const body = {
    timeMin: dateFrom,
    timeMax: dateTo,
    items: [{ id: 'primary' }],
  };
  const resp = await httpsPostJson(
    'www.googleapis.com',
    '/calendar/v3/freeBusy',
    body,
    token
  );
  const busy = (resp.calendars?.primary?.busy || []).map(b => ({
    start: b.start,
    end: b.end,
  }));
  return { busy };
}

// ---------------------------------------------------------------------------
// Create event
// ---------------------------------------------------------------------------

async function createEvent({ summary, description, start, end, reminderMinutes }) {
  const token = await getAccessToken();
  const config = gcalConfig.read();
  const reminder = reminderMinutes ?? config.reminderMinutes ?? 15;
  const body = {
    summary,
    description: description || '',
    start: { dateTime: start, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    end: { dateTime: end, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    reminders: {
      useDefault: false,
      overrides: [{ method: 'popup', minutes: reminder }],
    },
  };
  const resp = await httpsPostJson(
    'www.googleapis.com',
    '/calendar/v3/calendars/primary/events',
    body,
    token
  );
  return {
    success: true,
    eventId: resp.id,
    htmlLink: resp.htmlLink,
    summary: resp.summary,
    start: resp.start?.dateTime || resp.start?.date,
    end: resp.end?.dateTime || resp.end?.date,
  };
}

// ---------------------------------------------------------------------------
// Get free slots for a day
// ---------------------------------------------------------------------------

/**
 * Returns available time slots for a given date.
 * Combines freebusy data with working hours config.
 *
 * @param {string} date - ISO date string (e.g. "2026-04-10")
 * @param {number} slotDurationMinutes - Duration of each slot (default from config)
 * @returns {Array<{start: string, end: string}>} - Available slots
 */
async function getFreeSlotsForDay(date, slotDurationMinutes) {
  const config = gcalConfig.read();
  const duration = slotDurationMinutes || config.slotDurationMinutes || 30;
  const workStart = config.workingHours?.start || '08:00';
  const workEnd = config.workingHours?.end || '18:00';

  // Build day boundaries in local timezone
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dayStart = new Date(`${date}T${workStart}:00`);
  const dayEnd = new Date(`${date}T${workEnd}:00`);

  if (dayEnd <= dayStart) return [];

  // Don't return slots in the past
  const now = new Date();

  // Query freebusy for the day
  const { busy } = await getFreeBusy(dayStart.toISOString(), dayEnd.toISOString());

  // Parse busy intervals into Date pairs
  const busyIntervals = busy.map(b => ({
    start: new Date(b.start),
    end: new Date(b.end),
  })).sort((a, b) => a.start - b.start);

  // Generate slots
  const slots = [];
  const slotMs = duration * 60 * 1000;
  let cursor = dayStart.getTime();
  const endMs = dayEnd.getTime();

  while (cursor + slotMs <= endMs) {
    const slotStart = cursor;
    const slotEnd = cursor + slotMs;

    // Check if this slot overlaps any busy interval
    const overlaps = busyIntervals.some(b =>
      slotStart < b.end.getTime() && slotEnd > b.start.getTime()
    );

    // Skip if in the past or overlaps busy
    if (!overlaps && slotEnd > now.getTime()) {
      slots.push({
        start: new Date(slotStart).toISOString(),
        end: new Date(slotEnd).toISOString(),
      });
    }

    cursor += slotMs;
  }

  return slots;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  listEvents,
  getFreeBusy,
  createEvent,
  getFreeSlotsForDay,
};
