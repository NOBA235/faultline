'use strict';

// Deterministic checks. Pure functions: evidence in, verdict out. No AI, no network, no database.
// A check says "pass" or "fail" only when the evidence it needs is present. Otherwise it says
// "not_evaluable" (needed evidence is missing) or "not_applicable" (the scenario cannot test it).
// "Observed" evidence comes from Faultline's own requests or from PayPal. "Probe" evidence comes from the
// developer's optional state probe. Anything Faultline merely suspects goes into `risks`, never into a verdict.

const CAPTURE_TRANSITIONS = {
  PENDING: ['COMPLETED', 'DECLINED', 'FAILED'],
  COMPLETED: ['PARTIALLY_REFUNDED', 'REFUNDED'],
  PARTIALLY_REFUNDED: ['PARTIALLY_REFUNDED', 'REFUNDED'],
  DECLINED: [], FAILED: [], REFUNDED: [],
};
const ORDER_TRANSITIONS = {
  CREATED: ['SAVED', 'PAYER_ACTION_REQUIRED', 'APPROVED', 'COMPLETED', 'VOIDED'],
  SAVED: ['PAYER_ACTION_REQUIRED', 'APPROVED', 'COMPLETED', 'VOIDED'],
  PAYER_ACTION_REQUIRED: ['APPROVED', 'COMPLETED', 'VOIDED'],
  APPROVED: ['COMPLETED', 'VOIDED'],
  COMPLETED: [], VOIDED: [],
};
const TRANSITIONS = { capture: CAPTURE_TRANSITIONS, order: ORDER_TRANSITIONS };
const RANK = {
  capture: { PENDING: 1, COMPLETED: 2, DECLINED: 2, FAILED: 2, PARTIALLY_REFUNDED: 3, REFUNDED: 4 },
  order: { CREATED: 1, SAVED: 1, PAYER_ACTION_REQUIRED: 2, APPROVED: 3, COMPLETED: 4, VOIDED: 4 },
};
const familyOf = (resourceType) => (resourceType === 'capture' || resourceType === 'refund' ? 'capture' : resourceType === 'checkout-order' ? 'order' : null);
const FIELD_LABEL = { processedCount: 'event.processed_count', status: 'payment.status', paymentRecords: 'payment.payment_records' };
const money = (cents, cur) => `${(cents / 100).toFixed(2)}${cur ? ` ${cur}` : ''}`;
const ev = (type, text) => ({ type, text });
const make = (id, category, name, verdict, summary, evidence = []) => ({ id, category, name, verdict, summary, evidence });

// Reads fields from the before/after probe snapshots, or explains exactly what is missing.
function probeGate(ctx, needs) {
  const p = ctx.probe;
  if (!p || !p.configured) return { why: 'No state probe is configured for this project, so your application\'s own state cannot be read.' };
  for (const phase of ['before', 'after']) {
    const s = p[phase];
    if (!s) return { why: `The probe was not read ${phase} the scenario.` };
    if (s.outcome !== 'ok') return { why: `The probe could not be read ${phase} the scenario: ${s.errorText}` };
  }
  for (const f of needs) {
    if (p.before.data[f] === null || p.before.data[f] === undefined || p.after.data[f] === null || p.after.data[f] === undefined) {
      return { why: `The probe did not report ${FIELD_LABEL[f]} both before and after the scenario.` };
    }
  }
  return { before: p.before.data, after: p.after.data };
}

