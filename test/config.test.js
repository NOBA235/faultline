'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');

const valid = { ENCRYPTION_KEY: 'a'.repeat(64), SESSION_SECRET: 'b'.repeat(32), ADMIN_PASSWORD: 'c'.repeat(12) };

test('valid environment loads with defaults', () => {
  const c = loadConfig(valid);
  assert.equal(c.port, 3000);
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.cookieSecure, false);
});

test('missing or weak settings list every problem', () => {
  assert.throws(() => loadConfig({}), (e) => e.code === 'INVALID_CONFIG' && /ENCRYPTION_KEY/.test(e.message) && /SESSION_SECRET/.test(e.message) && /ADMIN_PASSWORD/.test(e.message));
  assert.throws(() => loadConfig({ ...valid, ENCRYPTION_KEY: 'xyz' }), /ENCRYPTION_KEY/);
  assert.throws(() => loadConfig({ ...valid, PORT: '99999' }), /PORT/);
});
