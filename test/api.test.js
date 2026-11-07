'use strict';
// API tests run against a local FIXTURE standing in for PayPal (see support/fixtures.js). They test
// FAULTLINE's own behavior, not PayPal's. They are NOT PayPal Sandbox integration tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startFixturePayPal, startTestApp, goodProject, GOOD_ID, GOOD_SECRET, BAD_SECRET, SLOW_ID } = require('../support/fixtures');

let fixture;
let t;
test.before(async () => { fixture = await startFixturePayPal(); });
test.after(async () => { await fixture.close(); });
test.beforeEach(async () => { t = await startTestApp(fixture.url); });
test.afterEach(async () => { await t.close(); });

test('health is public; project routes require sign-in', async () => {
  assert.equal((await t.request('GET', '/api/health')).status, 200);
  const r = await t.request('GET', '/api/projects');
  assert.equal(r.status, 401);
  assert.equal(r.json.error.code, 'not_authenticated');
  assert.equal((await t.request('POST', '/api/projects', goodProject())).status, 401);
});

test('login: wrong password rejected, correct password sets an HttpOnly SameSite=Strict cookie', async () => {
  const bad = await t.request('POST', '/api/auth/login', { password: 'nope' });
  assert.equal(bad.status, 401);
  const ok = await t.login();
  const cookie = ok.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  assert.equal((await t.request('GET', '/api/auth/me')).json.authenticated, true);
});

test('login is rate limited after repeated failures', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await t.request('POST', '/api/auth/login', { password: 'wrong' })).status, 401);
  const blocked = await t.request('POST', '/api/auth/login', { password: 'wrong' });
  assert.equal(blocked.status, 429);
});

test('a forged session cookie is rejected', async () => {
  const r = await t.request('GET', '/api/projects', undefined, { Cookie: 'fl_session=eyJleHAiOjk5OTk5OTk5OTk5OTl9.forged' });
  assert.equal(r.status, 401);
});

test('cross-origin writes are blocked', async () => {
  await t.login();
  const r = await t.request('POST', '/api/projects', goodProject(), { Origin: 'http://evil.example' });
  assert.equal(r.status, 403);
});

test('[fixture] create project with valid credentials -> connected, secret never exposed or stored in plaintext', async () => {
  await t.login();
  const r = await t.request('POST', '/api/projects', goodProject());
  assert.equal(r.status, 201);
  assert.equal(r.json.project.connection.status, 'connected');
  assert.equal(r.json.project.connection.paypalAppId, 'APP-FIXTURE0001');
  assert.equal(r.json.check.outcome, 'connected');
  assert.equal(r.json.project.environment, 'sandbox');

  const id = r.json.project.id;
  for (const path of ['/api/projects', `/api/projects/${id}`]) {
    assert.ok(!(await t.request('GET', path)).text.includes(GOOD_SECRET), `${path} leaked the secret`);
  }
  assert.ok(!r.text.includes(GOOD_SECRET));

  const row = t.db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  assert.ok(!JSON.stringify(row).includes(GOOD_SECRET), 'secret stored in plaintext');
  assert.match(row.paypal_secret_enc, /^v1:/);
});

test('[fixture] create project with rejected credentials -> auth_failed with the real error, never "connected"', async () => {
  await t.login();
  const r = await t.request('POST', '/api/projects', goodProject({ clientSecret: BAD_SECRET }));
  assert.equal(r.status, 201);
  assert.equal(r.json.project.connection.status, 'auth_failed');
  assert.equal(r.json.project.connection.errorCode, 'invalid_client');
  assert.match(r.json.project.connection.errorMessage, /Client Authentication failed/);
  assert.equal(r.json.project.connection.paypalAppId, null);
  assert.ok(!r.text.includes(BAD_SECRET));
});

test('[fixture] PayPal server error -> unreachable, not connected', async () => {
  await t.login();
  const r = await t.request('POST', '/api/projects', goodProject({ clientId: 'FIXTURE_SERVER_ERROR' }));
  assert.equal(r.json.project.connection.status, 'unreachable');
  assert.equal(r.json.project.connection.errorCode, 'HTTP_500');
});

test('every connection check is recorded', async () => {
  await t.login();
  const created = await t.request('POST', '/api/projects', goodProject());
  const id = created.json.project.id;
  await t.request('POST', `/api/projects/${id}/validate`);
  const detail = await t.request('GET', `/api/projects/${id}`);
  assert.equal(detail.json.checks.length, 2);
  assert.equal(detail.json.checks[0].outcome, 'connected');
  assert.equal(detail.json.checks[0].paypalDebugId, 'fixture-debug-id');
});

