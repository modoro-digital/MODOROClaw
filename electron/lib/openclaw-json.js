'use strict';

const fs = require('fs');

function stripJsonPrefix(text) {
  return String(text || '').replace(/^\uFEFF/, '').replace(/^\u00EF\u00BB\u00BF/, '');
}

function parseOpenclawJsonText(text) {
  return JSON.parse(stripJsonPrefix(text));
}

function readOpenclawJsonFile(filePath) {
  return parseOpenclawJsonText(fs.readFileSync(filePath, 'utf-8'));
}

module.exports = {
  stripJsonPrefix,
  parseOpenclawJsonText,
  readOpenclawJsonFile,
};
