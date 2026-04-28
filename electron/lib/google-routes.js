'use strict';
const googleApi = require('./google-api');

module.exports = async function handleGoogleRoute(urlPath, params, req, res, jsonResp) {
  try {
    if (urlPath === '/status') {
      return jsonResp(res, 200, googleApi.authStatus());
    }
    if (urlPath === '/calendar/events') {
      const r = await googleApi.listEvents(params.from, params.to);
      return jsonResp(res, 200, r);
    }
    if (urlPath === '/calendar/create') {
      if (!params.summary || !params.start || !params.end) return jsonResp(res, 400, { error: 'summary, start, end required' });
      const r = await googleApi.createEvent(params.summary, params.start, params.end, params.attendees);
      return jsonResp(res, 200, r);
    }
    if (urlPath === '/calendar/delete') {
      if (!params.eventId) return jsonResp(res, 400, { error: 'eventId required' });
      const r = await googleApi.deleteEvent(params.eventId);
      return jsonResp(res, 200, r);
    }
    if (urlPath === '/calendar/freebusy') {
      const r = await googleApi.getFreeBusy(params.from, params.to);
      return jsonResp(res, 200, r);
    }
    if (urlPath === '/calendar/free-slots') {
      const r = await googleApi.getFreeSlots(params.date, params.workStart, params.workEnd, params.slotMinutes);
      return jsonResp(res, 200, r);
    }
    return jsonResp(res, 404, { error: 'unknown google route: ' + urlPath });
  } catch (e) {
    return jsonResp(res, 500, { error: e.message });
  }
};