test('validation errors are specific and nothing is saved', async () => {
  await t.login();
  const cases = [
    [{ ...goodProject(), name: '  ' }, 'name'],
    [{ ...goodProject(), webhookEndpointUrl: 'ftp://example.com/hook' }, 'webhookEndpointUrl'],
    [{ ...goodProject(), webhookEndpointUrl: 'http://user:pass@example.com/hook' }, 'webhookEndpointUrl'],
    [{ ...goodProject(), webhookEndpointUrl: 'not a url' }, 'webhookEndpointUrl'],
    [{ ...goodProject(), clientId: 'short' }, 'clientId'],
    [{ ...goodProject(), clientSecret: 'has space inside value' }, 'clientSecret'],
    [{}, 'name'],
  ];
  for (const [body, field] of cases) {
    const r = await t.request('POST', '/api/projects', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.error.code, 'validation_failed');
    assert.ok(r.json.error.fields[field], `expected an error on ${field}`);
  }
  assert.equal((await t.request('GET', '/api/projects')).json.projects.length, 0);
});

test('malformed JSON and non-object bodies return 400', async () => {
  await t.login();
  const bad = await t.request('POST', '/api/projects', '{"name": ');
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'invalid_json');
  const arr = await t.request('POST', '/api/projects', '[1,2]');
  assert.equal(arr.status, 400);
});

test('duplicate project names are rejected (case-insensitive)', async () => {
  await t.login();
  await t.request('POST', '/api/projects', goodProject());
  const r = await t.request('POST', '/api/projects', goodProject({ name: 'CHECKOUT SERVICE' }));
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'name_taken');
});

test('[fixture] replacing credentials resets status and re-checks; one credential field alone is refused', async () => {
  await t.login();
  const created = await t.request('POST', '/api/projects', goodProject({ clientSecret: BAD_SECRET }));
  const id = created.json.project.id;
  assert.equal(created.json.project.connection.status, 'auth_failed');

  const half = await t.request('PATCH', `/api/projects/${id}`, { clientId: GOOD_ID });
  assert.equal(half.status, 400);
  assert.ok(half.json.error.fields.clientSecret);

  const fixed = await t.request('PATCH', `/api/projects/${id}`, { clientId: GOOD_ID, clientSecret: GOOD_SECRET });
  assert.equal(fixed.status, 200);
  assert.equal(fixed.json.project.connection.status, 'connected');
  assert.equal(fixed.json.check.outcome, 'connected');
});

test('editing name or webhook URL does not touch the connection status', async () => {
  await t.login();
  const id = (await t.request('POST', '/api/projects', goodProject())).json.project.id;
  const r = await t.request('PATCH', `/api/projects/${id}`, { name: 'Renamed', webhookEndpointUrl: 'https://example.com/hook' });
  assert.equal(r.status, 200);
  assert.equal(r.json.project.name, 'Renamed');
  assert.equal(r.json.project.webhookEndpointUrl, 'https://example.com/hook');
  assert.equal(r.json.project.connection.status, 'connected');
  assert.equal(r.json.check, null);
});

test('an undecryptable stored secret is reported honestly and the project is not left "connected"', async () => {
  await t.login();
  const id = (await t.request('POST', '/api/projects', goodProject())).json.project.id;
  t.db.prepare('UPDATE projects SET paypal_secret_enc = ? WHERE id = ?').run('v1:AAAA:AAAA:AAAA', id);
  const r = await t.request('POST', `/api/projects/${id}/validate`);
  assert.equal(r.status, 200);
  assert.equal(r.json.project.connection.status, 'unverified');
  assert.equal(r.json.project.connection.errorCode, 'secret_unreadable');
});

test('[fixture] a second check on the same project while one is running is refused', async () => {
  await t.login();
  const id = (await t.request('POST', '/api/projects', goodProject({ clientId: SLOW_ID }))).json.project.id;
  const [a, b] = await Promise.all([
    t.request('POST', `/api/projects/${id}/validate`),
    t.request('POST', `/api/projects/${id}/validate`),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const rejected = a.status === 409 ? a : b;
  assert.equal(rejected.json.error.code, 'check_in_progress');
});

test('delete removes the project and its check history; unknown ids return 404', async () => {
  await t.login();
  const id = (await t.request('POST', '/api/projects', goodProject())).json.project.id;
  assert.equal((await t.request('DELETE', `/api/projects/${id}`)).status, 204);
  assert.equal((await t.request('GET', `/api/projects/${id}`)).status, 404);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM connection_checks').get().n, 0);
  assert.equal((await t.request('DELETE', `/api/projects/${id}`)).status, 404);
  assert.equal((await t.request('GET', '/api/nope')).status, 404);
});
