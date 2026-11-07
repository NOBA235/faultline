'use strict';
// FIXTURE tests. PayPal and "your application" are local stand-ins (support/fixtures.js). The application stand-in has
// switchable correct and buggy behavior. These tests show the checks pass a correct handler and catch each planted bug.
// They do not show how any real application behaves.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startFixturePayPal, startFixtureApp, startTestApp, goodProject } = require('../support/fixtures');

let fx; let app; let t; let pid;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
test.before(async () => { fx = await startFixturePayPal(); });
test.after(async () => { await fx.close(); });
test.afterEach(async () => { if (t) await t.close(); if (app) await app.close(); t = null; app = null; });

async function setup(appOpts = {}, { probe = true } = {}) {
  app = await startFixtureApp(appOpts);
  t = await startTestApp(fx.url, 1500);
  await t.login();
  pid = (await t.request('POST', '/api/projects', goodProject({ webhookEndpointUrl: app.webhookUrl, paypalWebhookId: 'FXWEBHOOK0001' }))).json.project.id;
  if (probe) assert.equal((await t.request('PATCH', `/api/projects/${pid}`, { probeUrl: app.probeUrl })).status, 200);
}
let n = 0;
const sigH = () => ({ 'content-type': 'application/json', 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-FIXTURE', 'paypal-transmission-id': `tx-${++n}`, 'paypal-transmission-sig': 'FIXTURE-VALID-SIG', 'paypal-transmission-time': '2026-11-05T10:00:05Z' });
const capEvent = (o = {}) => JSON.stringify({ id: o.id || `WH-CAP-${++n}`, event_type: 'PAYMENT.CAPTURE.COMPLETED', resource_type: 'capture', create_time: o.created || '2026-11-05T10:05:00Z', resource: { id: o.capId || 'FXCAP1', status: 'COMPLETED', amount: { value: o.amount || '10.10', currency_code: 'USD' }, custom_id: o.customId || 'x' } });
const apprEvent = (o = {}) => JSON.stringify({ id: o.id || `WH-APR-${++n}`, event_type: 'CHECKOUT.ORDER.APPROVED', resource_type: 'checkout-order', create_time: o.created || '2026-11-05T10:00:00Z', resource: { id: o.orderId || 'FXORD1', status: 'APPROVED', purchase_units: [{ custom_id: o.customId || 'x' }] } });
const refEvent = (o) => JSON.stringify({ id: o.id || `WH-REF-${++n}`, event_type: 'PAYMENT.CAPTURE.REFUNDED', resource_type: 'refund', create_time: o.created || '2026-11-05T10:10:00Z', resource: { id: o.refId, status: 'COMPLETED', amount: { value: o.amount, currency_code: 'USD' }, links: [{ rel: 'up', href: `https://api.sandbox.paypal.com/v2/payments/captures/${o.capId || 'FXCAP1'}` }] } });
const receive = async (raw) => {
  const r = await fetch(`${t.base}/webhooks/paypal/${pid}`, { method: 'POST', headers: sigH(), body: raw });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  return j.eventId;
};
const waitRun = async (runId, ms = 8000) => {
  const until = Date.now() + ms;
  for (;;) {
    const d = (await t.request('GET', `/api/projects/${pid}/scenario-runs/${runId}`)).json;
    if (['completed', 'failed', 'cancelled'].includes(d.run.status)) return d;
    if (Date.now() > until) throw new Error(`run did not finish: ${d.run.status}`);
    await sleep(40);
  }
};
const runScenario = async (eventId, body) => {
  const r = await t.request('POST', `/api/projects/${pid}/events/${eventId}/scenarios`, { idempotencyKey: crypto.randomUUID(), ...body });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  return waitRun(r.json.run.id);
};
const verdictOf = (d, id) => d.assertions.find((a) => a.id === id).verdict;
const newOrder = async () => (await t.request('POST', `/api/projects/${pid}/orders`, { amount: '10.10', currency: 'USD', idempotencyKey: crypto.randomUUID() })).json.order;

test('[fixture] a correctly idempotent application passes the application-state checks', async () => {
  await setup({ idempotent: true });
  const id = await receive(capEvent());
  const d = await runScenario(id, { kind: 'duplicate', count: 3 });
  assert.equal(app.state.requests, 3);
  assert.equal(verdictOf(d, 'idempotent_processing'), 'pass');
  assert.equal(verdictOf(d, 'accepted_delivery_processed'), 'pass');
  assert.equal(verdictOf(d, 'no_second_payment_in_app'), 'pass');
  assert.equal(verdictOf(d, 'valid_state_transition'), 'pass');
  assert.equal(verdictOf(d, 'injection_integrity'), 'pass');
  assert.equal(d.result.verdict.status, 'passed');
  const probeSnaps = d.snapshots.filter((s) => s.source === 'probe');
  assert.deepEqual(probeSnaps.map((s) => s.phase).sort(), ['after', 'before']);
  assert.equal(probeSnaps.find((s) => s.phase === 'before').data.processedCount, 0);
  assert.equal(probeSnaps.find((s) => s.phase === 'after').data.processedCount, 1);
  assert.equal(d.run.verdict, 'passed');
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM assertion_results WHERE run_id = ?').get(d.run.id).n, d.assertions.length);
});

test('[fixture] a handler that processes every copy FAILS the idempotency and second-payment checks', async () => {
  await setup({ idempotent: false });
  const id = await receive(capEvent());
  const d = await runScenario(id, { kind: 'duplicate', count: 3 });
  assert.equal(verdictOf(d, 'idempotent_processing'), 'fail');
  assert.match(d.assertions.find((a) => a.id === 'idempotent_processing').summary, /3 times/);
  assert.equal(verdictOf(d, 'no_second_payment_in_app'), 'fail');
  assert.equal(d.result.verdict.status, 'failed');
  assert.equal(app.state.records.get('FXCAP1'), 3);
});

test('[fixture] a handler that commits and then answers 500 is caught: the failed delivery still shows as processed', async () => {
  await setup({ idempotent: false, failMode: 'commit_then_500' });
  const id = await receive(capEvent());
  const d = await runScenario(id, { kind: 'forward' });
  assert.equal(d.result.statusCodes[0], 500);
  assert.equal(verdictOf(d, 'failed_delivery_not_processed'), 'fail');
  assert.equal(verdictOf(d, 'deliveries_accepted'), 'fail');
  assert.equal(d.result.verdict.status, 'failed');
});

test('[fixture] a handler that rolls back before failing is not blamed for processing, but the failed delivery is still reported', async () => {
  await setup({ idempotent: true, failMode: 'rollback_500' });
  const id = await receive(capEvent());
  const d = await runScenario(id, { kind: 'forward' });
  assert.equal(verdictOf(d, 'failed_delivery_not_processed'), 'pass');
  assert.equal(verdictOf(d, 'deliveries_accepted'), 'fail');
  assert.equal(d.result.verdict.status, 'failed');
  const retry = await runScenario(id, { kind: 'forward' });
  assert.equal(verdictOf(retry, 'deliveries_accepted'), 'pass');
  assert.equal(verdictOf(retry, 'accepted_delivery_processed'), 'pass');
  assert.equal(retry.result.verdict.status, 'passed');
});

test('[fixture] stale overwrite: a delayed older event regresses a naive handler, and a guarded handler holds', async () => {
  for (const [naive, expected] of [[true, 'fail'], [false, 'pass']]) {
    await setup({ idempotent: true, naiveStatus: naive });
    const order = await newOrder();
    const tag = `faultline:${order.id}`;
    const newer = await receive(capEvent({ customId: tag, created: '2026-11-05T10:05:00Z' }));
    const older = await receive(apprEvent({ customId: tag, created: '2026-11-05T10:00:00Z', orderId: order.paypalOrderId }));
    await runScenario(newer, { kind: 'forward' });
    assert.equal(app.state.status, 'COMPLETED');
    const d = await runScenario(older, { kind: 'delay', delaySeconds: 1 });
    assert.equal(verdictOf(d, 'no_stale_overwrite'), expected, `naive=${naive}`);
    assert.equal(verdictOf(d, 'valid_state_transition'), expected);
    assert.equal(d.result.verdict.status, expected === 'fail' ? 'failed' : 'passed');
    assert.equal(verdictOf(d, 'paypal_payment_unchanged'), 'pass', 'the PayPal-side fact is recorded separately');
    assert.ok(d.assertions.find((a) => a.id === 'no_stale_overwrite').evidence.some((e) => e.type === 'observed' && /delivered at/.test(e.text)));
    await t.close(); await app.close(); t = null; app = null;
  }
});

test('[fixture] refunds: PayPal-reported and application-recorded totals are compared with the captured amount', async () => {
  await setup({ idempotent: true, refundLimit: false });
  const cap = await receive(capEvent({ amount: '10.10' }));
  await runScenario(cap, { kind: 'forward' });
  const r1 = await receive(refEvent({ refId: 'REF1', amount: '6.00' }));
  const d1 = await runScenario(r1, { kind: 'forward' });
  assert.equal(verdictOf(d1, 'refund_events_within_captured'), 'pass');
  assert.equal(verdictOf(d1, 'app_refunds_within_captured'), 'pass');
  assert.equal(d1.result.verdict.status, 'passed');

  const r2 = await receive(refEvent({ refId: 'REF2', amount: '6.00' }));
  const d2 = await runScenario(r2, { kind: 'forward' });
  assert.equal(verdictOf(d2, 'refund_events_within_captured'), 'fail', 'verified events now add up to 12.00 against 10.10');
  assert.equal(verdictOf(d2, 'app_refunds_within_captured'), 'fail', 'the application recorded 12.00 refunded');
  assert.equal(d2.result.verdict.status, 'failed');

  await t.close(); await app.close();
  await setup({ idempotent: true, refundLimit: true });
  const c = await receive(capEvent({ amount: '10.10' }));
  await runScenario(c, { kind: 'forward' });
  await runScenario(await receive(refEvent({ refId: 'REF1', amount: '6.00' })), { kind: 'forward' });
  const d3 = await runScenario(await receive(refEvent({ refId: 'REF2', amount: '6.00' })), { kind: 'forward' });
  assert.equal(verdictOf(d3, 'app_refunds_within_captured'), 'pass', 'a handler that refuses over-refunds passes');
  assert.equal(app.state.refunded, 600);
});

test('[fixture] without a probe the same correct application is "inconclusive", never "passed"', async () => {
  await setup({ idempotent: true }, { probe: false });
  const id = await receive(capEvent());
  const d = await runScenario(id, { kind: 'duplicate', count: 3 });
  assert.equal(d.result.verdict.status, 'inconclusive');
  assert.equal(verdictOf(d, 'idempotent_processing'), 'not_evaluable');
  assert.match(d.assertions.find((a) => a.id === 'idempotent_processing').summary, /No state probe is configured/);
  assert.equal(verdictOf(d, 'deliveries_accepted'), 'pass');
  assert.ok(d.result.risks.some((x) => /3 copies/.test(x)));
  assert.equal(d.snapshots.filter((s) => s.source === 'probe').length, 0);
  assert.equal(app.state.probeRequests.length, 0);
});

test('[fixture] probe problems become "not evaluable" with the real reason, and the run still completes', async () => {
  await setup({ idempotent: true });
  const id = await receive(capEvent());
  for (const [mode, text] of [['down', /HTTP 500/], ['notjson', /did not answer with JSON/], ['invalid', /expected format/]]) {
    app.state.probeMode = mode;
    const d = await runScenario(id, { kind: 'forward' });
    assert.equal(d.run.status, 'completed');
    assert.equal(verdictOf(d, 'idempotent_processing'), 'not_evaluable', mode);
    assert.match(d.assertions.find((a) => a.id === 'idempotent_processing').summary, text);
    assert.equal(d.result.verdict.status, 'inconclusive');
  }
  app.state.probeMode = 'ok';
  app.state.omit = ['payment_records'];
  const d = await runScenario(id, { kind: 'forward' });
  assert.equal(verdictOf(d, 'no_second_payment_in_app'), 'not_evaluable');
  assert.match(d.assertions.find((a) => a.id === 'no_second_payment_in_app').summary, /payment_records/);
});

test('[fixture] the probe is asked about the right event, before and after, and a closed probe is reported', async () => {
  await setup({ idempotent: true });
  const raw = capEvent({ id: 'WH-PROBE-ME', capId: 'FXCAP77' });
  const id = await receive(raw);
  await runScenario(id, { kind: 'forward' });
  assert.equal(app.state.probeRequests.length, 2);
  assert.equal(app.state.probeRequests[0].query.event_id, 'WH-PROBE-ME');
  assert.equal(app.state.probeRequests[0].query.resource_id, 'FXCAP77');
  assert.equal(app.state.probeRequests[0].query.event_type, 'PAYMENT.CAPTURE.COMPLETED');
  assert.equal(app.state.probeRequests[0].headers['x-faultline-probe'], '1');
  const dead = await startFixtureApp();
  const deadUrl = dead.probeUrl;
  await dead.close();
  await t.request('PATCH', `/api/projects/${pid}`, { probeUrl: deadUrl });
  const d = await runScenario(id, { kind: 'forward' });
  assert.match(d.assertions.find((a) => a.id === 'idempotent_processing').summary, /ECONNREFUSED/);
  assert.equal((await t.request('PATCH', `/api/projects/${pid}`, { probeUrl: 'ftp://nope' })).status, 400);
  assert.equal((await t.request('PATCH', `/api/projects/${pid}`, { probeUrl: '' })).json.project.probeUrl, null);
});

test('[fixture] a dropped event is checked for state changes, and its blind spot is stated as a risk', async () => {
  await setup({ idempotent: true });
  const first = await receive(capEvent());
  await runScenario(first, { kind: 'forward' });
  const second = await receive(capEvent());
  const d = await runScenario(second, { kind: 'drop' });
  assert.equal(app.state.requests, 1, 'the dropped event was never sent');
  assert.equal(verdictOf(d, 'valid_state_transition'), 'pass');
  assert.equal(verdictOf(d, 'deliveries_accepted'), 'not_applicable');
  assert.ok(d.result.risks.some((x) => /withheld/.test(x)));
});

test('a destination that is blocked yields an inconclusive verdict that says why', async () => {
  await setup({ idempotent: true });
  await t.request('PATCH', `/api/projects/${pid}`, { webhookEndpointUrl: `http://127.0.0.1:3000/webhooks/paypal/${pid}` });
  const d = await runScenario(await receive(capEvent()), { kind: 'forward' });
  assert.equal(d.run.status, 'failed');
  assert.equal(d.result.verdict.status, 'inconclusive');
  assert.match(d.result.verdict.message, /could not run/);
  assert.equal(d.assertions.length, 0);
});
