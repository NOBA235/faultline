'use strict';
// FIXTURE tests. PayPal is the local stand-in (support/fixtures.js) and the "developer's application" is a local recording
// server. The webhook events are made up by this file. They prove what Faultline sends and records, not how a real
// application behaves, and not that real PayPal signatures verify.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startFixturePayPal, startFixtureDestination, startTestApp, goodProject, GOOD_SECRET } = require('../support/fixtures');

let fx; let dest; let t; let pid;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.before(async () => { fx = await startFixturePayPal(); });
test.after(async () => { await fx.close(); });
test.beforeEach(async () => {
  dest = await startFixtureDestination();
  t = await startTestApp(fx.url, 1500);
  await t.login();
  pid = (await t.request('POST', '/api/projects', goodProject({ webhookEndpointUrl: dest.url, paypalWebhookId: 'FXWEBHOOK0001' }))).json.project.id;
});
test.afterEach(async () => { await t.close(); await dest.close(); });

let counter = 0;
const newEvent = () => {
  const id = `WH-SCN-${String(++counter).padStart(4, '0')}-${crypto.randomBytes(3).toString('hex')}`;
  return { id, raw: `{ "resource" : {"id":"FXCAPTURE9${counter}", "amount":{"value":"10.10","currency_code":"USD"}, "ratio":1.10 },\n "id":"${id}", "event_type":"PAYMENT.CAPTURE.COMPLETED", "resource_type":"capture", "create_time":"2026-11-05T10:00:00.000Z", "caf\u00e9":"\u2713" }` };
};
const sig = (over = {}) => ({
  'content-type': 'application/json', 'paypal-auth-algo': 'SHA256withRSA', 'paypal-auth-version': 'v2',
  'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-FIXTURE', 'paypal-transmission-id': `fixture-tx-${counter}`,
  'paypal-transmission-sig': 'FIXTURE-VALID-SIG', 'paypal-transmission-time': '2026-11-05T10:00:05Z', 'correlation-id': 'fixture-corr-1', ...over,
});
const deliver = (raw, headers = sig(), project = pid) => fetch(`${t.base}/webhooks/paypal/${project}`, { method: 'POST', headers, body: raw }).then(async (r) => ({ status: r.status, json: await r.json() }));
// Receives one verified event and returns { ev (stored event), raw, headers }.
const receive = async (over = {}) => {
  const e = newEvent();
  const headers = sig(over);
  const r = await deliver(e.raw, headers);
  assert.equal(r.status, 200);
  return { eventId: r.json.eventId, raw: e.raw, headers, paypalEventId: e.id };
};
const run = (eventId, body) => t.request('POST', `/api/projects/${pid}/events/${eventId}/scenarios`, { idempotencyKey: crypto.randomUUID(), ...body });
const waitRun = async (runId, ms = 6000) => {
  const until = Date.now() + ms;
  for (;;) {
    const d = (await t.request('GET', `/api/projects/${pid}/scenario-runs/${runId}`)).json;
    if (['completed', 'failed', 'cancelled'].includes(d.run.status)) return d;
    if (Date.now() > until) throw new Error(`run ${runId} did not finish: ${d.run.status}`);
    await sleep(40);
  }
};
const runAndWait = async (eventId, body) => {
  const r = await run(eventId, body);
  assert.ok([200, 202].includes(r.status), JSON.stringify(r.json));
  return waitRun(r.json.run.id);
};
const eventStatus = async (eventId) => (await t.request('GET', `/api/projects/${pid}/events/${eventId}`)).json.event.processingStatus;

test('by default a verified event is held: nothing reaches the destination until a scenario is run', async () => {
  const { eventId } = await receive();
  await sleep(150);
  assert.equal(dest.received.length, 0);
  assert.equal(await eventStatus(eventId), 'stored');
  assert.equal((await t.request('GET', `/api/projects/${pid}`)).json.project.forwardMode, 'manual');
});