function evaluate(ctx) {
  const attempts = ctx.attempts || [];
  const sent = attempts.filter((a) => !['dropped', 'blocked'].includes(a.outcome));
  const accepted = sent.filter((a) => a.outcome === 'delivered');
  const family = familyOf(ctx.event.resourceType);
  const na = (id, cat, name, why) => make(id, cat, name, 'not_applicable', why);
  const ne = (id, cat, name, why) => make(id, cat, name, 'not_evaluable', why);
  const out = [];

  // ---- integrity of the test itself -----------------------------------------
  {
    const id = 'injection_integrity'; const name = 'Faultline sent the genuine event unchanged';
    if (!sent.length) out.push(na(id, 'integrity', name, 'Nothing was sent in this scenario.'));
    else {
      const bad = sent.filter((a) => a.bodySha256 !== ctx.event.rawSha256
        || (ctx.event.transmissionId && (a.requestHeaders || {})['paypal-transmission-id'] !== ctx.event.transmissionId));
      out.push(bad.length
        ? make(id, 'integrity', name, 'fail', `${bad.length} request(s) did not carry the stored body and PayPal signature headers unchanged, so this test is not trustworthy.`, bad.map((a) => ev('observed', `Attempt ${a.attemptNo} differed from the stored event.`)))
        : make(id, 'integrity', name, 'pass', 'Every request carried the stored event body and PayPal\'s transmission ID unchanged.', [ev('observed', `${sent.length} request(s) compared by SHA-256 and header.`)]));
    }
  }

  // ---- delivery -----------------------------------------------------------------
  {
    const id = 'deliveries_accepted'; const name = 'Your endpoint accepted every delivery';
    if (!sent.length) out.push(na(id, 'delivery', name, 'Nothing was sent in this scenario.'));
    else {
      const evidence = sent.map((a) => ev('observed', `Attempt ${a.attemptNo}: ${a.httpStatus ? `HTTP ${a.httpStatus}` : a.outcome}.`));
      out.push(accepted.length === sent.length
        ? make(id, 'delivery', name, 'pass', `All ${sent.length} delivery(ies) were answered with HTTP 2xx.`, evidence)
        : make(id, 'delivery', name, 'fail', `${sent.length - accepted.length} of ${sent.length} delivery(ies) were not accepted. PayPal would treat those as failed and retry them.`, evidence));
    }
  }

  // ---- financial invariants, from your application's probe -------------------------
  {
    const id = 'failed_delivery_not_processed'; const name = 'A failed delivery is not reported as processed';
    if (!sent.length) out.push(na(id, 'invariant', name, 'Nothing was sent in this scenario.'));
    else if (accepted.length) out.push(na(id, 'invariant', name, 'At least one delivery was accepted, so a failed delivery cannot be told apart from the accepted one.'));
    else {
      const g = probeGate(ctx, ['processedCount']);
      if (g.why) out.push(ne(id, 'invariant', name, g.why));
      else {
        const e = [ev('observed', `All ${sent.length} delivery(ies) failed (${sent.map((a) => a.httpStatus ?? a.outcome).join(', ')}).`), ev('probe', `processed_count was ${g.before.processedCount} before and ${g.after.processedCount} after.`)];
        out.push(g.after.processedCount > g.before.processedCount
          ? make(id, 'invariant', name, 'fail', 'Every delivery failed, yet your application\'s state shows the event as processed. A retry from PayPal could process it again.', e)
          : make(id, 'invariant', name, 'pass', 'Every delivery failed and your application\'s state shows no processing.', e));
      }
    }
  }
  {
    const id = 'accepted_delivery_processed'; const name = 'An accepted delivery was actually processed';
    if (!accepted.length) out.push(na(id, 'invariant', name, 'No delivery was accepted in this scenario.'));
    else {
      const g = probeGate(ctx, ['processedCount']);
      if (g.why) out.push(ne(id, 'invariant', name, g.why));
      else {
        const e = [ev('observed', `${accepted.length} delivery(ies) answered HTTP 2xx.`), ev('probe', `processed_count was ${g.before.processedCount} before and ${g.after.processedCount} after (read ${ctx.probe.settleMs ?? 0} ms after the last delivery).`)];
        out.push(g.after.processedCount >= 1
          ? make(id, 'invariant', name, 'pass', 'Your application acknowledged the event and its state shows it processed.', e)
          : make(id, 'invariant', name, 'fail', 'Your application answered 2xx but its state shows the event was not processed. PayPal will not retry an acknowledged event, so it could be lost. (If your application processes asynchronously, raise PROBE_SETTLE_MS.)', e));
      }
    }
  }
  {
    const id = 'idempotent_processing'; const name = 'The same event is processed at most once';
    if (!sent.length) out.push(na(id, 'invariant', name, 'Nothing was sent in this scenario.'));
    else {
      const g = probeGate(ctx, ['processedCount']);
      if (g.why) out.push(ne(id, 'invariant', name, g.why));
      else {
        const limit = Math.max(g.before.processedCount, 1);
        const e = [ev('observed', `${accepted.length} of ${sent.length} delivery(ies) were accepted.`), ev('probe', `processed_count was ${g.before.processedCount} before and ${g.after.processedCount} after.`)];
        out.push(g.after.processedCount > limit
          ? make(id, 'invariant', name, 'fail', `Your application processed this event ${g.after.processedCount} times. A correctly idempotent handler processes it once.`, e)
          : make(id, 'invariant', name, 'pass', 'Your application processed this event no more than once.', e));
      }
    }
  }
  {
    const id = 'no_second_payment_in_app'; const name = 'A repeated webhook does not create a second payment record';
    if (!sent.length) out.push(na(id, 'invariant', name, 'Nothing was sent in this scenario.'));
    else if (!family) out.push(na(id, 'invariant', name, 'This event is not about a payment or an order.'));
    else {
      const g = probeGate(ctx, ['paymentRecords']);
      if (g.why) out.push(ne(id, 'invariant', name, g.why));
      else {
        const e = [ev('probe', `payment_records was ${g.before.paymentRecords} before and ${g.after.paymentRecords} after.`)];
        out.push(g.after.paymentRecords > Math.max(g.before.paymentRecords, 1)
          ? make(id, 'invariant', name, 'fail', 'Your application holds more than one payment record after repeated deliveries of one event. A repeated webhook is not a repeated payment.', e)
          : make(id, 'invariant', name, 'pass', 'Your application holds no extra payment record.', e));
      }
    }
  }

  // ---- financial invariants, observed at PayPal -------------------------------------
  {
    const id = 'paypal_payment_unchanged'; const name = 'No new capture appeared at PayPal during the test';
    if (!sent.length) out.push(na(id, 'platform', name, 'Nothing was sent in this scenario.'));
    else if (!ctx.paypal || !ctx.paypal.applicable) out.push(na(id, 'platform', name, 'This event is not linked to an order Faultline created, so Faultline cannot read the payment at PayPal.'));
    else if (!ctx.paypal.before || ctx.paypal.before.outcome !== 'ok' || !ctx.paypal.after || ctx.paypal.after.outcome !== 'ok') {
      const bad = [ctx.paypal.before, ctx.paypal.after].find((s) => !s || s.outcome !== 'ok');
      out.push(ne(id, 'platform', name, `PayPal could not be read ${bad === ctx.paypal.before ? 'before' : 'after'} the scenario${bad && bad.errorText ? `: ${bad.errorText}` : '.'}`));
    } else {
      const b = ctx.paypal.before.data; const a = ctx.paypal.after.data;
      const e = [ev('paypal', `Captures on the order at PayPal: ${b.captureCount} before, ${a.captureCount} after.`)];
      out.push(a.captureCount > b.captureCount
        ? make(id, 'platform', name, 'fail', 'A new capture appeared on the order at PayPal while a webhook was being repeated. A repeated webhook must not create a payment.', e)
        : make(id, 'platform', name, 'pass', 'The number of captures on the order at PayPal did not increase.', e));
    }
  }
  {
    const id = 'refund_events_within_captured'; const name = 'Refunds reported by PayPal do not exceed the captured amount';
    const m = ctx.money;
    if (!m || !m.captureId) out.push(na(id, 'platform', name, 'This event does not identify a capture.'));
    else if (!m.refundEventCount) out.push(na(id, 'platform', name, 'PayPal has reported no refunds for this capture.'));
    else if (m.capturedCents === null || m.capturedCents === undefined) out.push(ne(id, 'platform', name, 'The captured amount for this capture is not known from stored PayPal data.'));
    else if (m.refundCurrency !== m.currency) out.push(ne(id, 'platform', name, 'Refund and capture are in different currencies, so they cannot be compared.'));
    else {
      const e = [ev('paypal', `Captured ${money(m.capturedCents, m.currency)}; ${m.refundEventCount} verified refund event(s) total ${money(m.refundTotalCents, m.currency)}.`)];
      out.push(m.refundTotalCents > m.capturedCents
        ? make(id, 'platform', name, 'fail', 'The verified refund events add up to more than the captured amount.', e)
        : make(id, 'platform', name, 'pass', 'Verified refund events do not exceed the captured amount. This is a fact about PayPal, not about your application.', e));
    }
  }
  {
    const id = 'app_refunds_within_captured'; const name = 'Refunds in your application do not exceed the captured amount';
    const after = ctx.probe && ctx.probe.configured && ctx.probe.after && ctx.probe.after.outcome === 'ok' ? ctx.probe.after.data : null;
    if (!after) out.push(ne(id, 'invariant', name, !ctx.probe || !ctx.probe.configured ? 'No state probe is configured for this project, so your application\'s own state cannot be read.' : 'The probe could not be read after the scenario.'));
    else if (after.refundedCents === null) out.push(ne(id, 'invariant', name, 'The probe did not report payment.refunded_amount.'));
    else {
      const captured = after.capturedCents !== null ? after.capturedCents : (ctx.money && ctx.money.capturedCents !== undefined && ctx.money.capturedCents !== null ? ctx.money.capturedCents : null);
      if (captured === null) out.push(ne(id, 'invariant', name, 'Neither the probe nor stored PayPal data gives a captured amount to compare against.'));
      else {
        const e = [ev('probe', `Your application reports ${money(after.refundedCents, after.currency)} refunded against ${money(captured, after.currency)} captured.`)];
        out.push(after.refundedCents > captured
          ? make(id, 'invariant', name, 'fail', 'Your application has refunded more than was captured.', e)
          : make(id, 'invariant', name, 'pass', 'Refunds in your application do not exceed the captured amount.', e));
      }
    }
  }

  // ---- state ordering ---------------------------------------------------------------
  {
    const id = 'no_stale_overwrite'; const name = 'A late, older event does not overwrite newer payment state';
    const newer = ctx.newerDelivered || [];
    if (!newer.length) out.push(na(id, 'invariant', name, 'No newer event for this payment had been delivered before this one. To test this, deliver a newer event for the same payment first, then use Delayed delivery on an older one.'));
    else if (!sent.length) out.push(na(id, 'invariant', name, 'Nothing was sent in this scenario.'));
    else if (!family) out.push(na(id, 'invariant', name, 'This event is not about a payment or an order.'));
    else {
      const g = probeGate(ctx, ['status']);
      const seen = [ev('observed', `Newer event ${newer[0].paypalEventId} (${newer[0].eventType}, created ${newer[0].createTime}) was delivered at ${newer[0].deliveredAt}, before this older event (created ${ctx.event.createTime}).`)];
      if (g.why) out.push(make(id, 'invariant', name, 'not_evaluable', g.why, seen));
      else {
        const rb = RANK[family][g.before.status]; const ra = RANK[family][g.after.status];
        const e = [...seen, ev('probe', `payment.status was ${g.before.status} before and ${g.after.status} after.`)];
        if (rb === undefined || ra === undefined) out.push(make(id, 'invariant', name, 'not_evaluable', `Status "${rb === undefined ? g.before.status : g.after.status}" is not a PayPal ${family} status, so its order cannot be judged. Report PayPal's status names from the probe.`, e));
        else out.push(ra < rb
          ? make(id, 'invariant', name, 'fail', 'The older event moved your payment back to an earlier state, overwriting newer information.', e)
          : make(id, 'invariant', name, 'pass', 'The older event did not move your payment back to an earlier state.', e));
      }
    }
  }
  {
    const id = 'valid_state_transition'; const name = 'The payment only makes valid state changes';
    if (!sent.length && ctx.run.kind !== 'drop') out.push(na(id, 'invariant', name, 'Nothing was sent in this scenario.'));
    else if (!family) out.push(na(id, 'invariant', name, 'This event is not about a payment or an order.'));
    else {
      const g = probeGate(ctx, []);
      const before = g.why ? null : g.before.status;
      const after = g.why ? null : g.after.status;
      const table = TRANSITIONS[family];
      if (g.why) out.push(ne(id, 'invariant', name, g.why));
      else if (after === null || after === undefined) out.push(ne(id, 'invariant', name, 'The probe did not report payment.status after the scenario.'));
      else if (!table[after] || (before && !table[before])) {
        out.push(make(id, 'invariant', name, 'not_evaluable', `Status "${!table[after] ? after : before}" is not a PayPal ${family} status, so its transition cannot be judged. Report PayPal's status names from the probe.`, [ev('probe', `payment.status was ${before || 'not reported'} before and ${after} after.`)]));
      } else if (!before) {
        out.push(make(id, 'invariant', name, 'pass', `The payment did not exist before and now has the valid ${family} status ${after}.`, [ev('probe', `payment.status was not reported before and ${after} after.`)]));
      } else {
        const e = [ev('probe', `payment.status was ${before} before and ${after} after.`)];
        out.push(before === after || table[before].includes(after)
          ? make(id, 'invariant', name, 'pass', before === after ? 'The payment state did not change.' : `${before} to ${after} is a valid change.`, e)
          : make(id, 'invariant', name, 'fail', `${before} to ${after} is not a valid ${family} state change.`, e));
      }
    }
  }

  // ---- overall verdict ---------------------------------------------------------------
  const fails = out.filter((a) => a.verdict === 'fail');
  const invariantPasses = out.filter((a) => a.category === 'invariant' && a.verdict === 'pass');
  const unknown = out.filter((a) => a.verdict === 'not_evaluable');
  let verdict; let reason;
  if (fails.length) { verdict = 'failed'; reason = `${fails.length} check(s) failed: ${fails.map((f) => f.name).join('; ')}.`; }
  else if (invariantPasses.length) {
    verdict = 'passed';
    reason = `${invariantPasses.length} check(s) on your application's own state held.${unknown.length ? ` ${unknown.length} check(s) could not be evaluated and are not counted as passes.` : ''}`;
  } else {
    verdict = 'inconclusive';
    reason = 'No check on your application\'s own state could be evaluated, so this run does not show that your integration is safe. Sending requests and getting 2xx replies proves nothing about payment handling. Add a state probe (see the README) to evaluate your application\'s own state.';
  }

  // ---- inferred risks: suspicions, clearly separated from verdicts -----------------------
  const risks = [];
  const probeOn = ctx.probe && ctx.probe.configured;
  if (!probeOn && accepted.length >= 2) risks.push(`${accepted.length} copies of the same event were accepted. Without a state probe Faultline cannot tell whether your application processed the payment once or ${accepted.length} times. Treat this as unverified.`);
  if (!probeOn && (ctx.newerDelivered || []).length && sent.length) risks.push('This older event was delivered after a newer one. Without a state probe Faultline cannot tell whether your application\'s state went backwards.');
  if (ctx.run.kind === 'drop') risks.push('Faultline withheld this event. Whether your application notices the gap and recovers (for example by asking PayPal for the order) is not something these checks can see.');
  return { assertions: out, verdict, reason, risks };
}

