'use strict';
// Pure unit tests with synthetic evidence. No network, no PayPal, no database.
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../src/checks');

const SHA = 'a'.repeat(64);
const att = (n, outcome = 'delivered', httpStatus = 200) => ({ attemptNo: n, outcome, httpStatus, bodySha256: SHA, requestHeaders: { 'paypal-transmission-id': 'tx-1' } });
const snap = (data, outcome = 'ok', errorText = null) => ({ outcome, data, errorText });
const data = (o = {}) => ({ processedCount: null, status: null, capturedCents: null, refundedCents: null, currency: null, paymentRecords: null, ...o });
const base = (over = {}) => ({
  run: { kind: 'forward' },
  event: { eventType: 'PAYMENT.CAPTURE.COMPLETED', resourceType: 'capture', resourceId: 'CAP1', createTime: '2026-11-05T10:00:00Z', rawSha256: SHA, transmissionId: 'tx-1' },
  attempts: [att(1)],
  probe: { configured: false },
  paypal: { applicable: false },
  newerDelivered: [],
  money: null,
  ...over,
});
const probe = (before, after) => ({ configured: true, settleMs: 500, before: snap(data(before)), after: snap(data(after)) });
const get = (r, id) => r.assertions.find((a) => a.id === id);

test('without a probe, 2xx replies alone never produce "passed"', () => {
  const r = evaluate(base({ attempts: [att(1), att(2), att(3)], run: { kind: 'duplicate' } }));
  assert.equal(r.verdict, 'inconclusive');
  assert.equal(get(r, 'deliveries_accepted').verdict, 'pass');
  assert.equal(get(r, 'injection_integrity').verdict, 'pass');
  assert.equal(get(r, 'idempotent_processing').verdict, 'not_evaluable');
  assert.match(r.reason, /does not show that your integration is safe/);
  assert.ok(r.risks.some((x) => /3 copies/.test(x) && /unverified/.test(x)));
});

test('idempotency: processed once passes, processed N times fails', () => {
  const ok = evaluate(base({ attempts: [att(1), att(2), att(3)], probe: probe({ processedCount: 0 }, { processedCount: 1 }) }));
  assert.equal(get(ok, 'idempotent_processing').verdict, 'pass');
  assert.equal(ok.verdict, 'passed');
  const bad = evaluate(base({ attempts: [att(1), att(2), att(3)], probe: probe({ processedCount: 0 }, { processedCount: 3 }) }));
  assert.equal(get(bad, 'idempotent_processing').verdict, 'fail');
  assert.match(get(bad, 'idempotent_processing').summary, /3 times/);
  assert.equal(bad.verdict, 'failed');
  const replayed = evaluate(base({ run: { kind: 'replay' }, probe: probe({ processedCount: 1 }, { processedCount: 2 }) }));
  assert.equal(get(replayed, 'idempotent_processing').verdict, 'fail', 'a replay of an already processed event must not add a processing');
});

test('failed delivery that still shows as processed fails; clean failure passes', () => {
  const fail500 = [att(1, 'http_error', 500)];
  const bad = evaluate(base({ attempts: fail500, probe: probe({ processedCount: 0 }, { processedCount: 1 }) }));
  assert.equal(get(bad, 'failed_delivery_not_processed').verdict, 'fail');
  assert.equal(get(bad, 'deliveries_accepted').verdict, 'fail');
  const good = evaluate(base({ attempts: fail500, probe: probe({ processedCount: 0 }, { processedCount: 0 }) }));
  assert.equal(get(good, 'failed_delivery_not_processed').verdict, 'pass');
  assert.equal(get(good, 'deliveries_accepted').verdict, 'fail', 'a 500 is still a failed delivery');
  const mixed = evaluate(base({ attempts: [att(1, 'http_error', 500), att(2)], probe: probe({ processedCount: 0 }, { processedCount: 1 }) }));
  assert.equal(get(mixed, 'failed_delivery_not_processed').verdict, 'not_applicable');
});

test('an accepted delivery that left no trace in the application fails', () => {
  const lost = evaluate(base({ probe: probe({ processedCount: 0 }, { processedCount: 0 }) }));
  assert.equal(get(lost, 'accepted_delivery_processed').verdict, 'fail');
  const fine = evaluate(base({ probe: probe({ processedCount: 0 }, { processedCount: 1 }) }));
  assert.equal(get(fine, 'accepted_delivery_processed').verdict, 'pass');
  assert.equal(get(evaluate(base({ attempts: [att(1, 'timeout', null)], probe: probe({ processedCount: 0 }, { processedCount: 0 }) })), 'accepted_delivery_processed').verdict, 'not_applicable');
});