test('[fixture] forward once: original bytes and PayPal signature headers arrive unchanged, with Faultline labels', async () => {
  const { eventId, raw, headers, paypalEventId } = await receive();
  const r = await run(eventId, { kind: 'forward' });
  assert.equal(r.status, 202);
  const d = await waitRun(r.json.run.id);

  assert.equal(dest.received.length, 1);
  const got = dest.received[0];
  assert.ok(got.body.equals(Buffer.from(raw, 'utf8')), 'body must be byte-identical');
  for (const k of ['paypal-auth-algo', 'paypal-auth-version', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time', 'correlation-id', 'content-type']) {
    assert.equal(got.headers[k], headers[k], k);
  }
  assert.equal(got.headers['x-faultline-scenario'], 'forward');
  assert.equal(got.headers['x-faultline-delivery-kind'], 'original');
  assert.equal(got.headers['x-faultline-attempt'], '1/1');
  assert.equal(got.headers['x-faultline-injected'], 'false');
  assert.equal(got.headers['x-faultline-original-event-id'], paypalEventId);
  assert.equal(got.headers['x-faultline-run-id'], d.run.id);
  assert.equal(got.method, 'POST');
  assert.equal(got.url, '/webhooks/paypal');

  assert.equal(d.run.status, 'completed');
  assert.equal(d.attempts[0].outcome, 'delivered');
  assert.equal(d.attempts[0].httpStatus, 200);
  assert.equal(d.attempts[0].responseSnippet, 'ok');
  assert.equal(d.attempts[0].bodySha256, crypto.createHash('sha256').update(raw).digest('hex'));
  assert.equal(d.result.acceptedCount, 1);
  assert.equal(d.result.originalEventId, paypalEventId);
  assert.equal(d.result.verdict.status, 'inconclusive', 'without a probe a 2xx proves nothing about payment handling');
  assert.ok(d.result.observations.some((o) => /unchanged/.test(o)));
  assert.equal(await eventStatus(eventId), 'forwarded');
});

test('[fixture] duplicate x3 (sequential): same event, same signature headers, every attempt identified', async () => {
  const { eventId, raw } = await receive();
  const d = await runAndWait(eventId, { kind: 'duplicate', count: 3 });
  assert.equal(dest.received.length, 3);
  assert.deepEqual(dest.received.map((x) => x.headers['x-faultline-attempt']), ['1/3', '2/3', '3/3']);
  assert.deepEqual(dest.received.map((x) => x.headers['x-faultline-delivery-kind']), ['original', 'duplicate', 'duplicate']);
  assert.deepEqual(dest.received.map((x) => x.headers['x-faultline-injected']), ['false', 'true', 'true']);
  assert.equal(new Set(dest.received.map((x) => x.headers['paypal-transmission-id'])).size, 1);
  assert.ok(dest.received.every((x) => x.body.equals(Buffer.from(raw, 'utf8'))));
  assert.deepEqual(d.result.statusCodes, [200, 200, 200]);
  assert.equal(d.result.completed, true);
  assert.equal(d.result.plannedAttempts, 3);
});

test('[fixture] a destination that answers differently is reported as observed, never as "passed"', async () => {
  dest.state.handler = (req, n) => ({ status: n === 2 ? 500 : 200, body: n === 2 ? 'boom' : 'ok' });
  const { eventId } = await receive();
  const d = await runAndWait(eventId, { kind: 'duplicate', count: 3 });
  assert.deepEqual(d.result.statusCodes, [200, 500, 200]);
  assert.equal(d.result.acceptedCount, 2);
  assert.equal(d.result.rejectedCount, 1);
  assert.equal(d.attempts[1].outcome, 'http_error');
  assert.equal(d.attempts[1].responseSnippet, 'boom');
  assert.ok(d.result.observations.some((o) => /not answer every delivery the same way/.test(o)));
  assert.equal(d.result.completed, true, 'the scenario ran to the end');
  assert.equal(d.result.verdict.status, 'failed', 'a rejected delivery is a failed check');
  assert.ok(!('passed' in d.result));
});

test('[fixture] concurrent duplicates really arrive at the same time', async () => {
  dest.state.handler = () => ({ status: 200, delayMs: 250 });
  const { eventId } = await receive();
  const d = await runAndWait(eventId, { kind: 'duplicate', count: 4, mode: 'concurrent' });
  assert.equal(dest.received.length, 4);
  const spread = Math.max(...dest.received.map((x) => x.at)) - Math.min(...dest.received.map((x) => x.at));
  assert.ok(spread < 200, `requests should overlap, spread was ${spread} ms`);
  assert.deepEqual(d.attempts.map((a) => a.attemptNo), [1, 2, 3, 4]);
});

test('[fixture] delayed delivery waits, shows reception vs forwarding time, and can be cancelled', async () => {
  const { eventId } = await receive();
  const r = await run(eventId, { kind: 'delay', delaySeconds: 1 });
  assert.equal(r.status, 202);
  assert.equal(r.json.run.status, 'scheduled');
  await sleep(300);
  assert.equal(dest.received.length, 0, 'nothing may be sent before the delay has passed');
  const d = await waitRun(r.json.run.id);
  assert.equal(dest.received.length, 1);
  assert.equal(dest.received[0].headers['x-faultline-delivery-kind'], 'delayed');
  assert.equal(d.result.delay.requestedSeconds, 1);
  assert.ok(d.result.delay.waitedMs >= 900, `waited ${d.result.delay.waitedMs} ms`);
  assert.ok(d.result.delay.heldForMs >= d.result.delay.waitedMs);
  assert.ok(new Date(d.result.delay.forwardedAt) > new Date(d.result.delay.eventReceivedAt));

  const second = await run(eventId, { kind: 'delay', delaySeconds: 60 });
  const cancelled = await t.request('POST', `/api/projects/${pid}/scenario-runs/${second.json.run.id}/cancel`);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.run.status, 'cancelled');
  assert.equal((await t.request('POST', `/api/projects/${pid}/scenario-runs/${second.json.run.id}/cancel`)).status, 409);
  await sleep(100);
  assert.equal(dest.received.length, 1);
});

