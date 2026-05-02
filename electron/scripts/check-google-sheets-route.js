#!/usr/bin/env node
'use strict';

const path = require('path');
const googleRoutes = require(path.join(__dirname, '..', 'lib', 'google-routes'));

const t = googleRoutes._test;
const failures = [];

function assert(name, condition, detail) {
  if (!condition) failures.push(`${name}: ${detail || 'assertion failed'}`);
}

const parsed = t.normalizeSheetValues({ values: '[["Ngày","Danh mục"],["",""]]' });
assert('parse JSON values', parsed.ok && Array.isArray(parsed.values) && parsed.values.length === 2, JSON.stringify(parsed));

const invalid = t.normalizeSheetValues({ values: '[1,2,3]' });
assert('reject non-2D JSON values', invalid.ok === false, JSON.stringify(invalid));

const invalidArray = t.normalizeSheetValues({ values: ['Ngày', 'Danh mục'] });
assert('reject non-2D array values', invalidArray.ok === false, JSON.stringify(invalidArray));

assert(
  'expand single row range',
  t.fitSheetRangeToValues('Sheet1!A1:H1', [['A', 'B'], ['C', 'D']]) === 'Sheet1!A1:H2',
  t.fitSheetRangeToValues('Sheet1!A1:H1', [['A', 'B'], ['C', 'D']])
);

assert(
  'expand single cell range',
  t.fitSheetRangeToValues('Sheet1!A1', [['A', 'B', 'C'], ['D', 'E', 'F']]) === 'Sheet1!A1:C2',
  t.fitSheetRangeToValues('Sheet1!A1', [['A', 'B', 'C'], ['D', 'E', 'F']])
);

assert(
  'preserve quoted sheet prefix',
  t.fitSheetRangeToValues("'Chi tiêu'!B2", [['A', 'B'], ['C', 'D']]) === "'Chi tiêu'!B2:C3",
  t.fitSheetRangeToValues("'Chi tiêu'!B2", [['A', 'B'], ['C', 'D']])
);

if (failures.length) {
  console.error('[google-sheets-route] FAIL');
  for (const failure of failures) console.error('  - ' + failure);
  process.exit(1);
}

console.log('[google-sheets-route] PASS values JSON parsing and range fitting');
