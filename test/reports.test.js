'use strict';
// FIXTURE tests (PayPal and the application are local stand-ins). They check that overview numbers, findings and exported
// reports match what is actually stored, and that nothing sensitive or invented appears in them.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startFixturePayPal, startFixtureApp, startTestApp, goodProject, GOOD_SECRET } = require('../support/fixtures');

let fx; let app; let t; let pid;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
test.before(async () => { fx = await startFixturePayPal(); });
test.after(async () => { await fx.close(); });
test.afterEach(async () => { if (t) await t.close(); if (app) await app.close(); t = null; app = null; });

async function setup(appOpts, { probe = true } = {}) {
  app = await startFixtureApp(appOpts);
  t = await startTestApp(fx.url, 1500);
  await t.login();
  pid = (await t.request('POST', '/api/projects', goodProject({ webhookEndpointUrl: app.webhookUrl, paypalWebhookId: 'FXWEBHOOK0001' }))).json.project.id;
  if (probe) await t.request('PATCH', `/api/projects/${pid}`, { probeUrl: app.probeUrl });
}
let n = 0;
const sigH = () => ({ 'content-type': 'application/json', 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-FIXTURE', 'paypal-transmission-id': `rtx-${++n}`, 'paypal-transmission-sig': 'FIXTURE-VALID-SIG', 'paypal-transmission-time': '2026-11-05T10:00:05Z' });
const capEvent = () => JSON.stringify({ id: `WH-RPT-${++n}`, event_type: 'PAYMENT.CAPTURE.COMPLETED', resource_type: 'capture', create_time: '2026-11-05T10:05:00Z', resource: { id: 'FXCAP1', status: 'COMPLETED', amount: { value: '10.10', currency_code: 'USD' } } });
const receive = async () => (await (await fetch(`${t.base}/webhooks/paypal/${pid}`, { method: 'POST', headers: sigH(), body: capEvent() })).json()).eventId;
const waitRun = async (runId) => {
  const until = Date.now() + 8000;
  for (;;) {
    const d = (await t.request('GET', `/api/projects/${pid}/scenario-runs/${runId}`)).json;
    if (['completed', 'failed', 'cancelled'].includes(d.run.status)) return d;
    if (Date.now() > until) throw new Error('run did not finish');
    await sleep(40);
  }
};
const run = async (eventId, body) => {
  const r = await t.request('POST', `/api/projects/${pid}/events/${eventId}/scenarios`, { idempotencyKey: crypto.randomUUID(), ...body });
  return waitRun(r.json.run.id);
};
const count = (table, where = '') => t.db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get().n;

test('overview of an empty project contains only zeros, nothing invented', async () => {
  await setup({ idempotent: true });
  const o = (await t.request('GET', `/api/projects/${pid}/overview`)).json;
  assert.equal(o.orders.total, 0);
  assert.equal(o.events.total, 0);
  assert.equal(o.forwardAttempts.total, 0);
  assert.equal(o.runs.total, 0);
  assert.equal(o.failedChecks, 0);
  assert.deepEqual(o.recentRuns, []);
  assert.deepEqual(o.runs.byVerdict, {});
  assert.equal(o.probeConfigured, true);
  assert.equal((await fetch(`${t.base}/api/projects/${pid}/overview`)).status, 401);
});

test('[fixture] overview numbers equal what is stored', async () => {
  await setup({ idempotent: false });
  await t.request('POST', `/api/projects/${pid}/orders`, { amount: '5.00', idempotencyKey: crypto.randomUUID() });
  const e1 = await receive(); const e2 = await receive();
  await run(e1, { kind: 'duplicate', count: 3 });
  await run(e2, { kind: 'drop' });
  const o = (await t.request('GET', `/api/projects/${pid}/overview`)).json;
  assert.equal(o.orders.total, count('paypal_orders'));
  assert.equal(o.events.total, 2);
  assert.equal(o.events.byVerification.verified, 2);
  assert.equal(o.inboundDeliveries.total, count('webhook_deliveries'));
  assert.equal(o.forwardAttempts.total, 4);
  assert.deepEqual(o.forwardAttempts.byOutcome, { delivered: 3, dropped: 1 });
  assert.equal(o.runs.total, 2);
  assert.equal(o.runs.byStatus.completed, 2);
  assert.equal(o.failedChecks, count('assertion_results', "WHERE verdict = 'fail'"));
  assert.ok(o.failedChecks >= 2);
  assert.equal(o.paypalCalls, count('paypal_api_calls'));
  assert.equal(o.recentRuns.length, 2);
  assert.equal(o.recentRuns[0].label, 'Dropped delivery');
});

test('[fixture] findings list failing checks first, with static guidance and the last failing run', async () => {
  await setup({ idempotent: false });
  const d = await run(await receive(), { kind: 'duplicate', count: 3 });
  const f = (await t.request('GET', `/api/projects/${pid}/findings`)).json;
  const idem = f.findings.find((x) => x.checkId === 'idempotent_processing');
  assert.equal(idem.kind, 'failing');
  assert.equal(idem.failed, 1);
  assert.equal(idem.lastFailedRunId, d.run.id);
  assert.match(idem.guidance, /unique constraint/);
  assert.match(f.guidanceNote, /not generated from your code/);
  assert.equal(f.findings[0].kind, 'failing');
  assert.ok(!f.findings.some((x) => x.checkId === 'valid_state_transition'), 'a passing check is not a finding');
});

test('[fixture] checks that could never be evaluated are reported as such, not as passes', async () => {
  await setup({ idempotent: true }, { probe: false });
  await run(await receive(), { kind: 'forward' });
  const f = (await t.request('GET', `/api/projects/${pid}/findings`)).json.findings;
  const idem = f.find((x) => x.checkId === 'idempotent_processing');
  assert.equal(idem.kind, 'never_evaluated');
  assert.equal(idem.passed, 0);
  assert.ok(f.every((x) => x.kind === 'never_evaluated'));
});

test('[fixture] the JSON report matches the stored runs and carries the honesty notices', async () => {
  await setup({ idempotent: false });
  const bad = await run(await receive(), { kind: 'duplicate', count: 2 });
  await t.close(); await app.close();
  await setup({ idempotent: true });
  const good = await run(await receive(), { kind: 'forward' });

  const r = await t.request('GET', `/api/projects/${pid}/report?format=json`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /^attachment; filename="faultline-report-checkout-service-\d{4}-\d{2}-\d{2}\.json"$/);
  const rep = JSON.parse(r.text);
  assert.equal(rep.summary.runs, 1);
  assert.equal(rep.summary.passed, 1);
  assert.equal(rep.runs[0].run.id, good.run.id);
  assert.equal(rep.runs[0].verdict, 'passed');
  assert.ok(rep.runs[0].attempts.length === 1 && rep.runs[0].assertions.length > 5 && rep.runs[0].snapshots.length >= 2);
  assert.ok(rep.notices.some((x) => /No AI was used/.test(x)));
  assert.ok(rep.notices.some((x) => /not new PayPal events and not new payments/.test(x)));
  assert.ok(rep.notices.some((x) => /never counted as passes/.test(x)));
  assert.ok(!r.text.includes(GOOD_SECRET) && !/fixture-token-\d+/.test(r.text), 'no secret or token in an export');
  assert.ok(bad.run.id !== good.run.id);
  assert.equal((await t.request('GET', `/api/projects/${pid}/report?format=json&verdict=failed`)).json.summary.runs, 0);
  assert.equal((await t.request('GET', `/api/projects/${pid}/report?runId=${good.run.id}`)).json.summary.runs, 1);
  assert.equal((await t.request('GET', `/api/projects/${pid}/report?format=xml`)).status, 400);
  assert.equal((await fetch(`${t.base}/api/projects/${pid}/report`)).status, 401);
});

test('[fixture] the Markdown report is readable and shows evidence for every failed check', async () => {
  await setup({ idempotent: false });
  await run(await receive(), { kind: 'duplicate', count: 3 });
  const r = await t.request('GET', `/api/projects/${pid}/report?format=md`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/markdown/);
  assert.match(r.headers.get('content-disposition'), /\.md"$/);
  assert.match(r.text, /^# Faultline test report: Checkout service/);
  assert.match(r.text, /## How to read this report/);
  assert.match(r.text, /Verdict: \*\*Failed\*\*/);
  assert.match(r.text, /\| The same event is processed at most once \| invariant \| fail \|/);
  assert.match(r.text, /Evidence for failed check "The same event is processed at most once":\n- \(observed\) 3 of 3 delivery\(ies\) were accepted\.\n- \(probe\) processed_count was 0 before and 3 after\./);
  assert.match(r.text, /### The same event is processed at most once\n\nFailed in 1 of/);
  assert.match(r.text, /General guidance: Record each PayPal event ID/);
  assert.ok(!r.text.includes(GOOD_SECRET));
});

test('[fixture] the probe tester shows the real answer, or the real problem, and saves nothing', async () => {
  await setup({ idempotent: true });
  const ok = await t.request('POST', `/api/projects/${pid}/probe/test`, {});
  assert.equal(ok.status, 200);
  assert.equal(ok.json.result.outcome, 'ok');
  assert.equal(ok.json.result.data.processedCount, 0);
  assert.equal(app.state.probeRequests.at(-1).query.event_id, 'faultline-probe-test');
  const id = await receive();
  const stored = await t.request('POST', `/api/projects/${pid}/probe/test`, { eventId: id });
  assert.match(app.state.probeRequests.at(-1).query.event_id, /^WH-RPT-/);
  assert.equal(stored.json.askedAbout, 'a stored event');
  app.state.probeMode = 'down';
  const down = await t.request('POST', `/api/projects/${pid}/probe/test`, {});
  assert.equal(down.json.result.outcome, 'error');
  assert.match(down.json.result.errorText, /HTTP 500/);
  assert.equal(count('run_snapshots'), 0);
  await t.request('PATCH', `/api/projects/${pid}`, { probeUrl: '' });
  const none = await t.request('POST', `/api/projects/${pid}/probe/test`, {});
  assert.equal(none.status, 400);
  assert.equal(none.json.error.code, 'probe_not_configured');
});

test('deleting a project removes its checks and snapshots', async () => {
  await setup({ idempotent: true });
  await run(await receive(), { kind: 'forward' });
  assert.ok(count('assertion_results') > 0 && count('run_snapshots') > 0);
  await t.request('DELETE', `/api/projects/${pid}`);
  assert.equal(count('assertion_results') + count('run_snapshots'), 0);
});