test('[fixture] dropped delivery sends nothing and is recorded as a deliberate drop', async () => {
  const { eventId } = await receive();
  const d = await runAndWait(eventId, { kind: 'drop' });
  assert.equal(dest.received.length, 0);
  assert.equal(d.attempts[0].outcome, 'dropped');
  assert.equal(d.attempts[0].httpStatus, null);
  assert.equal(d.result.dropped, true);
  assert.equal(d.result.requestsSent, 0);
  assert.ok(d.result.observations.some((o) => /deliberately withheld/.test(o)));
  assert.equal(await eventStatus(eventId), 'dropped');
  await runAndWait(eventId, { kind: 'forward' });
  assert.equal(await eventStatus(eventId), 'forwarded');
});

test('[fixture] replay resends the original event, labeled as a replay, without creating any payment', async () => {
  const { eventId, headers } = await receive();
  await runAndWait(eventId, { kind: 'forward' });
  const inboundBefore = t.db.prepare('SELECT COUNT(*) AS n FROM webhook_deliveries').get().n;
  const orderPosts = fx.count('POST', '/v2/checkout/orders');
  const capturePosts = fx.seen.filter((x) => /\/capture$/.test(x.url)).length;

  const d = await runAndWait(eventId, { kind: 'replay' });
  assert.equal(dest.received.length, 2);
  assert.equal(dest.received[1].headers['x-faultline-delivery-kind'], 'replay');
  assert.equal(dest.received[1].headers['x-faultline-injected'], 'true');
  assert.equal(dest.received[1].headers['paypal-transmission-id'], headers['paypal-transmission-id']);
  assert.equal(d.result.scenario, 'replay');

  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM webhook_deliveries').get().n, inboundBefore, 'a replay is not a new PayPal delivery');
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM paypal_orders').get().n, 0);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM paypal_captures').get().n, 0);
  assert.equal(fx.count('POST', '/v2/checkout/orders'), orderPosts);
  assert.equal(fx.seen.filter((x) => /\/capture$/.test(x.url)).length, capturePosts);
});

test('[fixture] real destination failures are recorded as they happen', async () => {
  const { eventId } = await receive();

  dest.state.handler = () => ({ status: 503, body: 'down' });
  let d = await runAndWait(eventId, { kind: 'forward' });
  assert.equal(d.attempts[0].outcome, 'http_error');
  assert.equal(d.attempts[0].httpStatus, 503);
  assert.equal(await eventStatus(eventId), 'forward_failed');

  dest.state.handler = () => ({ status: 302, headers: { location: 'http://127.0.0.1:1/elsewhere' } });
  d = await runAndWait(eventId, { kind: 'forward' });
  assert.equal(d.attempts[0].outcome, 'redirect_not_followed');
  assert.equal(d.attempts[0].httpStatus, 302);

  dest.state.handler = () => ({ status: 200, delayMs: 3000 });
  d = await runAndWait(eventId, { kind: 'forward' });
  assert.equal(d.attempts[0].outcome, 'timeout');
  assert.equal(d.attempts[0].httpStatus, null);
  assert.match(d.attempts[0].errorText, /did not answer/);
  assert.equal(d.run.status, 'completed');

  await dest.close();
  d = await runAndWait(eventId, { kind: 'forward' });
  assert.equal(d.attempts[0].outcome, 'network_error');
  assert.match(d.attempts[0].errorText, /ECONNREFUSED/);
  assert.equal(d.result.failedCount, 1);
  dest = await startFixtureDestination(); // so afterEach can close something
});

