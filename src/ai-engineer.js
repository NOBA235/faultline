'use strict';
const { ApiError } = require('./errors');
const { LIMITS, KINDS } = require('./forwarder');
const { GUIDANCE } = require('./checks');
const { parseScenarioInput } = require('./scenarios');

// Catalog of the exact deterministic checks implemented in src/checks.js.
// The AI Test Engineer can reference these checks in test plans and explain their outcomes,
// but can never alter their logic or override their verdicts.
const KNOWN_CHECKS = {
  injection_integrity: {
    id: 'injection_integrity',
    name: 'Faultline sent the genuine event unchanged',
    category: 'integrity',
    requiresProbe: false,
    criterion: 'Every forwarded request carries the exact SHA-256 body and PayPal transmission ID of the stored verified event.',
  },
  deliveries_accepted: {
    id: 'deliveries_accepted',
    name: 'Your endpoint accepted every delivery',
    category: 'delivery',
    requiresProbe: false,
    criterion: 'The destination endpoint answers every forwarded delivery with an HTTP 2xx status code.',
  },
  failed_delivery_not_processed: {
    id: 'failed_delivery_not_processed',
    name: 'A failed delivery is not reported as processed',
    category: 'invariant',
    requiresProbe: true,
    criterion: 'When all deliveries fail (non-2xx, timeout, or network error), event.processed_count in the state probe does not increase.',
  },
  accepted_delivery_processed: {
    id: 'accepted_delivery_processed',
    name: 'An accepted delivery was actually processed',
    category: 'invariant',
    requiresProbe: true,
    criterion: 'When at least one delivery receives HTTP 2xx, event.processed_count in the state probe is at least 1 after settle time.',
  },
  idempotent_processing: {
    id: 'idempotent_processing',
    name: 'The same event is processed at most once',
    category: 'invariant',
    requiresProbe: true,
    criterion: 'Across duplicate or replayed deliveries of the same PayPal event ID, event.processed_count in the state probe never exceeds 1 (or the pre-run count if already processed).',
  },
  no_second_payment_in_app: {
    id: 'no_second_payment_in_app',
    name: 'A repeated webhook does not create a second payment record',
    category: 'invariant',
    requiresProbe: true,
    criterion: 'Repeated deliveries of the same capture or order event never increase payment.payment_records past 1 in the state probe.',
  },
  paypal_payment_unchanged: {
    id: 'paypal_payment_unchanged',
    name: 'No new capture appeared at PayPal during the test',
    category: 'platform',
    requiresProbe: false,
    criterion: 'When the event is linked to a Faultline Sandbox order, the number of captures on that order at PayPal does not increase during webhook delivery.',
  },
  refund_events_within_captured: {
    id: 'refund_events_within_captured',
    name: 'Refunds reported by PayPal do not exceed the captured amount',
    category: 'platform',
    requiresProbe: false,
    criterion: 'Verified PAYMENT.CAPTURE.REFUNDED events for the capture do not sum to more than the captured amount.',
  },
  app_refunds_within_captured: {
    id: 'app_refunds_within_captured',
    name: 'Refunds in your application do not exceed the captured amount',
    category: 'invariant',
    requiresProbe: true,
    criterion: 'payment.refunded_amount reported by the state probe does not exceed payment.captured_amount.',
  },
  no_stale_overwrite: {
    id: 'no_stale_overwrite',
    name: 'A late, older event does not overwrite newer payment state',
    category: 'invariant',
    requiresProbe: true,
    criterion: 'When an older event is delivered after a newer event for the same order or capture, payment.status in the state probe does not move backward to an earlier lifecycle state.',
  },
  valid_state_transition: {
    id: 'valid_state_transition',
    name: 'The payment only makes valid state changes',
    category: 'invariant',
    requiresProbe: true,
    criterion: 'payment.status in the state probe stays unchanged or makes a valid PayPal capture/order lifecycle transition.',
  },
};

const SCENARIO_LABELS = {
  forward: 'Forward once',
  duplicate: 'Duplicate delivery',
  delay: 'Delayed delivery',
  drop: 'Dropped delivery',
  replay: 'Replay delivery',
};

