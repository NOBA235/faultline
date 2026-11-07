'use strict';
// FIXTURE tests. The webhook bodies below are made up by this test file and PayPal's verify endpoint is replaced by the
// local stand-in in support/fixtures.js. They prove Faultline's handling (storage, status labels, idempotency, byte-exact
// pass-through to the verify call). They do NOT prove that a real PayPal signature verifies. Only a genuine Sandbox
// delivery can do that.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startFixturePayPal, startTestApp, goodProject, GOOD_SECRET } = require('../support/fixtures');

let fx;
let t;
let pid;
const VERIFY = '/v1/notifications/verify-webhook-signature';

test.before(async () => { fx = await startFixturePayPal(); });
test.after(async () => { await fx.close(); });
test.beforeEach(async () => {
  t = await startTestApp(fx.url, 1500);
  await t.login();
  pid = (await t.request('POST', '/api/projects', goodProject({ paypalWebhookId: 'FXWEBHOOK0001' }))).json.project.id;
});
test.afterEach(async () => { await t.close(); });

// Deliberately awkward formatting (spacing, key order, 1.10, unicode) to prove the raw bytes are passed through untouched.
const eventBody = ({ id = 'WH-FIXTURE-0001', customId = 'none', resourceId = 'FXCAPTURE0001', type = 'PAYMENT.CAPTURE.COMPLETED' } = {}) =>
  `{ "resource" : {"id":"${resourceId}", "custom_id":"${customId}", "amount":{"value":"10.10","currency_code":"USD"}, "note":"caf\u00e9 \u2713", "ratio":1.10 },\n  "id":"${id}", "event_type":"${type}",\n  "resource_type":"capture", "create_time":"2026-11-05T10:00:00.000Z", "event_version":"1.0", "links":[] }`;
const sigHeaders = (over = {}) => ({
  'content-type': 'application/json',
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-FIXTURE',
  'paypal-transmission-id': 'fixture-tx-0001',
  'paypal-transmission-sig': 'FIXTURE-VALID-SIG',
  'paypal-transmission-time': '2026-11-05T10:00:05Z',
  ...over,
});
const deliver = async (raw, headers = sigHeaders(), project = pid) => {
  const res = await fetch(`${t.base}/webhooks/paypal/${project}`, { method: 'POST', headers, body: raw });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json };
};
const events = (q = '') => t.request('GET', `/api/projects/${pid}/events${q}`);
const rows = (table) => t.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

test('the project exposes its receiver URL and stores a validated PayPal Webhook ID', async () => {
  const p = (await t.request('GET', `/api/projects/${pid}`)).json.project;
  assert.equal(p.webhook.receiverUrl, `http://127.0.0.1:3000/webhooks/paypal/${pid}`);
  assert.equal(p.webhook.paypalWebhookId, 'FXWEBHOOK0001');
  assert.equal(p.webhook.receiverIsHttps, false);
  assert.equal((await t.request('PATCH', `/api/projects/${pid}`, { paypalWebhookId: 'has spaces' })).status, 400);
  const cleared = await t.request('PATCH', `/api/projects/${pid}`, { paypalWebhookId: '' });
  assert.equal(cleared.json.project.webhook.paypalWebhookId, null);
  const set = await t.request('PATCH', `/api/projects/${pid}`, { paypalWebhookId: 'FXWEBHOOK0001' });
  assert.equal(set.json.project.webhook.paypalWebhookId, 'FXWEBHOOK0001');
});

