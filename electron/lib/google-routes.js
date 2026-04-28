'use strict';
const googleApi = require('./google-api');

module.exports = function handleGoogleRoute(urlPath, params, req, res, jsonResp) {
  try {
    if (urlPath === '/status') {
      return jsonResp(res, 200, googleApi.authStatus());
    }
    return jsonResp(res, 404, { error: 'unknown google route: ' + urlPath });
  } catch (e) {
    return jsonResp(res, 500, { error: e.message });
  }
};
