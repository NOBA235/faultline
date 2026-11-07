'use strict';
// FIXTURE integration tests for the AI Test Engineer API routes (src/ai.js).
// PayPal and the developer's application are local stand-in servers (support/fixtures.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startFixturePayPal, startFixtureApp, startTestApp, goodProject, GOOD_SECRET } = require('../support/fixtures');

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
const sigH = (over = {}) => ({
  'content-type': 'application/json',
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-FIXTURE',
  'paypal-transmission-id': `aitx-${++n}`,
  'paypal-transmission-sig': 'FIXTURE-VALID-SIG',
  'paypal-transmission-time': '2026-11-05T10:00:05Z',
  ...over,
});
const capEvent = (o = {}) => JSON.stringify({
  id: o.id || `WH-AI-${++n}`,
  event_type: 'PAYMENT.CAPTURE.COMPLETED',
  resource_type: 'capture',
  create_time: o.created || '2026-11-05T10:05:00Z',
  resource: { id: o.capId || 'FXCAP-AI-1', status: 'COMPLETED', amount: { value: o.amount || '10.10', currency_code: 'USD' } },
});
const receive = async (raw = capEvent(), headers = sigH()) => {
  const r = await fetch(`${t.base}/webhooks/paypal/${pid}`, { method: 'POST', headers, body: raw });
  const j = await r.json();
  return { status: r.status, eventId: j.eventId };
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

test('[fixture] natural-language test plan is validated, saved, and executes a real duplicate scenario against a verified event', async () => {
  await setup({ idempotent: false });
  const { eventId } = await receive(capEvent({ id: 'WH-PLAN-100' }));

  const created = await t.request('POST', `/api/projects/${pid}/ai/plans`, {
    prompt: 'Test whether my application processes the same completed payment webhook twice.',
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const plan = created.json.plan;
  assert.equal(plan.validationStatus, 'valid');
  assert.equal(plan.matchedEventId, eventId);
  assert.equal(plan.spec.scenario.kind, 'duplicate');
  assert.equal(plan.spec.scenario.params.count, 2);
  assert.equal(plan.spec.plannedAttempts, 2);
  assert.equal(plan.spec.financialOperationsAllowed, false);

  const listed = await t.request('GET', `/api/projects/${pid}/ai/plans`);
  assert.equal(listed.status, 200);
  assert.equal(listed.json.plans.length, 1);
  assert.equal(listed.json.plans[0].id, plan.id);

  const exec = await t.request('POST', `/api/projects/${pid}/ai/plans/${plan.id}/execute`, {});
  assert.equal(exec.status, 202, JSON.stringify(exec.json));
  assert.equal(exec.json.run.triggeredBy, 'ai_plan');
  assert.equal(exec.json.plan.executedRunId, exec.json.run.id);

  const runDetail = await waitRun(exec.json.run.id);
  assert.equal(app.state.requests, 2);
  assert.equal(runDetail.run.verdict, 'failed');
  assert.equal(runDetail.assertions.find((a) => a.id === 'idempotent_processing').verdict, 'fail');
});

test('[fixture] executing a test plan refuses unverified events, missing events, and tampered specifications', async () => {
  await setup({ idempotent: true });
  const planRes = await t.request('POST', `/api/projects/${pid}/ai/plans`, {
    prompt: 'Replay the completed payment webhook to check idempotency.',
  });
  assert.equal(planRes.status, 201);
  const planId = planRes.json.plan.id;

  // No verified event exists yet -> 400 missing_source_event
  const noEv = await t.request('POST', `/api/projects/${pid}/ai/plans/${planId}/execute`, {});
  assert.equal(noEv.status, 400);
  assert.equal(noEv.json.error.code, 'missing_source_event');

  // Unverified/forged event -> 409 event_not_verified
  const forged = await receive(capEvent(), sigH({ 'paypal-transmission-sig': 'BAD-SIG' }));
  assert.equal(forged.status, 401);
  const badExec = await t.request('POST', `/api/projects/${pid}/ai/plans/${planId}/execute`, { eventId: forged.eventId });
  assert.equal(badExec.status, 409);
  assert.equal(badExec.json.error.code, 'event_not_verified');

  // Tamper with the stored spec in the database so it violates validation -> 422 invalid_plan_spec
  const goodEv = await receive();
  t.db.prepare('UPDATE ai_test_plans SET spec_json = ? WHERE id = ?').run(
    JSON.stringify({ objective: 'Tampered', scenario: { kind: 'duplicate', params: { count: 99 } }, plannedAttempts: 99, financialOperationsAllowed: true }),
    planId
  );
  const tampered = await t.request('POST', `/api/projects/${pid}/ai/plans/${planId}/execute`, { eventId: goodEv.eventId });
  assert.equal(tampered.status, 422);
  assert.equal(tampered.json.error.code, 'invalid_plan_spec');
  assert.equal(app.state.requests, 0, 'nothing was sent to the application');
});

test('[fixture] AI failure analysis explains real failure evidence, persists to DB, and cannot override deterministic verdicts', async () => {
  await setup({ idempotent: false, failMode: 'commit_then_500' });
  const { eventId } = await receive(capEvent({ id: 'WH-FAIL-500' }));

  const started = await t.request('POST', `/api/projects/${pid}/events/${eventId}/scenarios`, {
    kind: 'forward',
    idempotencyKey: crypto.randomUUID(),
  });
  const d = await waitRun(started.json.run.id);
  assert.equal(d.run.verdict, 'failed');

  const res = await t.request('POST', `/api/projects/${pid}/scenario-runs/${d.run.id}/analyze`);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const a = res.json.analysis;

  assert.equal(a.runId, d.run.id);
  assert.equal(a.deterministicVerdict.status, 'failed');
  assert.equal(a.deterministicVerdict.canOverride, false);
  assert.match(a.whatActuallyHappened, /HTTP 500/);
  assert.match(a.whatActuallyHappened, /processed_count changing from 0 to 1/);
  assert.match(a.whereFailureOccurred, /transaction boundary/i);
  assert.ok(a.observations.some((o) => /HTTP 500/.test(o)));
  assert.ok(a.observations.some((o) => /A failed delivery is not reported as processed/.test(o)));

  // Retrieving the run detail now includes aiAnalysis, and deterministic verdict in scenario_runs is unchanged:
  const fetched = (await t.request('GET', `/api/projects/${pid}/scenario-runs/${d.run.id}`)).json;
  assert.equal(fetched.run.verdict, 'failed');
  assert.ok(fetched.aiAnalysis);
  assert.equal(fetched.aiAnalysis.id, a.id);

  // Unfinished (scheduled) run cannot be analyzed before completion:
  const sched = await t.request('POST', `/api/projects/${pid}/events/${eventId}/scenarios`, {
    kind: 'delay',
    delaySeconds: 30,
    idempotencyKey: crypto.randomUUID(),
  });
  const early = await t.request('POST', `/api/projects/${pid}/scenario-runs/${sched.json.run.id}/analyze`);
  assert.equal(early.status, 409);
  assert.equal(early.json.error.code, 'run_not_finished');
  await t.request('POST', `/api/projects/${pid}/scenario-runs/${sched.json.run.id}/cancel`);
});

test('[fixture] AI suggestions reflect actual stored events and runs, and secrets never appear in any AI output', async () => {
  await setup({ idempotent: true });

  // Before any verified events arrive:
  const emptySug = (await t.request('GET', `/api/projects/${pid}/ai/suggestions`)).json;
  assert.equal(emptySug.insufficientEvidence, true);
  assert.equal(emptySug.suggestions.length, 0);

  // Receive a verified event:
  const { eventId } = await receive(capEvent({ id: 'WH-SUG-77' }));
  const sug = (await t.request('GET', `/api/projects/${pid}/ai/suggestions`)).json;
  assert.equal(sug.insufficientEvidence, false);
  assert.ok(sug.suggestions.length >= 2);
  assert.ok(sug.suggestions.every((s) => s.eventId === eventId && s.paypalEventId === 'WH-SUG-77'));

  // Auth and project isolation checks:
  assert.equal((await fetch(`${t.base}/api/projects/${pid}/ai/suggestions`)).status, 401);
  assert.equal((await fetch(`${t.base}/api/projects/${pid}/ai/plans`)).status, 401);
  const otherPid = (await t.request('POST', '/api/projects', goodProject({ name: 'Second project' }))).json.project.id;
  const plan = (await t.request('POST', `/api/projects/${pid}/ai/plans`, { prompt: 'Drop the completed payment webhook' })).json.plan;
  assert.equal((await t.request('GET', `/api/projects/${otherPid}/ai/plans/${plan.id}`)).status, 404);

  // Verify no secrets or tokens appear anywhere in AI tables or responses:
  const dump = JSON.stringify({
    sug,
    plan,
    dbPlans: t.db.prepare('SELECT * FROM ai_test_plans').all(),
    dbAnalyses: t.db.prepare('SELECT * FROM ai_run_analyses').all(),
  });
  assert.ok(!dump.includes(GOOD_SECRET), 'PayPal secret must never appear in AI data');
  assert.ok(!/fixture-token-\d+/.test(dump), 'OAuth access token must never appear in AI data');
  assert.ok(!dump.includes(t.config.encryptionKey), 'ENCRYPTION_KEY must never appear in AI data');
  assert.ok(!dump.includes(t.config.sessionSecret), 'SESSION_SECRET must never appear in AI data');

  // Deleting the project cascades and removes AI plans and analyses:
  await t.request('DELETE', `/api/projects/${pid}`);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM ai_test_plans WHERE project_id = ?').get(pid).n, 0);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM ai_run_analyses WHERE project_id = ?').get(pid).n, 0);
});
