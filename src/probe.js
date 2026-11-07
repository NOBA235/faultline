'use strict';

// Optional "state probe": a test-only GET endpoint the developer adds to their own application.
// Faultline never assumes it knows the application's state. It only knows what this endpoint reports.
//
//   GET <probe url>?event_id=WH-...&resource_id=...&event_type=...
//   -> { "event":   { "processed_count": 1 },
//        "payment": { "status": "COMPLETED", "captured_amount": "10.10", "refunded_amount": "0.00",
//                     "currency": "USD", "payment_records": 1 } }
// Every field is optional. A check runs only when the fields it needs are present.

const MAX_BYTES = 65536;
const isCount = (v) => Number.isInteger(v) && v >= 0 && v <= 1e9;

function toCents(v) {
  const s = typeof v === 'number' ? String(v) : v;
  if (typeof s !== 'string' || !/^\d{1,12}(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

function validateProbeBody(obj) {
  const problems = [];
  const data = { processedCount: null, status: null, capturedCents: null, refundedCents: null, currency: null, paymentRecords: null };
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, problems: ['The response must be a JSON object.'], data };
  const ev = obj.event;
  const pay = obj.payment;
  if (ev !== undefined && (ev === null || typeof ev !== 'object' || Array.isArray(ev))) problems.push('"event" must be an object.');
  if (pay !== undefined && (pay === null || typeof pay !== 'object' || Array.isArray(pay))) problems.push('"payment" must be an object.');
  if (ev && typeof ev === 'object' && ev.processed_count !== undefined) {
    if (isCount(ev.processed_count)) data.processedCount = ev.processed_count; else problems.push('"event.processed_count" must be a whole number, 0 or more.');
  }
  if (pay && typeof pay === 'object') {
    if (pay.status !== undefined) {
      if (typeof pay.status === 'string' && /^[A-Za-z_]{1,40}$/.test(pay.status)) data.status = pay.status.toUpperCase(); else problems.push('"payment.status" must be a word such as COMPLETED.');
    }
    if (pay.captured_amount !== undefined) {
      const c = toCents(pay.captured_amount);
      if (c === null) problems.push('"payment.captured_amount" must be a decimal such as "10.10".'); else data.capturedCents = c;
    }
    if (pay.refunded_amount !== undefined) {
      const c = toCents(pay.refunded_amount);
      if (c === null) problems.push('"payment.refunded_amount" must be a decimal such as "0.00".'); else data.refundedCents = c;
    }
    if (pay.currency !== undefined) {
      if (typeof pay.currency === 'string' && /^[A-Za-z]{3}$/.test(pay.currency)) data.currency = pay.currency.toUpperCase(); else problems.push('"payment.currency" must be a 3-letter code.');
    }
    if (pay.payment_records !== undefined) {
      if (isCount(pay.payment_records)) data.paymentRecords = pay.payment_records; else problems.push('"payment.payment_records" must be a whole number, 0 or more.');
    }
  }
  return { ok: problems.length === 0, problems, data };
}

async function readLimited(res, max) {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    total += value.length;
    if (total >= max) { await reader.cancel().catch(() => {}); break; }
  }
  return Buffer.concat(chunks).subarray(0, max);
}

// Returns { outcome: 'ok' | 'error', httpStatus, durationMs, errorText, data }. Never throws.
async function fetchProbe({ url, eventId, resourceId, eventType, timeoutMs }) {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const fail = (errorText, httpStatus = null) => ({ outcome: 'error', httpStatus, durationMs: elapsed(), errorText, data: null });
  let u;
  try { u = new URL(url); } catch { return fail('The probe URL is not a valid URL.'); }
  if (eventId) u.searchParams.set('event_id', eventId);
  if (resourceId) u.searchParams.set('resource_id', resourceId);
  if (eventType) u.searchParams.set('event_type', eventType);
  let res;
  try {
    res = await fetch(u, { method: 'GET', headers: { accept: 'application/json', 'x-faultline-probe': '1', 'user-agent': 'Faultline/0.5' }, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
  } catch (err) {
    if (err && err.name === 'TimeoutError') return fail(`The probe did not answer within ${Math.round(timeoutMs / 1000)} seconds.`);
    const cause = err && err.cause;
    return fail(`Could not reach the probe (${(cause && (cause.code || (cause.errors && cause.errors[0] && cause.errors[0].code))) || 'NETWORK_ERROR'}).`);
  }
  const body = await readLimited(res, MAX_BYTES);
  if (res.status < 200 || res.status >= 300) return fail(`The probe answered HTTP ${res.status}.`, res.status);
  let json;
  try { json = JSON.parse(body.toString('utf8')); } catch { return fail('The probe did not answer with JSON.', res.status); }
  const v = validateProbeBody(json);
  if (!v.ok) return fail(`The probe response was not in the expected format: ${v.problems.join(' ')}`, res.status);
  return { outcome: 'ok', httpStatus: res.status, durationMs: elapsed(), errorText: null, data: v.data };
}

module.exports = { fetchProbe, validateProbeBody, toCents };
