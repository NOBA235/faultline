'use strict';
// FIXTURE tests: PayPal is replaced by the local stand-in in support/fixtures.js.
// They verify Faultline's behavior (requests it sends, what it stores, how it reports errors).
// They are NOT PayPal Sandbox integration tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startFixturePayPal, startTestApp, goodProject, GOOD_SECRET } = require('../support/fixtures');

let fx;
let t;
let pid;
const ORDERS = '/v2/checkout/orders';

test.before(async () => { fx = await startFixturePayPal(); });
test.after(async () => { await fx.close(); });
test.beforeEach(async () => {
  fx.state.captureDelayMs = 0;
  t = await startTestApp(fx.url, 1500);
  await t.login();
  pid = (await t.request('POST', '/api/projects', goodProject())).json.project.id;
});
test.afterEach(async () => { await t.close(); });

const create = (over = {}) => t.request('POST', `/api/projects/${pid}/orders`, { amount: '10.00', currency: 'USD', idempotencyKey: crypto.randomUUID(), ...over });
const makeApproved = async () => {
  const o = (await create()).json.order;
  fx.approve(o.paypalOrderId);
  await t.request('POST', `/api/projects/${pid}/orders/${o.id}/refresh`);
  return o;
};

test('[fixture] create order sends the documented request and saves what PayPal returned', async () => {
  const before = fx.count('POST', ORDERS);
  const r = await create({ amount: '12.5', description: 'Faultline test' });
  assert.equal(r.status, 201);
  assert.equal(fx.count('POST', ORDERS), before + 1);

  const sent = fx.seen.filter((x) => x.method === 'POST' && x.url === ORDERS).at(-1);
  assert.match(sent.headers.authorization, /^Bearer fixture-token-\d+$/);
  assert.match(sent.headers['paypal-request-id'], /^fl-[0-9a-f]{64}$/);
  assert.ok(sent.headers['paypal-request-id'].length <= 108);
  assert.equal(sent.headers.prefer, 'return=representation');
  assert.equal(sent.json.intent, 'CAPTURE');
  assert.deepEqual(sent.json.purchase_units[0].amount, { currency_code: 'USD', value: '12.50' });
  assert.equal(sent.json.purchase_units[0].description, 'Faultline test');
  assert.equal(sent.json.purchase_units[0].custom_id, `faultline:${r.json.order.id}`);
  assert.equal(sent.json.payment_source.paypal.experience_context.return_url, 'http://127.0.0.1:3000/paypal-return.html');
  assert.equal(sent.json.payment_source.paypal.experience_context.user_action, 'PAY_NOW');

  const o = r.json.order;
  assert.match(o.paypalOrderId, /^FXORDER\d{4}$/);
  assert.equal(o.status, 'PAYER_ACTION_REQUIRED');
  assert.equal(o.amount.value, '12.50');
  assert.equal(o.approveUrl, `https://www.sandbox.paypal.com/checkoutnow?token=${o.paypalOrderId}`);

  const list = await t.request('GET', `/api/projects/${pid}/orders`);
  assert.deepEqual(list.json.orders.map((x) => x.id), [o.id]);
  const detail = await t.request('GET', `/api/projects/${pid}/orders/${o.id}`);
  assert.equal(detail.json.raw.id, o.paypalOrderId);
  assert.deepEqual(detail.json.captures, []);
});

test('[fixture] amounts are normalized to two decimals', async () => {
  for (const [input, expected] of [['5', '5.00'], ['10.5', '10.50'], [12, '12.00'], ['007.5', '7.50']]) {
    const r = await create({ amount: input });
    assert.equal(r.status, 201, String(input));
    const sent = fx.seen.filter((x) => x.url === ORDERS && x.method === 'POST').at(-1);
    assert.equal(sent.json.purchase_units[0].amount.value, expected);
  }
});

test('[fixture] the same idempotency key never creates a second PayPal order', async () => {
  const key = crypto.randomUUID();
  const before = fx.count('POST', ORDERS);
  const a = await create({ idempotencyKey: key });
  const b = await create({ idempotencyKey: key });
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.json.duplicate, true);
  assert.equal(b.json.order.id, a.json.order.id);
  assert.equal(fx.count('POST', ORDERS), before + 1);
});

test('[fixture] two simultaneous requests with the same key end up as one local order', async () => {
  const key = crypto.randomUUID();
  const [a, b] = await Promise.all([create({ idempotencyKey: key }), create({ idempotencyKey: key })]);
  assert.ok([200, 201].includes(a.status) && [200, 201].includes(b.status));
  assert.equal(a.json.order.id, b.json.order.id);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM paypal_orders').get().n, 1);
});

