'use strict';
const { ApiError } = require('./errors');

const CLIENT_ID_RE = /^[A-Za-z0-9_-]{10,256}$/;
const SECRET_RE = /^[\x21-\x7E]{10,512}$/; // printable ASCII, no spaces

function checkName(v) {
  if (typeof v !== 'string' || v.trim() === '') return 'Enter a project name.';
  if (v.trim().length > 80) return 'Use 80 characters or fewer.';
  return null;
}

function checkUrl(v) {
  if (typeof v !== 'string' || v.trim() === '') return 'Enter the URL of your application\'s webhook endpoint.';
  const s = v.trim();
  if (s.length > 2048) return 'Use 2048 characters or fewer.';
  let u;
  try {
    u = new URL(s);
  } catch {
    return 'Enter a full URL, for example http://localhost:4000/webhooks/paypal';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Use an http:// or https:// URL.';
  if (u.username || u.password) return 'Remove the username and password from the URL.';
  return null;
}

function checkClientId(v) {
  if (typeof v !== 'string' || !CLIENT_ID_RE.test(v.trim())) {
    return 'Enter the Sandbox Client ID (letters, numbers, - and _ only, no spaces).';
  }
  return null;
}

function checkSecret(v) {
  if (typeof v !== 'string' || !SECRET_RE.test(v.trim())) {
    return 'Enter the Sandbox Secret (no spaces, at least 10 characters).';
  }
  return null;
}

// partial=false: every field required (create). partial=true: only provided fields are checked (update).
function validateProjectInput(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'invalid_body', 'The request body must be a JSON object.');
  }
  const fields = {};
  const values = {};

  if (!partial || body.name !== undefined) {
    const e = checkName(body.name);
    if (e) fields.name = e; else values.name = body.name.trim();
  }
  if (!partial || body.webhookEndpointUrl !== undefined) {
    const e = checkUrl(body.webhookEndpointUrl);
    if (e) fields.webhookEndpointUrl = e; else values.webhookEndpointUrl = body.webhookEndpointUrl.trim();
  }

  if (body.paypalWebhookId !== undefined) {
    const w = body.paypalWebhookId;
    if (w === null || w === '') values.paypalWebhookId = null;
    else if (typeof w === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(w.trim())) values.paypalWebhookId = w.trim();
    else fields.paypalWebhookId = 'Enter the Webhook ID from the PayPal Developer Dashboard (letters and numbers, no spaces). It is not your Client ID.';
  }

  if (body.probeUrl !== undefined) {
    if (body.probeUrl === null || body.probeUrl === '') values.probeUrl = null;
    else {
      const e = checkUrl(body.probeUrl);
      if (e) fields.probeUrl = e; else values.probeUrl = body.probeUrl.trim();
    }
  }

  if (body.forwardMode !== undefined) {
    if (body.forwardMode === 'auto' || body.forwardMode === 'manual') values.forwardMode = body.forwardMode;
    else fields.forwardMode = 'Choose auto or manual.';
  }

  const touchesCredentials = body.clientId !== undefined || body.clientSecret !== undefined;
  if (!partial || touchesCredentials) {
    const idErr = checkClientId(body.clientId);
    const secretErr = checkSecret(body.clientSecret);
    if (idErr) fields.clientId = partial && body.clientId === undefined ? 'Provide the Client ID and Secret together when replacing credentials.' : idErr;
    if (secretErr) fields.clientSecret = partial && body.clientSecret === undefined ? 'Provide the Client ID and Secret together when replacing credentials.' : secretErr;
    if (!idErr && !secretErr) {
      values.clientId = body.clientId.trim();
      values.clientSecret = body.clientSecret.trim();
    }
  }

  if (Object.keys(fields).length > 0) {
    throw new ApiError(400, 'validation_failed', 'Some fields need attention.', fields);
  }
  return values;
}

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD']; // all use 2 decimal places
const MAX_AMOUNT = 10000;
const KEY_RE = /^[A-Za-z0-9_-]{8,100}$/;

// Returns { amount: "10.00", currency, description, idempotencyKey }
function validateOrderInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'invalid_body', 'The request body must be a JSON object.');
  }
  const fields = {};
  const values = {};

  const rawAmount = typeof body.amount === 'number' ? String(body.amount) : body.amount;
  if (typeof rawAmount !== 'string' || !/^\d{1,7}(\.\d{1,2})?$/.test(rawAmount.trim())) {
    fields.amount = 'Enter an amount such as 10 or 10.50 (at most 2 decimal places).';
  } else {
    const [whole, frac = ''] = rawAmount.trim().split('.');
    const n = Number(`${whole}.${frac || '0'}`);
    if (!(n > 0)) fields.amount = 'The amount must be greater than 0.';
    else if (n > MAX_AMOUNT) fields.amount = `For safety, Faultline test orders are limited to ${MAX_AMOUNT.toFixed(2)}.`;
    else values.amount = `${Number(whole)}.${frac.padEnd(2, '0')}`;
  }

  const currency = body.currency === undefined ? 'USD' : body.currency;
  if (!CURRENCIES.includes(currency)) fields.currency = `Choose one of: ${CURRENCIES.join(', ')}.`;
  else values.currency = currency;

  if (body.description !== undefined && body.description !== null && body.description !== '') {
    if (typeof body.description !== 'string' || body.description.trim().length > 127 || /[\x00-\x1F\x7F]/.test(body.description)) {
      fields.description = 'Use 127 characters or fewer, with no control characters.';
    } else values.description = body.description.trim();
  }

  if (body.idempotencyKey !== undefined && body.idempotencyKey !== null) {
    if (typeof body.idempotencyKey !== 'string' || !KEY_RE.test(body.idempotencyKey)) {
      fields.idempotencyKey = 'The idempotency key must be 8 to 100 letters, numbers, - or _.';
    } else values.idempotencyKey = body.idempotencyKey;
  }

  if (Object.keys(fields).length > 0) throw new ApiError(400, 'validation_failed', 'Some fields need attention.', fields);
  return values;
}

module.exports = { validateProjectInput, validateOrderInput, CURRENCIES };