test('[fixture] a verified delivery is stored byte-for-byte and linked to the Faultline order it belongs to', async () => {
  const order = (await t.request('POST', `/api/projects/${pid}/orders`, { amount: '10.10', currency: 'USD', idempotencyKey: crypto.randomUUID() })).json.order;
  const raw = eventBody({ customId: `faultline:${order.id}` });
  const r = await deliver(raw);
  assert.equal(r.status, 200);
  assert.equal(r.json.verification, 'verified');
  assert.equal(r.json.redelivery, false);

  // PayPal's verify endpoint received the event text exactly as delivered, not re-serialized.
  const sent = fx.seen.filter((x) => x.url === VERIFY).at(-1);
  assert.ok(sent.body.includes(`"webhook_event":${raw}`), 'raw event text must be embedded unchanged');
  assert.equal(sent.json.webhook_id, 'FXWEBHOOK0001');
  assert.equal(sent.json.transmission_id, 'fixture-tx-0001');
  assert.equal(sent.json.cert_url, 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-FIXTURE');
  assert.match(sent.headers.authorization, /^Bearer fixture-token-/);

  const list = (await events()).json;
  assert.equal(list.total, 1);
  const detail = (await t.request('GET', `/api/projects/${pid}/events/${list.events[0].id}`)).json;
  assert.equal(detail.rawText, raw);
  assert.ok(t.db.prepare('SELECT raw_body FROM webhook_events').get().raw_body.equals(Buffer.from(raw, 'utf8')));
  assert.equal(detail.event.paypalEventId, 'WH-FIXTURE-0001');
  assert.equal(detail.event.eventType, 'PAYMENT.CAPTURE.COMPLETED');
  assert.equal(detail.event.resourceId, 'FXCAPTURE0001');
  assert.equal(detail.event.originalDeliveryTime, '2026-11-05T10:00:05Z');
  assert.equal(detail.event.paypalEventCreatedAt, '2026-11-05T10:00:00.000Z');
  assert.ok(detail.event.receivedAt);
  assert.equal(detail.event.verification.status, 'verified');
  assert.equal(detail.event.processingStatus, 'stored');
  assert.equal(detail.event.origin, 'faultline_order');
  assert.equal(detail.event.relatedOrder.id, order.id);
  assert.equal(detail.headers['paypal-transmission-sig'], 'FIXTURE-VALID-SIG');
  assert.equal(detail.payload.resource.id, 'FXCAPTURE0001');
  assert.equal(detail.deliveries.length, 1);
});

test('[fixture] an event with no matching Faultline order is stored as unlinked, not guessed', async () => {
  await deliver(eventBody({ customId: 'someone-elses-order' }));
  const e = (await events()).json.events[0];
  assert.equal(e.origin, 'unlinked');
  assert.equal(e.relatedOrder, null);
});

test('[fixture] the same verified event delivered again is recorded as a redelivery, not a second event', async () => {
  const raw = eventBody();
  assert.equal((await deliver(raw)).json.redelivery, false);
  const again = await deliver(raw);
  assert.equal(again.status, 200);
  assert.equal(again.json.redelivery, true);
  assert.equal(rows('webhook_events'), 1);
  const list = (await events()).json;
  assert.equal(list.events[0].deliveryCount, 2);
  const detail = (await t.request('GET', `/api/projects/${pid}/events/${list.events[0].id}`)).json;
  assert.deepEqual(detail.deliveries.map((d) => d.isRedelivery), [false, true]);
});

test('[fixture] two identical deliveries arriving at the same moment still make one event', async () => {
  const raw = eventBody({ id: 'WH-FIXTURE-RACE' });
  const [a, b] = await Promise.all([deliver(raw), deliver(raw)]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.equal(rows('webhook_events'), 1);
  assert.equal(rows('webhook_deliveries'), 2);
});

test('[fixture] a bad signature is never labeled verified and gets a 401', async () => {
  const r = await deliver(eventBody(), sigHeaders({ 'paypal-transmission-sig': 'FIXTURE-BAD-SIG' }));
  assert.equal(r.status, 401);
  assert.equal(r.json.verification, 'failed');
  const e = (await events()).json.events[0];
  assert.equal(e.verification.status, 'failed');
  assert.equal(e.verification.code, 'signature_invalid');
  assert.equal((await events('?status=verified')).json.total, 0);
  assert.equal((await events('?status=failed')).json.total, 1);
});

test('[fixture] a forged copy of a verified event ID cannot alter or replace the verified event', async () => {
  await deliver(eventBody());
  const forged = await deliver(eventBody(), sigHeaders({ 'paypal-transmission-sig': 'FIXTURE-BAD-SIG' }));
  assert.equal(forged.status, 401);
  assert.equal(rows('webhook_events'), 2);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM webhook_events WHERE verification_status = 'verified'").get().n, 1);
});

test('requests without PayPal signature headers, or with a non-PayPal certificate URL, are rejected without asking PayPal', async () => {
  const before = fx.count('POST', VERIFY);
  const noHeaders = await deliver(eventBody(), { 'content-type': 'application/json' });
  assert.equal(noHeaders.status, 401);
  const evilCert = await deliver(eventBody({ id: 'WH-EVIL' }), sigHeaders({ 'paypal-cert-url': 'https://evil.example/paypal.com/cert' }));
  assert.equal(evilCert.status, 401);
  const httpCert = await deliver(eventBody({ id: 'WH-HTTP' }), sigHeaders({ 'paypal-cert-url': 'http://api.sandbox.paypal.com/cert' }));
  assert.equal(httpCert.status, 401);
  assert.equal(fx.count('POST', VERIFY), before);
  const codes = (await events()).json.events.map((e) => e.verification.code).sort();
  assert.deepEqual(codes, ['cert_url_not_paypal', 'cert_url_not_paypal', 'missing_signature_headers']);
});

test('[fixture] with no Webhook ID the delivery is stored as unverified (503), and can be re-verified once the ID is added', async () => {
  await t.request('PATCH', `/api/projects/${pid}`, { paypalWebhookId: '' });
  const before = fx.count('POST', VERIFY);
  const r = await deliver(eventBody());
  assert.equal(r.status, 503);
  assert.equal(r.json.verification, 'unverified');
  assert.equal(fx.count('POST', VERIFY), before);
  const e = (await events()).json.events[0];
  assert.equal(e.verification.status, 'unverified');
  assert.equal(e.verification.code, 'webhook_not_configured');

  await t.request('PATCH', `/api/projects/${pid}`, { paypalWebhookId: 'FXWEBHOOK0001' });
  const re = await t.request('POST', `/api/projects/${pid}/events/${e.id}/reverify`);
  assert.equal(re.status, 200);
  assert.equal(re.json.event.verification.status, 'verified');
  assert.equal((await t.request('POST', `/api/projects/${pid}/events/${e.id}/reverify`)).status, 409);
});

test('[fixture] if PayPal cannot verify (server error) the delivery is stored as error (503), never verified', async () => {
  const r = await deliver(eventBody(), sigHeaders({ 'paypal-transmission-sig': 'FIXTURE-PAYPAL-DOWN' }));
  assert.equal(r.status, 503);
  assert.equal(r.json.verification, 'error');
  const e = (await events()).json.events[0];
  assert.equal(e.verification.status, 'error');
  assert.match(e.verification.detail, /Could not ask PayPal to verify/);
  const calls = (await t.request('GET', `/api/projects/${pid}/paypal-calls`)).json.calls;
  assert.equal(calls[0].operation, 'verify_webhook_signature');
  assert.equal(calls[0].httpStatus, 500);
});

test('[fixture] an unreachable PayPal is also an honest "error", not a pass', async () => {
  const dead = await startTestApp('http://127.0.0.1:1', 800);
  try {
    await dead.login();
    const id = (await dead.request('POST', '/api/projects', goodProject({ paypalWebhookId: 'FXWEBHOOK0001' }))).json.project.id;
    const res = await fetch(`${dead.base}/webhooks/paypal/${id}`, { method: 'POST', headers: sigHeaders(), body: eventBody() });
    assert.equal(res.status, 503);
    assert.equal(dead.db.prepare('SELECT verification_status FROM webhook_events').get().verification_status, 'error');
  } finally { await dead.close(); }
});

test('malformed, empty and oversized bodies are handled safely', async () => {
  for (const body of ['not json at all', '', '[1,2,3]', '"just a string"']) {
    const r = await deliver(body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal(rows('webhook_events'), 0);
  assert.equal(rows('webhook_deliveries'), 4);
  const big = await fetch(`${t.base}/webhooks/paypal/${pid}`, { method: 'POST', headers: sigHeaders(), body: 'x'.repeat(1024 * 1024 + 10) });
  assert.equal(big.status, 413);
  assert.equal(rows('webhook_events'), 0);
});

test('unknown or malformed project IDs get a 404 and write nothing', async () => {
  assert.equal((await deliver(eventBody(), sigHeaders(), crypto.randomUUID())).status, 404);
  assert.equal((await deliver(eventBody(), sigHeaders(), 'not-a-uuid')).status, 404);
  assert.equal(rows('webhook_events') + rows('webhook_deliveries'), 0);
});

test('[fixture] event list supports status, type and text filters, paging, and escapes wildcards', async () => {
  await deliver(eventBody({ id: 'WH-A', resourceId: 'FXCAPTURE0001' }), sigHeaders({ 'paypal-transmission-id': 'tx-a' }));
  await deliver(eventBody({ id: 'WH-B', resourceId: 'FXORDER0007', type: 'CHECKOUT.ORDER.APPROVED' }), sigHeaders({ 'paypal-transmission-id': 'tx-b' }));
  await deliver(eventBody({ id: 'WH-C' }), sigHeaders({ 'paypal-transmission-id': 'tx-c', 'paypal-transmission-sig': 'FIXTURE-BAD-SIG' }));

  const all = (await events()).json;
  assert.equal(all.total, 3);
  assert.deepEqual(all.eventTypes, ['CHECKOUT.ORDER.APPROVED', 'PAYMENT.CAPTURE.COMPLETED']);
  assert.equal((await events('?type=CHECKOUT.ORDER.APPROVED')).json.total, 1);
  assert.equal((await events('?q=FXORDER0007')).json.events[0].paypalEventId, 'WH-B');
  assert.equal((await events('?q=WH-A')).json.total, 1);
  assert.equal((await events('?status=verified')).json.total, 2);
  assert.equal((await events('?limit=1&offset=1')).json.events.length, 1);
  assert.equal((await events('?q=%25')).json.total, 0);
  assert.equal((await events('?status=bogus')).status, 400);
});

test('webhook deliveries log includes rejected and malformed requests', async () => {
  await deliver('garbage');
  await deliver(eventBody(), sigHeaders({ 'paypal-transmission-sig': 'FIXTURE-BAD-SIG' }));
  await deliver(eventBody({ id: 'WH-OK' }));
  const d = (await t.request('GET', `/api/projects/${pid}/webhook-deliveries`)).json.deliveries;
  assert.deepEqual(d.map((x) => x.responseStatus), [200, 401, 400]);
  assert.equal(d[2].eventId, null);
  assert.match(d[2].note, /not a JSON object/);
});

test('event endpoints require sign-in and stay inside their project', async () => {
  await deliver(eventBody());
  const eventId = (await events()).json.events[0].id;
  assert.equal((await fetch(`${t.base}/api/projects/${pid}/events`)).status, 401);
  const otherId = (await t.request('POST', '/api/projects', goodProject({ name: 'Other project' }))).json.project.id;
  assert.equal((await t.request('GET', `/api/projects/${otherId}/events/${eventId}`)).status, 404);
  assert.equal((await t.request('POST', `/api/projects/${otherId}/events/${eventId}/reverify`)).status, 404);
  assert.equal((await t.request('GET', `/api/projects/${otherId}/events`)).json.total, 0);
});

test('deleting a project removes its events and deliveries; secrets and tokens never appear in webhook data', async () => {
  await deliver(eventBody());
  const all = [(await events()).text, (await t.request('GET', `/api/projects/${pid}/webhook-deliveries`)).text, (await t.request('GET', `/api/projects/${pid}`)).text].join('\n');
  assert.ok(!all.includes(GOOD_SECRET));
  assert.ok(!/fixture-token-\d+/.test(all));
  assert.equal((await t.request('DELETE', `/api/projects/${pid}`)).status, 204);
  assert.equal(rows('webhook_events') + rows('webhook_deliveries'), 0);
});
