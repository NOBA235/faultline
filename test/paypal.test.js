'use strict';
// Uses the local FIXTURE server from support/fixtures.js. These are NOT PayPal Sandbox tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PayPalClient } = require('../src/paypal');
const { startFixturePayPal, GOOD_ID, GOOD_SECRET, BAD_SECRET, SLOW_ID } = require('../support/fixtures');

let fixture;
test.before(async () => { fixture = await startFixturePayPal(); });
test.after(async () => { await fixture.close(); });

const client = (over) => new PayPalClient({ baseUrl: fixture.url, timeoutMs: 400, ...over });

test('[fixture] valid credentials -> ok with app id; request has Basic auth + client_credentials', async () => {
  const r = await client().authenticate(GOOD_ID, GOOD_SECRET);
  assert.equal(r.ok, true);
  assert.equal(r.appId, 'APP-FIXTURE0001');
  const last = fixture.seen.at(-1);
  assert.equal(last.method, 'POST');
  assert.equal(last.url, '/v1/oauth2/token');
  assert.equal(last.authorization, 'Basic ' + Buffer.from(`${GOOD_ID}:${GOOD_SECRET}`).toString('base64'));
  assert.equal(last.body, 'grant_type=client_credentials');
});

test('[fixture] 401 invalid_client -> auth_failed, shows the provider message, never leaks the secret', async () => {
  const r = await client().authenticate(GOOD_ID, BAD_SECRET);
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'auth_failed');
  assert.equal(r.code, 'invalid_client');
  assert.match(r.message, /Client Authentication failed/);
  assert.equal(r.debugId, 'fixture-debug-id');
  assert.ok(!JSON.stringify(r).includes(BAD_SECRET));
});

test('[fixture] HTTP 500 -> unreachable (not connected)', async () => {
  const r = await client().authenticate('FIXTURE_SERVER_ERROR', GOOD_SECRET);
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'unreachable');
  assert.equal(r.code, 'HTTP_500');
});

test('[fixture] HTTP 200 with a non-token body -> not connected', async () => {
  const r = await client().authenticate('FIXTURE_MALFORMED_ID', GOOD_SECRET);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MALFORMED_RESPONSE');
});

test('[fixture] slow response -> TIMEOUT', async () => {
  const r = await client().authenticate(SLOW_ID, GOOD_SECRET);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TIMEOUT');
});

test('connection refused -> unreachable with a network error code', async () => {
  const r = await new PayPalClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 1000 }).authenticate(GOOD_ID, GOOD_SECRET);
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'unreachable');
  assert.match(r.code, /ECONNREFUSED|NETWORK_ERROR/);
});

test('the default base URL is the real PayPal Sandbox', () => {
  assert.equal(new PayPalClient().baseUrl, 'https://api-m.sandbox.paypal.com');
});

test('[fixture] authenticate() never exposes the access token, fetchToken() does for internal use', async () => {
  const c = client();
  const a = await c.authenticate(GOOD_ID, GOOD_SECRET);
  assert.equal(a.ok, true);
  assert.equal('accessToken' in a, false);
  assert.ok(!JSON.stringify(a).includes('fixture-token'));
  const f = await c.fetchToken(GOOD_ID, GOOD_SECRET);
  assert.match(f.accessToken, /^fixture-token-\d+$/);
});

test('refuses to build a PayPal URL from a malformed ID', () => {
  const c = client();
  assert.throws(() => c.getOrder('tok', '../../etc'), /malformed ID/);
  assert.throws(() => c.getCapture('tok', 'A B'), /malformed ID/);
  assert.throws(() => c.captureOrder('tok', '', 'x'), /malformed ID/);
});