test('second payment record in the application fails; PayPal-side capture count is a separate fact', () => {
  const bad = evaluate(base({ probe: probe({ paymentRecords: 1 }, { paymentRecords: 2 }) }));
  assert.equal(get(bad, 'no_second_payment_in_app').verdict, 'fail');
  assert.equal(get(evaluate(base({ probe: probe({ paymentRecords: 0 }, { paymentRecords: 1 }) })), 'no_second_payment_in_app').verdict, 'pass');
  const pp = (b, a) => ({ applicable: true, before: snap({ captureCount: b }), after: snap({ captureCount: a }) });
  assert.equal(get(evaluate(base({ paypal: pp(1, 1) })), 'paypal_payment_unchanged').verdict, 'pass');
  assert.equal(get(evaluate(base({ paypal: pp(1, 2) })), 'paypal_payment_unchanged').verdict, 'fail');
  assert.equal(get(evaluate(base({ paypal: { applicable: true, before: snap({ captureCount: 1 }), after: snap(null, 'error', 'PayPal down') } })), 'paypal_payment_unchanged').verdict, 'not_evaluable');
  assert.equal(get(evaluate(base()), 'paypal_payment_unchanged').verdict, 'not_applicable');
});

test('refunds: PayPal-reported total and the application\'s own total are compared with the captured amount', () => {
  const m = (refund) => ({ captureId: 'CAP1', capturedCents: 1010, currency: 'USD', refundCurrency: 'USD', refundTotalCents: refund, refundEventCount: 1 });
  assert.equal(get(evaluate(base({ money: m(1010) })), 'refund_events_within_captured').verdict, 'pass');
  assert.equal(get(evaluate(base({ money: m(1011) })), 'refund_events_within_captured').verdict, 'fail');
  assert.equal(get(evaluate(base({ money: { ...m(100), refundCurrency: 'EUR' } })), 'refund_events_within_captured').verdict, 'not_evaluable');
  assert.equal(get(evaluate(base({ money: { ...m(100), capturedCents: null } })), 'refund_events_within_captured').verdict, 'not_evaluable');
  assert.equal(get(evaluate(base()), 'refund_events_within_captured').verdict, 'not_applicable');
  assert.equal(get(evaluate(base({ money: { ...m(0), refundEventCount: 0 } })), 'refund_events_within_captured').verdict, 'not_applicable', 'nothing to compare when PayPal reported no refunds');

  const afterOnly = (d) => ({ configured: true, before: snap(data()), after: snap(data(d)) });
  assert.equal(get(evaluate(base({ probe: afterOnly({ capturedCents: 1010, refundedCents: 1010 }) })), 'app_refunds_within_captured').verdict, 'pass');
  assert.equal(get(evaluate(base({ probe: afterOnly({ capturedCents: 1010, refundedCents: 2020 }) })), 'app_refunds_within_captured').verdict, 'fail');
  assert.equal(get(evaluate(base({ money: m(0), probe: afterOnly({ refundedCents: 5000 }) })), 'app_refunds_within_captured').verdict, 'fail', 'falls back to the amount PayPal reported');
  assert.equal(get(evaluate(base({ probe: afterOnly({}) })), 'app_refunds_within_captured').verdict, 'not_evaluable');
});

test('stale overwrite: only evaluated when a newer event was already delivered', () => {
  const newer = [{ paypalEventId: 'WH-NEW', eventType: 'PAYMENT.CAPTURE.COMPLETED', createTime: '2026-11-05T10:05:00Z', deliveredAt: '2026-11-05T10:06:00Z' }];
  const order = { eventType: 'CHECKOUT.ORDER.APPROVED', resourceType: 'checkout-order', resourceId: 'ORD1', createTime: '2026-11-05T10:00:00Z', rawSha256: SHA, transmissionId: 'tx-1' };
  assert.equal(get(evaluate(base({ event: order })), 'no_stale_overwrite').verdict, 'not_applicable');
  const regress = evaluate(base({ event: order, run: { kind: 'delay' }, newerDelivered: newer, probe: probe({ status: 'COMPLETED' }, { status: 'APPROVED' }) }));
  assert.equal(get(regress, 'no_stale_overwrite').verdict, 'fail');
  assert.equal(get(regress, 'valid_state_transition').verdict, 'fail');
  assert.equal(regress.verdict, 'failed');
  const held = evaluate(base({ event: order, run: { kind: 'delay' }, newerDelivered: newer, probe: probe({ status: 'COMPLETED' }, { status: 'COMPLETED' }) }));
  assert.equal(get(held, 'no_stale_overwrite').verdict, 'pass');
  assert.equal(held.verdict, 'passed');
  const noProbe = evaluate(base({ event: order, run: { kind: 'delay' }, newerDelivered: newer }));
  assert.equal(get(noProbe, 'no_stale_overwrite').verdict, 'not_evaluable');
  assert.ok(get(noProbe, 'no_stale_overwrite').evidence.some((e) => e.type === 'observed' && /WH-NEW/.test(e.text)), 'the out-of-order delivery is an observed fact even without a probe');
  assert.ok(noProbe.risks.some((x) => /state went backwards/.test(x)));
});