test('invalid order input is rejected before anything is sent to PayPal', async () => {
  const before = fx.seen.length;
  const cases = [
    [{ amount: '0' }, 'amount'], [{ amount: '-5' }, 'amount'], [{ amount: 'abc' }, 'amount'], [{ amount: '10.999' }, 'amount'],
    [{ amount: '10000.01' }, 'amount'], [{ amount: undefined }, 'amount'], [{ currency: 'XYZ' }, 'currency'],
    [{ description: 'x'.repeat(128) }, 'description'], [{ idempotencyKey: 'short' }, 'idempotencyKey'],
  ];
  for (const [over, field] of cases) {
    const r = await create(over);
    assert.equal(r.status, 400, JSON.stringify(over));
    assert.ok(r.json.error.fields[field], `expected an error on ${field}`);
  }
  assert.equal(fx.seen.length, before);
  assert.equal((await t.request('POST', `/api/projects/${pid}/orders`, '[1]')).status, 400);
});

test('[fixture] PayPal business rejection (422) is shown with PayPal\'s own details and saves nothing', async () => {
  const r = await create({ amount: '77.77' });
  assert.equal(r.status, 422);
  assert.equal(r.json.error.code, 'paypal_rejected');
  assert.equal(r.json.error.details.httpStatus, 422);
  assert.equal(r.json.error.details.name, 'UNPROCESSABLE_ENTITY');
  assert.equal(r.json.error.details.issues[0].issue, 'FIXTURE_RULE');
  assert.equal(r.json.error.details.debugId, 'fixture-debug-id');
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM paypal_orders').get().n, 0);

  const calls = (await t.request('GET', `/api/projects/${pid}/paypal-calls`)).json.calls;
  assert.equal(calls[0].operation, 'create_order');
  assert.equal(calls[0].httpStatus, 422);
  assert.equal(calls[0].outcome, 'paypal_error');
  assert.equal(calls[0].errorName, 'UNPROCESSABLE_ENTITY');
});

test('[fixture] PayPal server error (500) is reported as such and saves nothing', async () => {
  const r = await create({ amount: '66.66' });
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, 'paypal_server_error');
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM paypal_orders').get().n, 0);
});

test('unreachable PayPal -> honest 502, no order is invented', async () => {
  const dead = await startTestApp('http://127.0.0.1:1', 800);
  try {
    await dead.login();
    const id = (await dead.request('POST', '/api/projects', goodProject())).json.project.id;
    const r = await dead.request('POST', `/api/projects/${id}/orders`, { amount: '10.00' });
    assert.equal(r.status, 502);
    assert.equal(r.json.error.code, 'paypal_unreachable');
    assert.equal(dead.db.prepare('SELECT COUNT(*) AS n FROM paypal_orders').get().n, 0);
  } finally { await dead.close(); }
});

test('[fixture] capture before the buyer approves is refused by PayPal, and local state stays truthful', async () => {
  const o = (await create()).json.order;
  const r = await t.request('POST', `/api/projects/${pid}/orders/${o.id}/capture`);
  assert.equal(r.status, 422);
  assert.equal(r.json.error.code, 'paypal_rejected');
  assert.equal(r.json.error.details.issues[0].issue, 'ORDER_NOT_APPROVED');
  const detail = (await t.request('GET', `/api/projects/${pid}/orders/${o.id}`)).json;
  assert.equal(detail.order.status, 'PAYER_ACTION_REQUIRED');
  assert.deepEqual(detail.captures, []);
});

test('[fixture] refresh -> capture -> capture details, end to end', async () => {
  const o = await makeApproved();
  const refreshed = (await t.request('GET', `/api/projects/${pid}/orders/${o.id}`)).json;
  assert.equal(refreshed.order.status, 'APPROVED');
  assert.equal(refreshed.raw.payer.payer_id, 'FXPAYER0001');

  const cap = await t.request('POST', `/api/projects/${pid}/orders/${o.id}/capture`);
  assert.equal(cap.status, 200);
  assert.equal(cap.json.order.status, 'COMPLETED');
  assert.equal(cap.json.captures.length, 1);
  const c = cap.json.captures[0];
  assert.match(c.paypalCaptureId, /^FXCAPTURE\d{4}$/);
  assert.deepEqual(c.amount, { value: '10.00', currencyCode: 'USD' });
  assert.equal(c.finalCapture, true);
  assert.equal(c.status, 'COMPLETED');

  const sent = fx.seen.filter((x) => x.method === 'POST' && x.url === `${ORDERS}/${o.paypalOrderId}/capture`);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].headers['paypal-request-id'], `fl-capture-${o.id}`);

  fx.setCaptureStatus(c.paypalCaptureId, 'PARTIALLY_REFUNDED');
  const again = await t.request('POST', `/api/projects/${pid}/orders/${o.id}/captures/${c.id}/refresh`);
  assert.equal(again.status, 200);
  assert.equal(again.json.captures[0].status, 'PARTIALLY_REFUNDED');
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM paypal_captures').get().n, 1);
});