test('only verified events can be used, events stay in their project, and inputs are validated', async () => {
  const bad = await deliver(newEvent().raw, sig({ 'paypal-transmission-sig': 'FIXTURE-BAD-SIG' }));
  assert.equal(bad.status, 401);
  const r = await run(bad.json.eventId, { kind: 'forward' });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'event_not_verified');
  assert.equal(dest.received.length, 0);

  const { eventId } = await receive();
  const otherId = (await t.request('POST', '/api/projects', goodProject({ name: 'Other project' }))).json.project.id;
  assert.equal((await t.request('POST', `/api/projects/${otherId}/events/${eventId}/scenarios`, { kind: 'forward' })).status, 404);

  const cases = [
    [{ kind: 'explode' }, 'kind'], [{ kind: 'duplicate', count: 1 }, 'count'], [{ kind: 'duplicate', count: 11 }, 'count'],
    [{ kind: 'duplicate', count: 'many' }, 'count'], [{ kind: 'duplicate', count: 2, mode: 'sideways' }, 'mode'],
    [{ kind: 'delay', delaySeconds: 0 }, 'delaySeconds'], [{ kind: 'delay', delaySeconds: 3601 }, 'delaySeconds'], [{ kind: 'delay' }, 'delaySeconds'],
    [{ kind: 'forward', idempotencyKey: 'short' }, 'idempotencyKey'],
  ];
  for (const [body, field] of cases) {
    const x = await t.request('POST', `/api/projects/${pid}/events/${eventId}/scenarios`, body);
    assert.equal(x.status, 400, JSON.stringify(body));
    assert.ok(x.json.error.fields[field], field);
  }
  assert.equal((await t.request('POST', `/api/projects/${pid}/events/${eventId}/scenarios`, '[1]')).status, 400);
  assert.equal(dest.received.length, 0);
  assert.equal((await fetch(`${t.base}/api/projects/${pid}/scenario-runs`)).status, 401);
});

test('[fixture] the same idempotency key never runs a scenario twice', async () => {
  const { eventId } = await receive();
  const key = crypto.randomUUID();
  const a = await run(eventId, { kind: 'forward', idempotencyKey: key });
  const b = await run(eventId, { kind: 'forward', idempotencyKey: key });
  assert.equal(a.status, 202);
  assert.equal(b.status, 200);
  assert.equal(b.json.duplicate, true);
  assert.equal(b.json.run.id, a.json.run.id);
  await waitRun(a.json.run.id);
  await sleep(100);
  assert.equal(dest.received.length, 1);
});

test('[fixture] automatic mode forwards each new verified event once, and never PayPal\'s own redeliveries', async () => {
  assert.equal((await t.request('PATCH', `/api/projects/${pid}`, { forwardMode: 'sideways' })).status, 400);
  const p = await t.request('PATCH', `/api/projects/${pid}`, { forwardMode: 'auto' });
  assert.equal(p.json.project.forwardMode, 'auto');
  const e = newEvent();
  const headers = sig();
  const first = await deliver(e.raw, headers);
  assert.equal(first.status, 200);
  const until = Date.now() + 4000;
  while (dest.received.length < 1 && Date.now() < until) await sleep(40);
  assert.equal(dest.received.length, 1);
  assert.equal(dest.received[0].headers['x-faultline-delivery-kind'], 'original');
  const again = await deliver(e.raw, headers);
  assert.equal(again.json.redelivery, true);
  await sleep(300);
  assert.equal(dest.received.length, 1);
  const runs = (await t.request('GET', `/api/projects/${pid}/scenario-runs`)).json.runs;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].triggeredBy, 'auto');
  assert.equal(await eventStatus(first.json.eventId), 'forwarded');
});

test('forwarding to Faultline\'s own receiver is blocked instead of looping', async () => {
  await t.request('PATCH', `/api/projects/${pid}`, { webhookEndpointUrl: `http://127.0.0.1:3000/webhooks/paypal/${pid}` });
  const { eventId } = await receive();
  const d = await runAndWait(eventId, { kind: 'forward' });
  assert.equal(d.run.status, 'failed');
  assert.equal(d.attempts[0].outcome, 'blocked');
  assert.match(d.run.errorText, /own webhook receiver/);
  assert.equal(dest.received.length, 0);
});