const WORD_NUMBERS = {
  one: 1, once: 1, single: 1,
  two: 2, twice: 2, double: 2,
  three: 3, thrice: 3, triple: 3,
  four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

// Detects requests that violate the Strict AI Rules (executing financial operations, fabricating events/verdicts, or revealing secrets).
function checkForbiddenIntent(text) {
  const s = text.trim();
  if (/\b(reveal|show|print|dump|leak|expose|decrypt|extract|read)\b.*\b(secret|password|token|credential|encryption[_\s-]?key|session[_\s-]?secret|client[_\s-]?secret)\b/i.test(s)) {
    return 'The AI Test Engineer has no access to PayPal secrets, encryption keys, or session tokens and cannot reveal credentials.';
  }
  if (/\b(override|bypass|ignore|force|change|alter|fake|fabricate|invent)\b.*\b(verdict|assertion|check|invariant|result|pass|passed)\b/i.test(s)) {
    return 'The AI Test Engineer cannot invent test results or override deterministic safety checks.';
  }
  if (/\b(fabricate|fake|forge|spoof|invent|synthesize|mock)\b.*\b(paypal\s+event|webhook|signature|delivery|capture|order|transaction)\b/i.test(s)) {
    return 'The AI Test Engineer cannot fabricate PayPal webhook events or transactions. Tests must use genuine PayPal-verified events stored in this project.';
  }
  const hasWebhookTerm = /\b(webhook|event|delivery|deliveries|duplicate|delay|delayed|drop|dropped|replay|replayed|forward|idempoten|handler|endpoint|notification|twice|retry|retries|stale|out[\s-]of[\s-]order)\b/i.test(s);
  if (!hasWebhookTerm && /\b(create|make|charge|capture|issue|send|execute|perform|transfer|withdraw)\b.*\b(order|payment|capture|refund|money|funds|payout|transaction|dollar|usd|eur|gbp)\b/i.test(s)) {
    return 'The AI Test Engineer cannot directly execute financial operations (creating orders, capturing payments, or issuing refunds). It only plans webhook delivery fault scenarios against your test endpoint.';
  }
  return null;
}

function parseDuplicateCount(text) {
  let m;
  if ((m = text.match(/\b(\d+)\s*(?:times|copies|deliveries|requests|duplicates|webhooks|events)\b/i))) return Number(m[1]);
  if ((m = text.match(/\bx(\d+)\b/i))) return Number(m[1]);
  if ((m = text.match(/\b(?:send|deliver|forward|repeat|duplicate)\s+(?:it\s+|the\s+\w+\s+)?(\d+)\b/i))) return Number(m[1]);
  for (const [word, n] of Object.entries(WORD_NUMBERS)) {
    if (n >= 2 && new RegExp(`\\b${word}(?:\\s+(?:times|copies|deliveries|requests|duplicates))?\\b`, 'i').test(text)) return n;
  }
  return 3;
}

function parseDelaySeconds(text) {
  let m;
  if ((m = text.match(/\b(\d+)\s*(?:m|min|mins|minute|minutes)\b/i))) return Number(m[1]) * 60;
  if ((m = text.match(/\b(\d+)\s*(?:s|sec|secs|second|seconds)\b/i))) return Number(m[1]);
  for (const [word, n] of Object.entries(WORD_NUMBERS)) {
    if (new RegExp(`\\b${word}\\s*(?:minute|minutes)\\b`, 'i').test(text)) return n * 60;
    if (new RegExp(`\\b${word}\\s*(?:second|seconds)\\b`, 'i').test(text)) return n;
  }
  return 10;
}

function detectEventType(text, kind) {
  const explicit = text.match(/\b(PAYMENT\.CAPTURE\.(?:COMPLETED|REFUNDED|DENIED|PENDING|REVERSED)|CHECKOUT\.ORDER\.(?:APPROVED|COMPLETED|VOIDED))\b/i);
  if (explicit) return explicit[1].toUpperCase();
  if (/\b(refund|refunded|over[\s-]?refund)\b/i.test(text)) return 'PAYMENT.CAPTURE.REFUNDED';
  if (/\b(order\s+approved|checkout\s+order\s+approved|approved\s+order|buyer\s+approv(?:ed|al))\b/i.test(text)) return 'CHECKOUT.ORDER.APPROVED';
  if (/\b(capture\s+denied|payment\s+denied|declined)\b/i.test(text)) return 'PAYMENT.CAPTURE.DENIED';
  if (/\b(capture\s+pending|pending\s+payment|pending\s+capture)\b/i.test(text)) return 'PAYMENT.CAPTURE.PENDING';
  if (/\b(order\s+completed|checkout\s+order\s+completed)\b/i.test(text)) return 'CHECKOUT.ORDER.COMPLETED';
  if (kind === 'delay' && /\b(older\s+event|stale|overwrite|regress|backwards?|earlier\s+state|out[\s-]of[\s-]order)\b/i.test(text) && !/\bcapture\b/i.test(text)) {
    return 'CHECKOUT.ORDER.APPROVED';
  }
  return 'PAYMENT.CAPTURE.COMPLETED';
}

function detectScenario(text) {
  const hasMultiCount = /\b(twice|double|thrice|triple|two\s+times|three\s+times|four\s+times|five\s+times|\d+\s*(?:times|copies|deliveries|duplicates)|x[2-9]|x10|multiple\s+(?:times|copies|deliveries)|several\s+(?:times|copies|deliveries))\b/i.test(text);
  const hasConcurrent = /\b(concurrent(?:ly)?|simultaneous(?:ly)?|at\s+the\s+same\s+time|all\s+at\s+once|parallel|race\s+condition)\b/i.test(text);
  const hasExplicitDuplicate = /\b(duplicate|duplicated|duplicating|copies)\b/i.test(text);

  if (/\b(drop|dropped|dropping|withhold|withheld|lose|lost|missing|never\s+arrives?|never\s+delivered|omit|suppress)\b/i.test(text)) {
    return { kind: 'drop', params: {} };
  }
  if (/\b(delay|delayed|delaying|hold|held|wait\s+\d+|late\s+delivery|arrive\s+late|out[\s-]of[\s-]order|stale\s+overwrite|older\s+event\s+after|after\s+\d+\s*(?:s|sec|seconds?|m|min|minutes?))\b/i.test(text)) {
    return { kind: 'delay', params: { delaySeconds: parseDelaySeconds(text) } };
  }
  if (!hasExplicitDuplicate && !hasConcurrent && /\b(replay|replayed|replaying|resend|re-send|send\s+again\s+later|previously\s+received|already[\s-]processed)\b/i.test(text)) {
    return { kind: 'replay', params: {} };
  }
  if (hasMultiCount || hasConcurrent || /\b(duplicate|duplicated|duplicating|repeat|repeated|repeating|idempoten(?:t|cy)|same\s+.*webhook\s+twice|more\s+than\s+once)\b/i.test(text)) {
    return {
      kind: 'duplicate',
      params: {
        count: parseDuplicateCount(text),
        mode: hasConcurrent ? 'concurrent' : 'sequential',
      },
    };
  }
  if (/\b(forward|deliver|send|webhook|event|payment|capture|order|handler|endpoint)\b/i.test(text)) {
    return { kind: 'forward', params: {} };
  }
  return null;
}

function selectAssertionsFor(kind, eventType) {
  const isPaymentFamily = /^(PAYMENT\.CAPTURE\.|CHECKOUT\.ORDER\.)/.test(eventType);
  const isRefund = eventType === 'PAYMENT.CAPTURE.REFUNDED';
  const ids = [];

  if (kind === 'drop') {
    if (isPaymentFamily) ids.push('valid_state_transition');
  } else {
    ids.push('injection_integrity', 'deliveries_accepted', 'accepted_delivery_processed', 'idempotent_processing');
    if (isPaymentFamily) ids.push('no_second_payment_in_app', 'valid_state_transition', 'paypal_payment_unchanged');
    if (kind === 'delay' && isPaymentFamily) ids.push('no_stale_overwrite');
    if (isRefund) ids.push('refund_events_within_captured', 'app_refunds_within_captured');
    ids.push('failed_delivery_not_processed');
  }
  return [...new Set(ids)].map((id) => ({ ...KNOWN_CHECKS[id], expectedVerdict: 'pass' }));
}

function buildFailureConditions(kind, params, eventType, probeConfigured) {
  const conds = [];
  if (kind !== 'drop') {
    conds.push('The destination endpoint returns a non-2xx HTTP status, a redirect, a timeout, or a connection error on any delivery attempt.');
  }
  if (kind === 'duplicate') {
    conds.push(`The destination processes the same PayPal event ID more than once (event.processed_count > 1 after ${params.count} ${params.mode} deliveries).`);
    conds.push('The destination creates more than one payment record (payment.payment_records > 1) for a single capture or order.');
  }
  if (kind === 'replay') {
    conds.push('Replaying the already-received event increments event.processed_count again or creates a duplicate payment record.');
  }
  if (kind === 'delay') {
    conds.push('Delivering an older event after a newer event for the same payment moves payment.status backward to an earlier state (stale overwrite).');
  }
  if (eventType === 'PAYMENT.CAPTURE.REFUNDED') {
    conds.push('payment.refunded_amount in the application exceeds payment.captured_amount.');
  }
  if (kind !== 'drop') {
    conds.push('The destination returns HTTP 2xx before durably recording the event (event.processed_count remains 0).');
    conds.push('The destination returns HTTP 5xx after committing the database write (event.processed_count increases despite the failed delivery).');
    conds.push('A new capture appears on the linked PayPal order while webhooks are being delivered.');
  } else {
    conds.push('Withholding the webhook causes the payment in the application to transition into an invalid lifecycle state.');
  }
  if (!probeConfigured) {
    conds.push('Note: No state probe is currently configured on this project. Without a probe, application-state checks will be marked "not_evaluable" and the overall run verdict will be "inconclusive" even if your endpoint returns HTTP 200.');
  }
  return conds;
}

// Converts a plain-English request into a structured test specification and matches it against stored verified events.
function planFromPrompt(prompt, ctx = {}) {
  if (typeof prompt !== 'string' || prompt.trim().length < 5) {
    throw new ApiError(400, 'invalid_prompt', 'Enter a plain-English description of the webhook reliability test you want to plan (at least 5 characters).');
  }
  if (prompt.length > 1000) {
    throw new ApiError(400, 'invalid_prompt', 'Keep the test request under 1,000 characters.');
  }
  const text = prompt.trim();
  const forbidden = checkForbiddenIntent(text);
  if (forbidden) {
    throw new ApiError(422, 'unsafe_request', forbidden);
  }

  const detected = detectScenario(text);
  if (!detected) {
    throw new ApiError(400, 'unrecognized_test_request', 'Could not identify a webhook failure scenario in that request. Describe a duplicate, delayed, dropped, replayed, or single forwarded webhook test (for example: "Test whether my application processes the same completed payment webhook twice").');
  }

  const { kind, params } = detected;
  const verifiedEvents = Array.isArray(ctx.verifiedEvents) ? ctx.verifiedEvents : [];
  const requestedIdMatch = text.match(/\b(WH-[A-Za-z0-9-]+)\b/);
  const requestedPaypalEventId = requestedIdMatch ? requestedIdMatch[1] : null;
  let eventType = detectEventType(text, kind);

  let matched = null;
  if (ctx.selectedEventId) {
    matched = verifiedEvents.find((e) => e.id === ctx.selectedEventId) || null;
    if (matched && matched.event_type) eventType = matched.event_type;
  }
  if (!matched && requestedPaypalEventId) {
    matched = verifiedEvents.find((e) => e.paypal_event_id === requestedPaypalEventId) || null;
    if (matched && matched.event_type) eventType = matched.event_type;
  }
  if (!matched) {
    matched = verifiedEvents.find((e) => e.event_type === eventType) || null;
  }

  const plannedAttempts = kind === 'duplicate' ? params.count : 1;
  const requestsToSend = kind === 'drop' ? 0 : plannedAttempts;

  const objectiveByKind = {
    duplicate: `Verify that the application processes a ${eventType} webhook at most once and creates no duplicate payment records when delivered ${params.count} times (${params.mode}).`,
    delay: `Verify that holding a ${eventType} webhook for ${params.delaySeconds} second(s) before delivery does not regress newer payment state or break signature/timestamp handling.`,
    drop: `Verify that intentionally withholding a ${eventType} webhook does not place the payment into an invalid state and document the missing-notification blind spot.`,
    replay: `Verify that replaying a previously received ${eventType} webhook is handled idempotently without reprocessing the event or creating a second payment.`,
    forward: `Verify that forwarding a genuine ${eventType} webhook once is accepted (HTTP 2xx) and durably processed into a valid payment state.`,
  };

  const expectedByKind = {
    duplicate: `The endpoint answers HTTP 2xx on all ${params.count} deliveries, records the PayPal event ID once (event.processed_count = 1), keeps payment.payment_records at 1, and triggers no additional PayPal capture.`,
    delay: `After the ${params.delaySeconds}-second delay, the endpoint either processes the event once (if no newer state exists) or ignores it if a newer event was already applied, keeping payment.status valid.`,
    drop: 'No HTTP request is sent to the destination. Existing payment state remains valid, and the application relies on order/capture status reconciliation if a webhook never arrives.',
    replay: 'The endpoint recognizes the replayed PayPal event ID (or rejects stale transmission timestamps), leaves event.processed_count and payment.payment_records unchanged, and creates no new payment.',
    forward: 'The endpoint verifies PayPal signature headers, persists the event in a single transaction, answers HTTP 2xx, and reports event.processed_count = 1.',
  };

  const spec = {
    specVersion: 1,
    prompt: text,
    objective: objectiveByKind[kind],
    requiredSourceEvent: {
      eventType,
      paypalEventId: requestedPaypalEventId || (matched ? matched.paypal_event_id : null),
      verificationRequired: 'verified',
      description: `A genuine PayPal Sandbox ${eventType} webhook verified by PayPal's signature verification API.`,
      matchedEvent: matched ? {
        id: matched.id,
        paypalEventId: matched.paypal_event_id,
        eventType: matched.event_type,
        resourceId: matched.resource_id,
        receivedAt: matched.first_received_at,
      } : null,
      availabilityNote: matched
        ? `Matched stored verified event ${matched.paypal_event_id || matched.id} (received ${matched.first_received_at}).`
        : verifiedEvents.length
          ? `No verified ${eventType} event is stored yet (${verifiedEvents.length} other verified event(s) exist in this project). Select an existing verified event or receive a ${eventType} webhook from PayPal Sandbox before running.`
          : 'No PayPal-verified webhook events are stored in this project yet. Receive a real webhook from PayPal Sandbox before executing this plan.',
    },
    scenario: {
      kind,
      label: SCENARIO_LABELS[kind],
      params,
    },
    plannedAttempts,
    requestsToSend,
    expectedBehavior: expectedByKind[kind],
    assertions: selectAssertionsFor(kind, eventType),
    failureConditions: buildFailureConditions(kind, params, eventType, Boolean(ctx.probeConfigured)),
    financialOperationsAllowed: false,
    safetyNotice: 'Executing this plan only forwards or withholds a stored PayPal-verified webhook to your configured test endpoint. It never creates, captures, or refunds a PayPal payment, and deterministic checks alone decide the verdict.',
  };

  const validation = validateTestSpec(spec);
  return { spec, validation, matchedEventId: matched ? matched.id : null };
}

// Validates a structured test specification before storage and again before execution.
function validateTestSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return { valid: false, errors: ['The test specification must be a JSON object.'] };
  }
  if (typeof spec.objective !== 'string' || !spec.objective.trim()) {
    errors.push('Test objective is missing.');
  }
  if (!spec.requiredSourceEvent || typeof spec.requiredSourceEvent !== 'object' || typeof spec.requiredSourceEvent.eventType !== 'string' || !spec.requiredSourceEvent.eventType.trim()) {
    errors.push('Required source event type is missing.');
  }
  if (!spec.requiredSourceEvent || spec.requiredSourceEvent.verificationRequired !== 'verified') {
    errors.push('Required source event must require PayPal signature verification ("verified").');
  }
  if (spec.financialOperationsAllowed !== false) {
    errors.push('Test specifications must explicitly forbid direct financial operations (financialOperationsAllowed must be false).');
  }
  if (!spec.scenario || typeof spec.scenario !== 'object' || !KINDS.includes(spec.scenario.kind)) {
    errors.push(`Scenario kind must be one of: ${KINDS.join(', ')}.`);
  } else {
    try {
      parseScenarioInput({ kind: spec.scenario.kind, ...(spec.scenario.params || {}) });
    } catch (err) {
      if (err && err.fields) {
        for (const [k, msg] of Object.entries(err.fields)) errors.push(`Scenario parameter "${k}": ${msg}`);
      } else {
        errors.push((err && err.message) || 'Scenario parameters are invalid.');
      }
    }
    const expectedAttempts = spec.scenario.kind === 'duplicate' ? (spec.scenario.params && spec.scenario.params.count) : 1;
    if (!Number.isInteger(spec.plannedAttempts) || spec.plannedAttempts !== expectedAttempts) {
      errors.push(`plannedAttempts (${spec.plannedAttempts}) must match the scenario's delivery count (${expectedAttempts}).`);
    }
  }
  if (typeof spec.expectedBehavior !== 'string' || !spec.expectedBehavior.trim()) {
    errors.push('Expected behavior description is missing.');
  }
  if (!Array.isArray(spec.assertions) || spec.assertions.length === 0) {
    errors.push('At least one deterministic assertion is required.');
  } else {
    for (const a of spec.assertions) {
      if (!a || typeof a.id !== 'string' || !KNOWN_CHECKS[a.id]) {
        errors.push(`Unknown or non-deterministic assertion ID "${a && a.id}". Only checks in src/checks.js are allowed.`);
      }
    }
  }
  if (!Array.isArray(spec.failureConditions) || spec.failureConditions.length === 0) {
    errors.push('Potential failure conditions must be listed.');
  }
  return { valid: errors.length === 0, errors };
}

