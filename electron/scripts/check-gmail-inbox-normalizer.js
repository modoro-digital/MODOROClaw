#!/usr/bin/env node
'use strict';

const path = require('path');
const googleApi = require(path.join(__dirname, '..', 'lib', 'google-api'));

const t = googleApi._test || {};
const failures = [];

function assert(name, condition, detail) {
  if (!condition) failures.push(`${name}: ${detail || 'assertion failed'}`);
}

const inboxFixture = {
  nextPageToken: 'page-1',
  threads: [
    {
      id: 'thread-1',
      snippet: 'Xin chao',
      messages: [
        {
          id: 'msg-1',
          threadId: 'thread-1',
          snippet: 'Xin chao',
          headers: [
            { name: 'From', value: 'Peter Bui <peter@example.com>' },
            { name: 'Subject', value: 'Bao gia ngay mai' },
            { name: 'Date', value: 'Wed, 30 Apr 2026 07:00:00 +0700' },
          ],
        },
      ],
    },
  ],
};

const readFixture = {
  body: 'Noi dung email',
  headers: [
    { name: 'Subject', value: 'Xac nhan don hang' },
    { name: 'From', value: 'Peter Bui <peter@example.com>' },
    { name: 'Date', value: 'Wed, 30 Apr 2026 08:00:00 +0700' },
  ],
  message: {
    id: 'msg-1',
    snippet: 'Noi dung email',
    headers: [
      { name: 'Subject', value: 'Xac nhan don hang' },
      { name: 'From', value: 'Peter Bui <peter@example.com>' },
      { name: 'Date', value: 'Wed, 30 Apr 2026 08:00:00 +0700' },
    ],
  },
  sizeEstimate: 1234,
  snippet: 'Noi dung email',
  unsubscribe: 'https://example.com/unsubscribe',
};

assert('exports normalizeGmailInboxResult', typeof t.normalizeGmailInboxResult === 'function', 'missing helper');
assert('exports normalizeGmailReadResult', typeof t.normalizeGmailReadResult === 'function', 'missing helper');

if (typeof t.normalizeGmailInboxResult === 'function') {
  const normalizedInbox = t.normalizeGmailInboxResult(inboxFixture);
  assert('preserves raw threads', Array.isArray(normalizedInbox.threads), JSON.stringify(normalizedInbox));
  assert('aliases inbox threads to messages', Array.isArray(normalizedInbox.messages), JSON.stringify(normalizedInbox));
  assert('aliases inbox threads to items', Array.isArray(normalizedInbox.items), JSON.stringify(normalizedInbox));
  assert('aliases inbox threads to data', Array.isArray(normalizedInbox.data), JSON.stringify(normalizedInbox));
  assert('keeps inbox thread count', normalizedInbox.messages?.length === 1, JSON.stringify(normalizedInbox));
  assert('normalizes inbox subject', normalizedInbox.messages?.[0]?.subject === 'Bao gia ngay mai', JSON.stringify(normalizedInbox.messages?.[0]));
  assert('normalizes inbox from', normalizedInbox.messages?.[0]?.from === 'Peter Bui <peter@example.com>', JSON.stringify(normalizedInbox.messages?.[0]));
  assert('normalizes inbox date', normalizedInbox.messages?.[0]?.date === 'Wed, 30 Apr 2026 07:00:00 +0700', JSON.stringify(normalizedInbox.messages?.[0]));
}

if (typeof t.normalizeGmailReadResult === 'function') {
  const normalizedRead = t.normalizeGmailReadResult(readFixture);
  assert('readEmail exposes subject', normalizedRead.subject === 'Xac nhan don hang', JSON.stringify(normalizedRead));
  assert('readEmail exposes from', normalizedRead.from === 'Peter Bui <peter@example.com>', JSON.stringify(normalizedRead));
  assert('readEmail exposes date', normalizedRead.date === 'Wed, 30 Apr 2026 08:00:00 +0700', JSON.stringify(normalizedRead));
  assert('readEmail keeps body', normalizedRead.body === 'Noi dung email', JSON.stringify(normalizedRead));
  assert('readEmail keeps headers', Array.isArray(normalizedRead.headers), JSON.stringify(normalizedRead));
}

if (failures.length) {
  console.error('[gmail-inbox-normalizer] FAIL');
  for (const failure of failures) console.error('  - ' + failure);
  process.exit(1);
}

console.log('[gmail-inbox-normalizer] PASS Gmail inbox and readEmail normalization');
