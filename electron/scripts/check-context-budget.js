#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const {
  applyDynamicContextBudget,
  resolveDynamicContextBudgetTokens,
  resolveBootstrapMaxCharsForContext,
  resolveBootstrapTotalMaxCharsForContext,
} = require('../lib/config');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function baseConfig(model = { id: 'main', name: 'Main Combo' }) {
  return {
    models: {
      providers: {
        ninerouter: {
          models: [model, { id: 'zalo', name: 'Zalo Combo (gpt-5.2)' }],
        },
      },
    },
    agents: {
      defaults: {
        model: 'ninerouter/main',
      },
    },
  };
}

function testPremiumDefaultFloor() {
  const cfg = baseConfig();
  const changed = applyDynamicContextBudget(cfg);
  assert.strictEqual(changed, true, 'missing budget should change config');
  assert.strictEqual(resolveDynamicContextBudgetTokens(cfg), 200000);
  assert.strictEqual(cfg.agents.defaults.contextTokens, 200000);
  assert.strictEqual(cfg.models.providers.ninerouter.models[0].contextWindow, 200000);
  assert.strictEqual(cfg.models.providers.ninerouter.models[0].contextTokens, 200000);
  assert.strictEqual(cfg.models.providers.ninerouter.models[1].contextWindow, 200000);
  assert.strictEqual(cfg.models.providers.ninerouter.models[1].contextTokens, 200000);
  assert.strictEqual(cfg.agents.defaults.bootstrapMaxChars, resolveBootstrapMaxCharsForContext(200000));
  assert.strictEqual(cfg.agents.defaults.bootstrapTotalMaxChars, resolveBootstrapTotalMaxCharsForContext(200000));
}

function testGpt54PreservesLargerConfiguredWindow() {
  const cfg = baseConfig({ id: 'main', name: 'gpt-5.4', contextWindow: 272000 });
  applyDynamicContextBudget(cfg);
  assert.strictEqual(cfg.agents.defaults.contextTokens, 272000);
  assert.strictEqual(cfg.models.providers.ninerouter.models[0].contextWindow, 272000);
  assert.strictEqual(cfg.models.providers.ninerouter.models[0].contextTokens, 272000);
  assert.ok(cfg.agents.defaults.bootstrapMaxChars > resolveBootstrapMaxCharsForContext(200000));
}

function testOneMillionContextIsNotCappedDown() {
  const cfg = baseConfig({ id: 'main', name: 'claude-sonnet-4-1m', contextWindow: 1048576 });
  applyDynamicContextBudget(cfg);
  assert.strictEqual(cfg.agents.defaults.contextTokens, 1048576);
  assert.strictEqual(cfg.models.providers.ninerouter.models[0].contextWindow, 1048576);
  assert.strictEqual(cfg.models.providers.ninerouter.models[0].contextTokens, 1048576);
}

function testIdempotentWhenAlreadyApplied() {
  const cfg = baseConfig({ id: 'main', name: 'gpt-5.4', contextWindow: 272000, contextTokens: 272000 });
  applyDynamicContextBudget(cfg);
  const afterFirst = clone(cfg);
  const changed = applyDynamicContextBudget(cfg);
  assert.strictEqual(changed, false, 'second application should not churn config');
  assert.deepStrictEqual(cfg, afterFirst);
}

function testSmokeGuardNoHard20kBudget() {
  const smoke = fs.readFileSync(path.join(root, 'scripts', 'smoke-test.js'), 'utf-8');
  assert.ok(!smoke.includes('20K context budget'), 'smoke-test still documents a hard 20K context budget');
  assert.ok(!/charCount\s*>\s*20000/.test(smoke), 'smoke-test still enforces charCount > 20000');
}

testPremiumDefaultFloor();
testGpt54PreservesLargerConfiguredWindow();
testOneMillionContextIsNotCappedDown();
testIdempotentWhenAlreadyApplied();
testSmokeGuardNoHard20kBudget();

console.log('[check-context-budget] PASS');