// Evidence-based failure analysis. Uses ONLY the execution trace, response statuses, probe/PayPal snapshots, and deterministic assertions.
function analyzeRun(trace) {
  if (!trace || !trace.run || !trace.event) {
    throw new ApiError(400, 'missing_trace', 'Cannot analyze a scenario run without its execution trace.');
  }
  const { run, event, attempts = [], assertions = [], snapshots = [], probeConfigured = false } = trace;
  if (!['completed', 'failed', 'cancelled'].includes(run.status)) {
    throw new ApiError(409, 'run_not_finished', 'This scenario has not finished yet. Wait for it to finish before analyzing the execution trace.');
  }

  const sent = attempts.filter((a) => !['dropped', 'blocked'].includes(a.outcome));
  const accepted = sent.filter((a) => a.outcome === 'delivered');
  const rejected = sent.filter((a) => ['http_error', 'redirect_not_followed'].includes(a.outcome));
  const netFailed = sent.filter((a) => ['timeout', 'network_error'].includes(a.outcome));
  const dropped = attempts.filter((a) => a.outcome === 'dropped');
  const blocked = attempts.filter((a) => a.outcome === 'blocked');

  const failedChecks = assertions.filter((a) => a.verdict === 'fail');
  const passedChecks = assertions.filter((a) => a.verdict === 'pass');
  const notEvaluable = assertions.filter((a) => a.verdict === 'not_evaluable');
  const invariantPassed = passedChecks.filter((a) => a.category === 'invariant');

  const probeBefore = snapshots.find((s) => s.source === 'probe' && s.phase === 'before') || null;
  const probeAfter = snapshots.find((s) => s.source === 'probe' && s.phase === 'after') || null;
  const paypalBefore = snapshots.find((s) => s.source === 'paypal' && s.phase === 'before') || null;
  const paypalAfter = snapshots.find((s) => s.source === 'paypal' && s.phase === 'after') || null;

  // ---- Directly observed facts (strictly from the stored trace) -----------
  const observations = [];
  observations.push(`Scenario "${run.label}" (${run.kind}) ran on verified event ${event.paypalEventId || event.id} (${event.eventType || 'unknown type'}) targeting ${run.destination}.`);
  observations.push(`Run status: ${run.status}. Deterministic verdict: ${run.verdict || 'none'}${run.verdictReason ? ` (${run.verdictReason})` : ''}.`);

  if (dropped.length) {
    observations.push('Faultline deliberately withheld the webhook event (0 HTTP requests sent to destination).');
  }
  if (blocked.length) {
    observations.push(`Delivery was blocked before sending: ${blocked[0].errorText || run.errorText}.`);
  }
  for (const a of sent) {
    const statusText = a.httpStatus ? `HTTP ${a.httpStatus}` : a.outcome;
    const snip = a.responseSnippet ? ` — reply snippet: "${a.responseSnippet.slice(0, 120)}"` : (a.errorText ? ` — ${a.errorText}` : '');
    observations.push(`Attempt ${a.attemptNo}/${run.plannedAttempts} (${a.deliveryKind}): ${statusText} in ${a.durationMs} ms at ${a.sentAt}${snip}.`);
  }
  if (probeBefore || probeAfter) {
    const fmtProbe = (s) => {
      if (!s) return 'not read';
      if (s.outcome !== 'ok') return `error (${s.errorText || 'unreachable'})`;
      const d = s.data || {};
      const parts = [];
      if (d.processedCount !== null && d.processedCount !== undefined) parts.push(`processed_count=${d.processedCount}`);
      if (d.status) parts.push(`status=${d.status}`);
      if (d.paymentRecords !== null && d.paymentRecords !== undefined) parts.push(`payment_records=${d.paymentRecords}`);
      if (d.capturedCents !== null && d.capturedCents !== undefined) parts.push(`captured=${(d.capturedCents / 100).toFixed(2)}`);
      if (d.refundedCents !== null && d.refundedCents !== undefined) parts.push(`refunded=${(d.refundedCents / 100).toFixed(2)}`);
      return parts.length ? parts.join(', ') : 'empty JSON object';
    };
    observations.push(`State probe before run: ${fmtProbe(probeBefore)}; after run: ${fmtProbe(probeAfter)}.`);
  } else {
    observations.push('No state probe snapshots were recorded for this run (no probe URL was configured).');
  }
  if (paypalBefore || paypalAfter) {
    const fmtPp = (s) => (!s ? 'not read' : s.outcome !== 'ok' ? `error (${s.errorText})` : `orderStatus=${s.data.orderStatus}, captureCount=${s.data.captureCount}`);
    observations.push(`PayPal order snapshot before run: ${fmtPp(paypalBefore)}; after run: ${fmtPp(paypalAfter)}.`);
  }
  for (const f of failedChecks) {
    observations.push(`Failed check "${f.name}" (${f.id}): ${f.summary}`);
  }

  // ---- Detect mixed attempt behavior (e.g. HTTP 500 on first, HTTP 200 on retry) ---
  let mixedSequenceNote = null;
  if (sent.length >= 2) {
    const first = sent[0];
    const laterAccepted = sent.slice(1).find((a) => a.outcome === 'delivered');
    const laterFailed = sent.slice(1).find((a) => a.outcome !== 'delivered');
    if (first.outcome !== 'delivered' && laterAccepted) {
      const firstLabel = first.httpStatus ? `HTTP ${first.httpStatus}` : first.outcome;
      mixedSequenceNote = `The destination returned ${firstLabel} on the first delivery and HTTP ${laterAccepted.httpStatus} on attempt ${laterAccepted.attemptNo} (retry/duplicate). The available evidence suggests that the handler failed during initial processing. Inspect whether your webhook handler safely retries partially completed database operations.`;
    } else if (first.outcome === 'delivered' && laterFailed) {
      const failLabel = laterFailed.httpStatus ? `HTTP ${laterFailed.httpStatus}` : laterFailed.outcome;
      mixedSequenceNote = `The destination returned HTTP ${first.httpStatus} on the first delivery and ${failLabel} on attempt ${laterFailed.attemptNo}. This pattern indicates that repeated delivery of the same event triggered an unhandled error (such as an uncaught unique-constraint violation) instead of a clean idempotent 2xx response.`;
    }
  }

  // ---- What happened / expected / actually happened ----------------------
  const whatHappened = dropped.length
    ? `Faultline executed "${run.label}" on event ${event.paypalEventId || event.id} (${event.eventType}) and intentionally withheld the webhook from ${run.destination}. The deterministic verdict is "${run.verdict || 'inconclusive'}".`
    : blocked.length
      ? `Faultline blocked "${run.label}" on event ${event.paypalEventId || event.id} because ${blocked[0].errorText}`
      : run.status === 'cancelled'
        ? `The scheduled "${run.label}" run on event ${event.paypalEventId || event.id} was cancelled before any request was sent to ${run.destination}.`
        : `Faultline executed "${run.label}" on event ${event.paypalEventId || event.id} (${event.eventType}), sending ${sent.length} of ${run.plannedAttempts} planned delivery attempt(s) to ${run.destination}. ${accepted.length} succeeded with HTTP 2xx, ${rejected.length} returned non-2xx HTTP responses, and ${netFailed.length} failed at the network/timeout layer. The deterministic verdict is "${run.verdict || 'inconclusive'}".`;

  const whatWasExpected = run.kind === 'duplicate'
    ? `Across all ${run.plannedAttempts} deliveries of ${event.paypalEventId || 'the same event'}, the destination should return HTTP 2xx, process the event at most once (event.processed_count = 1), maintain at most one payment record (payment.payment_records = 1), and keep payment state consistent.`
    : run.kind === 'delay'
      ? `When ${event.paypalEventId || 'the event'} arrives after the configured delay, the destination should either process it once or ignore it if a newer event for the same payment was already applied (never regressing payment.status backward).`
      : run.kind === 'drop'
        ? `When ${event.paypalEventId || 'the event'} is intentionally dropped, the application must not transition into an invalid payment state, and should rely on querying PayPal's Orders/Captures API to reconcile missing webhook notifications.`
        : run.kind === 'replay'
          ? `When ${event.paypalEventId || 'the previously received event'} is replayed, the destination should recognize the event ID as already processed (or reject stale timestamps intentionally) without incrementing processed_count or creating a second payment record.`
          : `When ${event.paypalEventId || 'the event'} is forwarded once, the destination should verify the PayPal signature headers, durably record the event and payment state in one transaction, and return HTTP 2xx.`;

  const actualParts = [];
  if (mixedSequenceNote) actualParts.push(mixedSequenceNote);
  else if (sent.length) {
    actualParts.push(`Sent ${sent.length} request(s): ${sent.map((a) => `attempt ${a.attemptNo} (${a.deliveryKind}) -> ${a.httpStatus ? `HTTP ${a.httpStatus}` : a.outcome} (${a.durationMs} ms)`).join('; ')}.`);
  } else if (dropped.length) {
    actualParts.push('No request was sent because the scenario intentionally dropped the delivery.');
  } else if (blocked.length) {
    actualParts.push(`Delivery was blocked: ${blocked[0].errorText}`);
  }
  if (probeBefore && probeAfter && probeBefore.outcome === 'ok' && probeAfter.outcome === 'ok') {
    const b = probeBefore.data; const a = probeAfter.data;
    actualParts.push(`Your state probe reported event.processed_count changing from ${b.processedCount ?? 'unreported'} to ${a.processedCount ?? 'unreported'}, payment.status from ${b.status ?? 'unreported'} to ${a.status ?? 'unreported'}, and payment.payment_records from ${b.paymentRecords ?? 'unreported'} to ${a.paymentRecords ?? 'unreported'}.`);
  } else if (!probeConfigured) {
    actualParts.push('No state probe was configured, so Faultline could only observe HTTP responses and could not inspect your application\'s internal database state.');
  } else if ((probeBefore && probeBefore.outcome !== 'ok') || (probeAfter && probeAfter.outcome !== 'ok')) {
    const badSnap = [probeBefore, probeAfter].find((s) => s && s.outcome !== 'ok');
    actualParts.push(`The state probe could not be read cleanly: ${badSnap.errorText}`);
  }
  if (failedChecks.length) {
    actualParts.push(`${failedChecks.length} deterministic check(s) failed: ${failedChecks.map((f) => `${f.name} (${f.summary})`).join(' ')}`);
  } else if (run.verdict === 'passed') {
    actualParts.push(`All ${passedChecks.length}applicable deterministic checks (${invariantPassed.length} on your application's state) passed.`);
  } else {
    actualParts.push(`No deterministic check failed, but ${notEvaluable.length} check(s) were not evaluable, making the run inconclusive.`);
  }
  const whatActuallyHappened = actualParts.join(' ');

  // ---- Where failure occurred, why it matters, investigation & remediation --
  let whereFailureOccurred;
  let whyItMatters;
  const investigateList = [];
  const remediationList = [];

  if (failedChecks.length > 0) {
    const locations = [];
    const reasons = [];
    for (const f of failedChecks) {
      if (f.id === 'idempotent_processing') {
        locations.push('Webhook idempotency layer (duplicate event ID was processed multiple times)');
        reasons.push('When PayPal retries a webhook due to network jitter or slow responses, processing the same event ID more than once can double-credit orders, trigger duplicate fulfillment, or corrupt accounting ledgers.');
        investigateList.push(`Check how your webhook handler records ${event.paypalEventId || 'paypal_event_id'} and whether the deduplication check and state update happen inside a single atomic database transaction.`);
      } else if (f.id === 'no_second_payment_in_app') {
        locations.push('Payment persistence layer (multiple payment records created for one capture/order)');
        reasons.push('A repeated webhook is not a repeated payment. Creating multiple payment rows for the same PayPal capture ID inflates revenue records and can allow multiple refunds against one capture.');
        investigateList.push(`Inspect the database schema and insert logic for payment records tied to resource ID ${event.resourceId || '(capture/order ID)'} to see why a second row was inserted instead of updating or skipping the existing one.`);
      } else if (f.id === 'failed_delivery_not_processed') {
        locations.push('Webhook transaction boundary (state committed before returning HTTP error)');
        reasons.push('Returning HTTP 5xx or timing out tells PayPal the delivery failed, so PayPal will retry it. Because your handler already committed the state change, the retry risks processing the payment a second time.');
        investigateList.push('Inspect your webhook route error handling to find where database writes are committed before the HTTP response completes or outside a rollback-capable transaction.');
      } else if (f.id === 'accepted_delivery_processed') {
        locations.push('Webhook acknowledgement ordering (HTTP 2xx returned without recorded processing)');
        reasons.push('Once your endpoint returns HTTP 2xx, PayPal marks the webhook as delivered and will not retry it. If the event was dropped in memory or failed silently in a background worker, the payment update is permanently lost.');
        investigateList.push('Check whether your webhook handler returns 200 OK before awaiting the database write, or whether an asynchronous queue consumer takes longer than PROBE_SETTLE_MS to commit.');
      } else if (f.id === 'no_stale_overwrite') {
        locations.push('Payment state machine / event ordering guard (older event overwrote newer state)');
        reasons.push('Webhooks can arrive out of order. Allowing a delayed CHECKOUT.ORDER.APPROVED event to overwrite a COMPLETED capture reverts a paid order back to an uncaptured state.');
        investigateList.push('Inspect how your handler updates payment.status and whether it compares event create_time or enforces forward-only state rank before writing.');
      } else if (f.id === 'valid_state_transition') {
        locations.push('Payment lifecycle state machine (invalid state transition)');
        reasons.push('Transitioning a payment into an illegal lifecycle state (such as REFUNDED back to COMPLETED) breaks downstream order fulfillment and financial reporting.');
        investigateList.push('Inspect the state transition logic in your payment model and verify that terminal states (COMPLETED, REFUNDED, VOIDED, DECLINED) cannot regress.');
      } else if (f.id === 'app_refunds_within_captured' || f.id === 'refund_events_within_captured') {
        locations.push('Refund accounting validation (total refunded exceeded captured amount)');
        reasons.push('Recording more in refunds than the original captured amount leads to direct financial loss and reconciliation mismatches.');
        investigateList.push('Inspect how your refund webhook handler accumulates refunded_amount and whether it deduplicates refund IDs and checks against captured_amount.');
      } else if (f.id === 'paypal_payment_unchanged') {
        locations.push('Outbound PayPal API usage inside webhook handler (new capture created during webhook test)');
        reasons.push('Replaying or duplicating a webhook must never trigger a new capture call to PayPal.');
        investigateList.push('Check whether your webhook handler calls POST /v2/checkout/orders/{id}/capture without checking if the order was already captured.');
      } else if (f.id === 'deliveries_accepted') {
        locations.push(`HTTP webhook endpoint (${run.destination} rejected or failed delivery)`);
        reasons.push('Non-2xx responses, redirects, timeouts, or connection failures cause PayPal to mark the webhook delivery as failed and schedule repeated retries.');
        if (mixedSequenceNote) {
          investigateList.push(mixedSequenceNote);
        } else {
          investigateList.push(`Inspect your application logs for ${run.destination} around ${sent[0] ? sent[0].sentAt : run.startedAt} to see why it returned ${sent.map((a) => a.httpStatus ?? a.outcome).join(', ')}.`);
        }
      } else if (f.id === 'injection_integrity') {
        locations.push('Faultline forwarding integrity check');
        reasons.push('The forwarded payload or transmission header did not match the stored raw event, so the test run cannot be trusted.');
        investigateList.push('Re-run the scenario and verify that the stored webhook_events row was not modified.');
      }
      if (GUIDANCE[f.id]) remediationList.push(GUIDANCE[f.id]);
    }
    whereFailureOccurred = locations.join('; ');
    whyItMatters = reasons.join(' ');
  } else if (blocked.length || run.status === 'cancelled') {
    whereFailureOccurred = blocked.length ? 'Scenario pre-flight guard (destination URL blocked)' : 'Scenario cancelled by user before delivery';
    whyItMatters = 'No webhook was delivered to your application, so application behavior was not tested in this run.';
    investigateList.push(blocked.length ? 'Update the project webhook endpoint URL so it points to your application rather than Faultline\'s own webhook receiver.' : 'Re-run the scenario and allow the delay timer to complete.');
    remediationList.push(blocked.length ? 'Point the project\'s webhook destination URL at your application\'s test server.' : 'Start a new scenario run when ready.');
  } else if (run.verdict === 'inconclusive') {
    whereFailureOccurred = 'No check failed, but internal application state could not be verified (observability gap).';
    whyItMatters = 'An HTTP 200 response only proves that your HTTP server answered the request. Without state probe evidence, a bug that processes the same payment twice, drops the event after replying 200, or regresses payment status goes undetected.';
    if (!probeConfigured) {
      investigateList.push('Configure a test-only State Probe URL on this project so Faultline can read event.processed_count, payment.status, and payment.payment_records before and after each scenario.');
      remediationList.push('Add a GET state probe endpoint to your test application (see the State probe panel for the exact JSON shape) and re-run this scenario.');
    } else {
      for (const ne of notEvaluable) {
        investigateList.push(`${ne.name}: ${ne.summary}`);
      }
      remediationList.push('Ensure your state probe endpoint is reachable and returns all required fields (event.processed_count, payment.status, payment.payment_records, payment.captured_amount, payment.refunded_amount), then re-run the scenario.');
    }
  } else {
    whereFailureOccurred = 'None — all evaluated delivery, integrity, and application-state checks passed.';
    whyItMatters = `The available evidence from Faultline's HTTP trace and your state probe confirms that your handler survived "${run.label}" on ${event.eventType} without violating any evaluated invariant.`;
    investigateList.push(notEvaluable.length
      ? `${notEvaluable.length} check(s) were not evaluable in this run (${notEvaluable.map((n) => n.name).join(', ')}). Check whether additional probe fields or scenarios are needed.`
      : 'Consider testing additional failure modes (such as concurrent duplicates or out-of-order delayed delivery) if not yet covered.');
    remediationList.push('No code changes required for the checks that passed in this run.');
  }

  // ---- Assumptions & Insufficient Evidence flags (Strict AI Rules) ---------
  const assumptions = [];
  if (!probeConfigured) {
    assumptions.push('No state probe is configured: Faultline makes zero assumptions about your application\'s internal database state and therefore marks internal invariants as "not_evaluable" rather than "pass".');
  } else {
    assumptions.push('Relies on your configured state probe accurately reporting committed database state for the queried event_id and resource_id.');
    assumptions.push(`Assumes any asynchronous webhook processing settled within PROBE_SETTLE_MS (${trace.probeSettleMs ?? 500} ms) after the final delivery.`);
  }
  if (run.kind === 'drop') {
    assumptions.push('Whether your application detects a dropped webhook via background polling or PayPal order lookup cannot be observed from a single drop action.');
  }

  const insufficientEvidence = run.verdict === 'inconclusive' || !probeConfigured || notEvaluable.length > 0 || blocked.length > 0 || run.status === 'cancelled';
  let insufficientReason = null;
  if (!probeConfigured) {
    insufficientReason = 'Insufficient evidence to verify internal financial invariants: no state probe is configured for this project, so only HTTP delivery status could be observed.';
  } else if ((probeBefore && probeBefore.outcome !== 'ok') || (probeAfter && probeAfter.outcome !== 'ok')) {
    const errSnap = [probeBefore, probeAfter].find((s) => s && s.outcome !== 'ok');
    insufficientReason = `Insufficient evidence from state probe: ${errSnap.errorText}`;
  } else if (notEvaluable.length > 0) {
    insufficientReason = `${notEvaluable.length} check(s) lacked required evidence: ${notEvaluable.map((n) => `${n.name} (${n.summary})`).join(' ')}`;
  } else if (run.verdict === 'inconclusive') {
    insufficientReason = run.verdictReason || 'The scenario did not produce enough application-state evidence to reach a pass or fail verdict.';
  }

  return {
    analysisVersion: 1,
    runId: run.id,
    deterministicVerdict: {
      status: run.verdict || 'not_evaluated',
      reason: run.verdictReason || 'No deterministic verdict recorded.',
      canOverride: false,
      notice: 'This verdict comes solely from Faultline\'s deterministic checks. The AI Test Engineer cannot alter or override it.',
    },
    insufficientEvidence,
    insufficientReason,
    whatHappened,
    whatWasExpected,
    whatActuallyHappened,
    whereFailureOccurred,
    whyItMatters,
    whatToInvestigate: investigateList.join(' '),
    remediation: [...new Set(remediationList)].join(' '),
    observations,
    assumptions,
    recommendations: [...new Set([...remediationList, ...investigateList])],
  };
}