test('state transitions follow PayPal\'s capture and order lifecycles', () => {
  const t = (resourceType, from, to) => get(evaluate(base({ event: { ...base().event, resourceType }, probe: probe({ status: from }, { status: to }) })), 'valid_state_transition').verdict;
  assert.equal(t('capture', 'PENDING', 'COMPLETED'), 'pass');
  assert.equal(t('capture', 'COMPLETED', 'COMPLETED'), 'pass');
  assert.equal(t('capture', 'COMPLETED', 'PARTIALLY_REFUNDED'), 'pass');
  assert.equal(t('capture', 'REFUNDED', 'COMPLETED'), 'fail');
  assert.equal(t('capture', 'DECLINED', 'COMPLETED'), 'fail');
  assert.equal(t('capture', 'COMPLETED', 'PENDING'), 'fail');
  assert.equal(t('checkout-order', 'APPROVED', 'COMPLETED'), 'pass');
  assert.equal(t('checkout-order', 'COMPLETED', 'APPROVED'), 'fail');
  assert.equal(t('checkout-order', 'VOIDED', 'APPROVED'), 'fail');
  assert.equal(t('capture', 'SHIPPED', 'COMPLETED'), 'not_evaluable', 'unknown status names are never guessed');
  assert.equal(get(evaluate(base({ event: { ...base().event, resourceType: 'dispute' }, probe: probe({ status: 'A' }, { status: 'B' }) })), 'valid_state_transition').verdict, 'not_applicable');
});

test('a payment that first appears is judged as a creation; a missing "after" status is never guessed', () => {
  const created = evaluate(base({ probe: probe({}, { status: 'COMPLETED' }) }));
  assert.equal(get(created, 'valid_state_transition').verdict, 'pass');
  assert.match(get(created, 'valid_state_transition').summary, /did not exist before/);
  assert.equal(get(evaluate(base({ probe: probe({}, { status: 'SHIPPED' }) })), 'valid_state_transition').verdict, 'not_evaluable');
  assert.equal(get(evaluate(base({ probe: probe({ status: 'PENDING' }, {}) })), 'valid_state_transition').verdict, 'not_evaluable');
});

test('a dropped event still gets its state-transition check, and the drop is explained as a risk, not a verdict', () => {
  const r = evaluate(base({ run: { kind: 'drop' }, attempts: [{ attemptNo: 1, outcome: 'dropped', httpStatus: null }], probe: probe({ status: 'PENDING' }, { status: 'PENDING' }) }));
  assert.equal(get(r, 'valid_state_transition').verdict, 'pass');
  assert.equal(get(r, 'deliveries_accepted').verdict, 'not_applicable');
  assert.ok(r.risks.some((x) => /withheld/.test(x)));
});

test('a tampered request makes the run untrustworthy', () => {
  const r = evaluate(base({ attempts: [{ ...att(1), bodySha256: 'b'.repeat(64) }] }));
  assert.equal(get(r, 'injection_integrity').verdict, 'fail');
  assert.equal(r.verdict, 'failed');
  const wrongTx = evaluate(base({ attempts: [{ ...att(1), requestHeaders: { 'paypal-transmission-id': 'other' } }] }));
  assert.equal(get(wrongTx, 'injection_integrity').verdict, 'fail');
});

test('probe problems are reported as not_evaluable with the reason, never as pass or fail', () => {
  const down = evaluate(base({ probe: { configured: true, before: snap(null, 'error', 'Could not reach the probe (ECONNREFUSED).'), after: snap(null, 'error', 'x') } }));
  assert.equal(get(down, 'idempotent_processing').verdict, 'not_evaluable');
  assert.match(get(down, 'idempotent_processing').summary, /ECONNREFUSED/);
  assert.equal(down.verdict, 'inconclusive');
  const missingField = evaluate(base({ probe: probe({ status: 'COMPLETED' }, { status: 'COMPLETED' }) }));
  assert.equal(get(missingField, 'idempotent_processing').verdict, 'not_evaluable');
  assert.match(get(missingField, 'idempotent_processing').summary, /event\.processed_count/);
});

test('"passed" needs a check on the application\'s own state; PayPal-side, delivery and integrity passes are not enough', () => {
  const m = { captureId: 'CAP1', capturedCents: 1010, currency: 'USD', refundCurrency: 'USD', refundTotalCents: 100, refundEventCount: 1 };
  const platformOnly = evaluate(base({ money: m, paypal: { applicable: true, before: snap({ captureCount: 1 }), after: snap({ captureCount: 1 }) } }));
  assert.equal(get(platformOnly, 'refund_events_within_captured').verdict, 'pass');
  assert.equal(get(platformOnly, 'paypal_payment_unchanged').verdict, 'pass');
  assert.equal(platformOnly.verdict, 'inconclusive', 'facts about PayPal say nothing about your application');
  const failing = evaluate(base({ paypal: { applicable: true, before: snap({ captureCount: 1 }), after: snap({ captureCount: 2 }) } }));
  assert.equal(failing.verdict, 'failed', 'a PayPal-side failure still fails the run');
  const r = evaluate(base());
  assert.equal(get(r, 'deliveries_accepted').verdict, 'pass');
  assert.equal(r.verdict, 'inconclusive');
  assert.ok(!r.assertions.some((a) => a.verdict === 'pass' && a.category === 'invariant'));
  assert.ok(r.assertions.every((a) => ['integrity', 'delivery', 'invariant', 'platform'].includes(a.category)));
});