test('a run keeps the destination it was created with', async () => {
  const { eventId } = await receive();
  const r = await run(eventId, { kind: 'delay', delaySeconds: 1 });
  await t.request('PATCH', `/api/projects/${pid}`, { webhookEndpointUrl: 'http://127.0.0.1:1/other' });
  const d = await waitRun(r.json.run.id);
  assert.equal(d.run.destination, dest.url);
  assert.equal(d.attempts[0].outcome, 'delivered');
});

test('[fixture] too many simultaneous scenarios are refused', async () => {
  dest.state.handler = () => ({ status: 200, delayMs: 600 });
  const { eventId } = await receive();
  const results = [];
  for (let i = 0; i < 7; i++) results.push(await run(eventId, { kind: 'forward' }));
  const refused = results.filter((r) => r.status === 409);
  assert.ok(refused.length >= 1);
  assert.equal(refused[0].json.error.code, 'too_many_runs');
});

test('after a restart a waiting delayed run still fires, and a run that was mid-flight is marked interrupted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faultline-'));
  const file = path.join(dir, 'restart.db');
  let a; let b;
  try {
    a = await startTestApp(fx.url, 1500, { dbFile: file });
    await a.login();
    const id = (await a.request('POST', '/api/projects', goodProject({ webhookEndpointUrl: dest.url, paypalWebhookId: 'FXWEBHOOK0001' }))).json.project.id;
    const e = newEvent();
    const ev = await (await fetch(`${a.base}/webhooks/paypal/${id}`, { method: 'POST', headers: sig(), body: e.raw })).json();
    const r = await a.request('POST', `/api/projects/${id}/events/${ev.eventId}/scenarios`, { kind: 'delay', delaySeconds: 1 });
    assert.equal(r.json.run.status, 'scheduled');
    // Pretend a second run was in flight when the process died.
    a.db.prepare(`INSERT INTO scenario_runs (id, project_id, event_id, kind, params_json, idempotency_key, status, planned_attempts, destination_url, created_at, started_at)
      VALUES ('stuck-run', ?, ?, 'forward', '{}', 'stuck-key-0001', 'running', 1, ?, ?, ?)`).run(id, ev.eventId, dest.url, new Date().toISOString(), new Date().toISOString());
    await a.close(); a = null;
    assert.equal(dest.received.length, 0);

    b = await startTestApp(fx.url, 1500, { dbFile: file });
    const until = Date.now() + 5000;
    while (dest.received.length < 1 && Date.now() < until) await sleep(50);
    assert.equal(dest.received.length, 1, 'the waiting run must fire after restart');
    assert.equal(dest.received[0].headers['x-faultline-delivery-kind'], 'delayed');
    const stuck = b.db.prepare("SELECT status, error_text FROM scenario_runs WHERE id = 'stuck-run'").get();
    assert.equal(stuck.status, 'failed');
    assert.match(stuck.error_text, /stopped while this scenario was running/);
  } finally {
    if (a) await a.close();
    if (b) await b.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('event detail lists its runs; deleting the project removes runs and attempts; no secrets are forwarded', async () => {
  const { eventId } = await receive();
  await runAndWait(eventId, { kind: 'forward' });
  const detail = (await t.request('GET', `/api/projects/${pid}/events/${eventId}`)).json;
  assert.equal(detail.runs.length, 1);
  assert.equal(detail.runs[0].kind, 'forward');
  const list = (await t.request('GET', `/api/projects/${pid}/scenario-runs?eventId=${eventId}`)).json.runs;
  assert.deepEqual(list.map((r) => [r.kind, r.status, r.requestsSent, r.statusCodes]), [['forward', 'completed', 1, [200]]]);

  const sentHeaders = JSON.stringify(dest.received[0].headers);
  assert.ok(!sentHeaders.includes(GOOD_SECRET));
  assert.ok(!/authorization|cookie/i.test(sentHeaders));
  const stored = JSON.stringify(t.db.prepare('SELECT * FROM forward_attempts').all());
  assert.ok(!stored.includes(GOOD_SECRET) && !/fixture-token-\d+/.test(stored));

  assert.equal((await t.request('DELETE', `/api/projects/${pid}`)).status, 204);
  for (const table of ['scenario_runs', 'forward_attempts']) assert.equal(t.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
});