// Ensures any external LLM analysis strictly preserves the ground-truth deterministic verdict, observations, and insufficient-evidence flags.
function enforceAnalysisGuardrails(candidate, trace) {
  const baseline = analyzeRun(trace);
  if (!candidate || typeof candidate !== 'object') return baseline;
  const pickStr = (v, fallback) => (typeof v === 'string' && v.trim().length >= 10 ? v.trim().slice(0, 2000) : fallback);
  return {
    ...baseline,
    // Lock deterministic verdict, observations, assumptions, and insufficientEvidence to ground truth:
    deterministicVerdict: baseline.deterministicVerdict,
    insufficientEvidence: baseline.insufficientEvidence,
    insufficientReason: baseline.insufficientReason,
    observations: baseline.observations,
    assumptions: baseline.assumptions,
    whatHappened: baseline.whatHappened,
    whatActuallyHappened: baseline.whatActuallyHappened,
    whatWasExpected: pickStr(candidate.whatWasExpected, baseline.whatWasExpected),
    whereFailureOccurred: pickStr(candidate.whereFailureOccurred, baseline.whereFailureOccurred),
    whyItMatters: pickStr(candidate.whyItMatters, baseline.whyItMatters),
    whatToInvestigate: pickStr(candidate.whatToInvestigate, baseline.whatToInvestigate),
    remediation: pickStr(candidate.remediation, baseline.remediation),
  };
}

