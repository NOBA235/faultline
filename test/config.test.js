'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');

const valid = { ENCRYPTION_KEY: 'a'.repeat(64), SESSION_SECRET: 'b'.repeat(32), ADMIN_PASSWORD: 'c'.repeat(12) };

test('valid environment loads with defaults including optional OpenAI settings', () => {
  const c = loadConfig(valid);
  assert.equal(c.port, 3000);
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.cookieSecure, false);
  assert.equal(c.openaiApiKey, null);
  assert.equal(c.openaiModel, 'gpt-4o-mini');
  assert.equal(c.openaiTimeoutMs, 15000);

  const withAi = loadConfig({ ...valid, OPENAI_API_KEY: '  sk-test-placeholder-key  ', OPENAI_MODEL: 'gpt-4o', OPENAI_TIMEOUT_MS: '20000' });
  assert.equal(withAi.openaiApiKey, 'sk-test-placeholder-key');
  assert.equal(withAi.openaiModel, 'gpt-4o');
  assert.equal(withAi.openaiTimeoutMs, 20000);
});

test('missing or weak settings list every problem', () => {
  assert.throws(() => loadConfig({}), (e) => e.code === 'INVALID_CONFIG' && /ENCRYPTION_KEY/.test(e.message) && /SESSION_SECRET/.test(e.message) && /ADMIN_PASSWORD/.test(e.message));
  assert.throws(() => loadConfig({ ...valid, ENCRYPTION_KEY: 'xyz' }), /ENCRYPTION_KEY/);
  assert.throws(() => loadConfig({ ...valid, PORT: '99999' }), /PORT/);
  assert.throws(() => loadConfig({ ...valid, OPENAI_MODEL: 'bad model with spaces!' }), /OPENAI_MODEL/);
  assert.throws(() => loadConfig({ ...valid, OPENAI_TIMEOUT_MS: '50' }), /OPENAI_TIMEOUT_MS/);
});