// General guidance for each kind of failure. Static text, not generated from your code.
const GUIDANCE = {
  injection_integrity: 'The test itself was altered in transit. Do not trust this run; run it again.',
  deliveries_accepted: 'Make your handler answer 2xx only after it has safely stored the event, and make it safe to run again. A non-2xx reply makes PayPal retry, so the same event can arrive several times.',
  failed_delivery_not_processed: 'Do the processing and the "mark as processed" step in one database transaction, and return an error only if that transaction rolled back. Otherwise a retry processes the event again.',
  accepted_delivery_processed: 'Do not answer 2xx before the event is saved. Save it (or put it on a durable queue) first, then acknowledge.',
  idempotent_processing: 'Record each PayPal event ID with a unique constraint and skip events you have already processed. Check and record inside the same transaction.',
  no_second_payment_in_app: 'Key payment records by PayPal\'s capture ID (unique), so a repeated webhook updates the existing record instead of adding one.',
  paypal_payment_unchanged: 'Check whether your handler calls PayPal (for example to capture) every time a webhook arrives. It should do so only once per order.',
  refund_events_within_captured: 'PayPal reports more refunded than captured. Check the Sandbox account activity in PayPal.',
  app_refunds_within_captured: 'Before recording a refund, compare it with the captured amount minus refunds already recorded, inside one transaction.',
  no_stale_overwrite: 'Compare event timestamps (or a state version) before changing a payment, and ignore events that are older than the state you already hold.',
  valid_state_transition: 'Encode the allowed payment states as a table and reject changes that are not in it (for example REFUNDED back to COMPLETED).',
};

module.exports = { evaluate, GUIDANCE, probeGate, CAPTURE_TRANSITIONS, ORDER_TRANSITIONS, RANK, familyOf };