// Recommends specific additional tests based ONLY on the project's actual stored events, runs, and check outcomes.
function suggestTests(evidence) {
  const {
    project = {},
    verifiedEvents = [],
    unverifiedEvents = [],
    runs = [],
    failedAssertions = [],
    neverEvaluatedChecks = [],
  } = evidence || {};

  const suggestions = [];
  const push = (s) => {
    const v = validateTestSpec({
      objective: s.title,
      requiredSourceEvent: { eventType: s.eventType, verificationRequired: 'verified' },
      scenario: s.scenario,
      plannedAttempts: s.scenario.kind === 'duplicate' ? s.scenario.params.count : 1,
      expectedBehavior: s.rationale,
      assertions: s.targetChecks.map((id) => ({ id })),
      failureConditions: ['Check fails'],
      financialOperationsAllowed: false,
    });
    if (v.valid) suggestions.push(s);
  };

  if (verifiedEvents.length === 0) {
    const reasons = ['No PayPal-verified webhook events are stored in this project yet.'];
    if (!project.paypalWebhookId) {
      reasons.push('This project does not have a PayPal Webhook ID configured yet, so incoming webhooks cannot be verified.');
    }
    if (unverifiedEvents.length > 0) {
      reasons.push(`${unverifiedEvents.length} unverified/failed event(s) are stored (${unverifiedEvents.slice(0, 3).map((e) => e.paypal_event_id || e.id).join(', ')}). Once you save your PayPal Webhook ID, use "Verify again" in the Event Explorer if they came from real Sandbox transactions.`);
    }
    return {
      insufficientEvidence: true,
      summary: reasons.join(' '),
      basedOnCounts: {
        verifiedEvents: 0,
        unverifiedEvents: unverifiedEvents.length,
        scenarioRuns: runs.length,
        failedChecks: failedAssertions.length,
      },
      suggestions: [],
    };
  }

  // Group previous runs by event_id
  const runsByEvent = new Map();
  for (const r of runs) {
    if (!runsByEvent.has(r.event_id)) runsByEvent.set(r.event_id, []);
    runsByEvent.get(r.event_id).push(r);
  }

  // 1. Follow up on specific failed checks observed in previous runs
  for (const fa of failedAssertions) {
    const ev = verifiedEvents.find((e) => e.id === fa.event_id) || verifiedEvents[0];
    if (!ev) continue;
    if (fa.check_id === 'failed_delivery_not_processed' || fa.check_id === 'deliveries_accepted') {
      push({
        id: `followup-replay-${ev.id}-${fa.check_id}`,
        priority: 'high',
        title: `Replay ${ev.event_type || 'event'} (${ev.paypal_event_id}) after failed delivery`,
        rationale: `Check "${fa.name}" failed in run ${fa.run_id.slice(0, 8)} (${fa.summary}). PayPal automatically retries failed webhook deliveries, so replay this exact event to verify whether the retry succeeds without double-processing.`,
        basedOn: [
          `Failed check "${fa.name}" on event ${ev.paypal_event_id}: ${fa.summary}`,
          `Stored verified event ${ev.paypal_event_id} (${ev.event_type})`,
        ],
        eventId: ev.id,
        paypalEventId: ev.paypal_event_id,
        eventType: ev.event_type || 'PAYMENT.CAPTURE.COMPLETED',
        scenario: { kind: 'replay', label: 'Replay delivery', params: {} },
        targetChecks: ['deliveries_accepted', 'idempotent_processing', 'accepted_delivery_processed', 'no_second_payment_in_app'],
      });
    } else if (fa.check_id === 'idempotent_processing' || fa.check_id === 'no_second_payment_in_app') {
      push({
        id: `followup-dup-${ev.id}-${fa.check_id}`,
        priority: 'high',
        title: `Re-test duplicate delivery on ${ev.event_type || 'event'} (${ev.paypal_event_id})`,
        rationale: `Check "${fa.name}" failed in run ${fa.run_id.slice(0, 8)} (${fa.summary}). After adding an idempotency guard keyed by PayPal event ID and capture ID, re-run 3 duplicate deliveries on this event to confirm the fix.`,
        basedOn: [
          `Failed check "${fa.name}" in run ${fa.run_id.slice(0, 8)}: ${fa.summary}`,
          `Stored verified event ${ev.paypal_event_id} (${ev.event_type})`,
        ],
        eventId: ev.id,
        paypalEventId: ev.paypal_event_id,
        eventType: ev.event_type || 'PAYMENT.CAPTURE.COMPLETED',
        scenario: { kind: 'duplicate', label: 'Duplicate delivery', params: { count: 3, mode: 'sequential' } },
        targetChecks: ['idempotent_processing', 'no_second_payment_in_app', 'deliveries_accepted', 'injection_integrity'],
      });
    }
  }

  // 2. Check for out-of-order / stale-overwrite pairs (two verified events for the same order or resource with different timestamps)
  for (let i = 0; i < verifiedEvents.length; i++) {
    for (let j = i + 1; j < verifiedEvents.length; j++) {
      const a = verifiedEvents[i];
      const b = verifiedEvents[j];
      const samePayment = (a.related_order_id && a.related_order_id === b.related_order_id)
        || (a.resource_id && a.resource_id === b.resource_id);
      if (!samePayment || !a.paypal_event_created_at || !b.paypal_event_created_at || a.paypal_event_created_at === b.paypal_event_created_at) continue;
      const [older, newer] = a.paypal_event_created_at < b.paypal_event_created_at ? [a, b] : [b, a];
      const olderRuns = runsByEvent.get(older.id) || [];
      const hasDelayRun = olderRuns.some((r) => r.kind === 'delay');
      if (!hasDelayRun) {
        push({
          id: `stale-overwrite-${older.id}-after-${newer.id}`,
          priority: 'high',
          title: `Test stale-event overwrite: delay older ${older.event_type} (${older.paypal_event_id}) after newer ${newer.event_type}`,
          rationale: `This project has two verified events for the same payment: an older ${older.event_type} (${older.paypal_event_id}, created ${older.paypal_event_created_at}) and a newer ${newer.event_type} (${newer.paypal_event_id}, created ${newer.paypal_event_created_at}). Forward the newer event first, then run Delayed delivery on ${older.paypal_event_id} to verify that the older event does not overwrite the newer payment state.`,
          basedOn: [
            `Older verified event ${older.paypal_event_id} (${older.event_type}, created ${older.paypal_event_created_at})`,
            `Newer verified event ${newer.paypal_event_id} (${newer.event_type}, created ${newer.paypal_event_created_at})`,
          ],
          eventId: older.id,
          paypalEventId: older.paypal_event_id,
          eventType: older.event_type || 'CHECKOUT.ORDER.APPROVED',
          scenario: { kind: 'delay', label: 'Delayed delivery', params: { delaySeconds: 5 } },
          targetChecks: ['no_stale_overwrite', 'valid_state_transition', 'idempotent_processing'],
        });
      }
    }
  }

  // 3. Per-event coverage gaps (sequential duplicates, concurrent duplicates, replay, delay, drop)
  for (const ev of verifiedEvents.slice(0, 5)) {
    const evRuns = runsByEvent.get(ev.id) || [];
    const hasSeqDup = evRuns.some((r) => r.kind === 'duplicate' && (!r.params || r.params.mode !== 'concurrent'));
    const hasConcDup = evRuns.some((r) => r.kind === 'duplicate' && r.params && r.params.mode === 'concurrent');
    const hasForwarded = evRuns.some((r) => ['forward', 'duplicate', 'delay'].includes(r.kind) && r.status === 'completed');
    const hasReplay = evRuns.some((r) => r.kind === 'replay');
    const hasDelay = evRuns.some((r) => r.kind === 'delay');

    if (!hasSeqDup) {
      push({
        id: `gap-seq-dup-${ev.id}`,
        priority: 'high',
        title: `Run sequential duplicate delivery (x3) on ${ev.event_type || 'event'} (${ev.paypal_event_id})`,
        rationale: `Event ${ev.paypal_event_id} (${ev.event_type}) has not been tested with duplicate deliveries yet (${evRuns.length} run(s) so far). Sending 3 sequential copies tests whether your handler is idempotent when PayPal redelivers the same notification.`,
        basedOn: [
          `Stored verified event ${ev.paypal_event_id} (${ev.event_type}, resource ${ev.resource_id || 'n/a'})`,
          `No duplicate-delivery scenario has been run on ${ev.paypal_event_id}`,
        ],
        eventId: ev.id,
        paypalEventId: ev.paypal_event_id,
        eventType: ev.event_type || 'PAYMENT.CAPTURE.COMPLETED',
        scenario: { kind: 'duplicate', label: 'Duplicate delivery', params: { count: 3, mode: 'sequential' } },
        targetChecks: ['idempotent_processing', 'no_second_payment_in_app', 'accepted_delivery_processed', 'deliveries_accepted'],
      });
    } else if (!hasConcDup) {
      push({
        id: `gap-conc-dup-${ev.id}`,
        priority: 'medium',
        title: `Run concurrent duplicate delivery (x3) on ${ev.event_type || 'event'} (${ev.paypal_event_id})`,
        rationale: `Event ${ev.paypal_event_id} was tested with sequential duplicates, but not concurrent duplicates. Sending 3 copies at the same instant tests whether a check-then-insert race condition lets two requests pass before the first transaction commits.`,
        basedOn: [
          `Sequential duplicate run exists on ${ev.paypal_event_id}, but 0 concurrent duplicate runs exist`,
          `Stored verified event ${ev.paypal_event_id} (${ev.event_type})`,
        ],
        eventId: ev.id,
        paypalEventId: ev.paypal_event_id,
        eventType: ev.event_type || 'PAYMENT.CAPTURE.COMPLETED',
        scenario: { kind: 'duplicate', label: 'Duplicate delivery', params: { count: 3, mode: 'concurrent' } },
        targetChecks: ['idempotent_processing', 'no_second_payment_in_app', 'deliveries_accepted'],
      });
    }

    if (hasForwarded && !hasReplay) {
      push({
        id: `gap-replay-${ev.id}`,
        priority: 'medium',
        title: `Replay already-forwarded ${ev.event_type || 'event'} (${ev.paypal_event_id})`,
        rationale: `Event ${ev.paypal_event_id} has already been forwarded to your endpoint, but has not been tested with a later Replay delivery. Replaying it checks that a previously processed event arriving again later does not increment processed_count or create another payment record.`,
        basedOn: [
          `Event ${ev.paypal_event_id} (${ev.event_type}) processing status is "${ev.processing_status}"`,
          `0 replay runs recorded for ${ev.paypal_event_id}`,
        ],
        eventId: ev.id,
        paypalEventId: ev.paypal_event_id,
        eventType: ev.event_type || 'PAYMENT.CAPTURE.COMPLETED',
        scenario: { kind: 'replay', label: 'Replay delivery', params: {} },
        targetChecks: ['idempotent_processing', 'no_second_payment_in_app', 'paypal_payment_unchanged'],
      });
    }

    if (!hasDelay) {
      push({
        id: `gap-delay-${ev.id}`,
        priority: 'low',
        title: `Run delayed delivery (10s) on ${ev.event_type || 'event'} (${ev.paypal_event_id})`,
        rationale: `Event ${ev.paypal_event_id} (${ev.event_type}) has not been tested with a delayed delivery. Holding the event tests how your handler behaves when a webhook arrives late with an older PayPal transmission timestamp.`,
        basedOn: [
          `Stored verified event ${ev.paypal_event_id} (${ev.event_type})`,
          `0 delayed-delivery runs recorded for ${ev.paypal_event_id}`,
        ],
        eventId: ev.id,
        paypalEventId: ev.paypal_event_id,
        eventType: ev.event_type || 'PAYMENT.CAPTURE.COMPLETED',
        scenario: { kind: 'delay', label: 'Delayed delivery', params: { delaySeconds: 10 } },
        targetChecks: ['deliveries_accepted', 'accepted_delivery_processed', 'valid_state_transition'],
      });
    }
  }

  // 4. Dropped delivery gap across the project
  if (!runs.some((r) => r.kind === 'drop')) {
    const ev = verifiedEvents[0];
    push({
      id: `gap-drop-${ev.id}`,
      priority: 'low',
      title: `Run dropped delivery on ${ev.event_type || 'event'} (${ev.paypal_event_id})`,
      rationale: 'No dropped-delivery scenario has been run in this project yet. Withholding a webhook verifies that your payment state remains valid when a notification never arrives.',
      basedOn: [
        `0 dropped-delivery runs across ${runs.length} total scenario run(s)`,
        `Stored verified event ${ev.paypal_event_id} (${ev.event_type})`,
      ],
      eventId: ev.id,
      paypalEventId: ev.paypal_event_id,
      eventType: ev.event_type || 'PAYMENT.CAPTURE.COMPLETED',
      scenario: { kind: 'drop', label: 'Dropped delivery', params: {} },
      targetChecks: ['valid_state_transition'],
    });
  }

  const probeNote = !project.probeUrl
    ? 'Note: No state probe URL is configured on this project. Adding a state probe endpoint will allow Faultline to evaluate internal application-state checks (which are currently marked "not_evaluable").'
    : neverEvaluatedChecks.length
      ? `${neverEvaluatedChecks.length} check(s) have not been evaluated yet (${neverEvaluatedChecks.map((c) => c.name).join(', ')}).`
      : 'All recommendations are derived directly from your stored verified events and scenario run history.';

  return {
    insufficientEvidence: false,
    summary: `Generated ${suggestions.length} recommendation(s) from ${verifiedEvents.length} verified event(s) and ${runs.length} scenario run(s). ${probeNote}`,
    basedOnCounts: {
      verifiedEvents: verifiedEvents.length,
      unverifiedEvents: unverifiedEvents.length,
      scenarioRuns: runs.length,
      failedChecks: failedAssertions.length,
    },
    suggestions: suggestions.slice(0, 8),
  };
}

module.exports = {
  KNOWN_CHECKS,
  SCENARIO_LABELS,
  planFromPrompt,
  validateTestSpec,
  analyzeRun,
  enforceAnalysisGuardrails,
  suggestTests,
  checkForbiddenIntent,
};