test('[fixture] a second capture is refused locally without calling PayPal', async () => {
  const o = await makeApproved();
  await t.request('POST', `/api/projects/${pid}/orders/${o.id}/capture`);
  const before = fx.count('POST', `${ORDERS}/${o.paypalOrderId}/capture`);
  const r = await t.request('POST', `/api/projects/${pid}/orders/${o.id}/capture`);
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'already_captured');
  assert.equal(fx.count('POST', `${ORDERS}/${o.paypalOrderId}/capture`), before);
});

test('[fixture] two simultaneous capture clicks send exactly one capture to PayPal', async () => {
  const o = await makeApproved();
  fx.state.captureDelayMs = 300;
  const before = fx.count('POST', `${ORDERS}/${o.paypalOrderId}/capture`);
  const [a, b] = await Promise.all([
    t.request('POST', `/api/projects/${pid}/orders/${o.id}/capture`),
    t.request('POST', `/api/projects/${pid}/orders/${o.id}/capture`),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(fx.count('POST', `${ORDERS}/${o.paypalOrderId}/capture`), before + 1);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM paypal_captures').get().n, 1);
});

test('[fixture] access tokens are reused, and a rejected token is replaced once and the call retried', async () => {
  const tokenCalls = () => fx.count('POST', '/v1/oauth2/token');
  const base = tokenCalls();
  const o = (await create()).json.order;
  await t.request('POST', `/api/projects/${pid}/orders/${o.id}/refresh`);
  assert.equal(tokenCalls(), base + 1, 'the token should be fetched once and reused');

  fx.invalidateTokens();
  const r = await t.request('POST', `/api/projects/${pid}/orders/${o.id}/refresh`);
  assert.equal(r.status, 200);
  assert.equal(tokenCalls(), base + 2);

  const calls = (await t.request('GET', `/api/projects/${pid}/paypal-calls`)).json.calls;
  const gets = calls.filter((c) => c.operation === 'get_order');
  assert.deepEqual(gets.slice(0, 2).map((c) => c.httpStatus), [200, 401]);
});

test('orders are scoped to their project and require sign-in', async () => {
  const o = (await create()).json.order;
  const otherId = (await t.request('POST', '/api/projects', goodProject({ name: 'Other project' }))).json.project.id;
  assert.equal((await t.request('GET', `/api/projects/${otherId}/orders/${o.id}`)).status, 404);
  assert.equal((await t.request('POST', `/api/projects/${otherId}/orders/${o.id}/capture`)).status, 404);
  assert.equal((await t.request('GET', `/api/projects/${otherId}/orders`)).json.orders.length, 0);
  const anon = await fetch(`${t.base}/api/projects/${pid}/orders`);
  assert.equal(anon.status, 401);
});

test('an unreadable stored secret stops order creation before any PayPal call', async () => {
  t.db.prepare('UPDATE projects SET paypal_secret_enc = ? WHERE id = ?').run('v1:AAAA:AAAA:AAAA', pid);
  const before = fx.seen.length;
  const r = await create();
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'secret_unreadable');
  assert.equal(fx.seen.length, before);
});

test('[fixture] deleting a project removes its orders, captures and call log', async () => {
  const o = await makeApproved();
  await t.request('POST', `/api/projects/${pid}/orders/${o.id}/capture`);
  assert.equal((await t.request('DELETE', `/api/projects/${pid}`)).status, 204);
  for (const table of ['paypal_orders', 'paypal_captures', 'paypal_api_calls']) {
    assert.equal(t.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  }
});

test('[fixture] neither the secret nor any access token is stored or returned', async () => {
  const o = await makeApproved();
  await t.request('POST', `/api/projects/${pid}/orders/${o.id}/capture`);
  const bodies = [
    (await t.request('GET', `/api/projects/${pid}/orders`)).text,
    (await t.request('GET', `/api/projects/${pid}/orders/${o.id}`)).text,
    (await t.request('GET', `/api/projects/${pid}/paypal-calls`)).text,
    (await t.request('GET', `/api/projects/${pid}`)).text,
  ].join('\n');
  const dump = JSON.stringify(['paypal_orders', 'paypal_captures', 'paypal_api_calls', 'connection_checks'].map((n) => t.db.prepare(`SELECT * FROM ${n}`).all()));
  for (const haystack of [bodies, dump]) {
    assert.ok(!haystack.includes(GOOD_SECRET));
    assert.ok(!/fixture-token-\d+/.test(haystack), 'an access token leaked');
  }
});
