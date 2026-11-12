'use strict';

// FAULTLINE only talks to PayPal Sandbox. The base URL is a constructor option
// solely so automated tests can point at a local, clearly labeled fixture server.
const SANDBOX_BASE_URL = 'https://api-m.sandbox.paypal.com';
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const asString = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max) : null);

class PayPalClient {
  constructor({ baseUrl = SANDBOX_BASE_URL, timeoutMs = 25000 } = {}) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  // POST /v1/oauth2/token (client_credentials). Returns the access token on success.
  // Callers must keep the token and the secret out of logs and responses.
  async fetchToken(clientId, secret) {
    const started = Date.now();
    const elapsed = () => Date.now() - started;
    const basic = Buffer.from(`${clientId}:${secret}`).toString('base64');

    let res;
    try {
      res = await fetch(`${this.baseUrl}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error', // never forward the Authorization header to another host
      });
    } catch (err) {
      return networkFailure(err, this.timeoutMs, elapsed(), 'POST', '/v1/oauth2/token');
    }

    const debugId = res.headers.get('paypal-debug-id');
    const body = await readJson(res);

    if (res.ok) {
      if (!body || typeof body.access_token !== 'string' || body.access_token === '') {
        return fail('unreachable', 'MALFORMED_RESPONSE', 'PayPal answered HTTP 200 but the response was not a valid token response, so the connection was not confirmed.', res.status, debugId, elapsed(), 'POST', '/v1/oauth2/token');
      }
      return {
        ok: true,
        outcome: 'connected',
        httpStatus: res.status,
        accessToken: body.access_token,
        appId: typeof body.app_id === 'string' ? body.app_id : null,
        expiresIn: typeof body.expires_in === 'number' ? body.expires_in : null,
        debugId,
        durationMs: elapsed(),
        method: 'POST',
        path: '/v1/oauth2/token',
      };
    }

    const providerCode = body && typeof body.error === 'string' ? body.error : null;
    const providerText = body && typeof body.error_description === 'string' ? body.error_description : (body && typeof body.message === 'string' ? body.message : '');
    const quoted = providerText ? ` PayPal said: "${providerText.slice(0, 300)}"` : '';

    if (res.status === 401 || res.status === 400) {
      return fail(
        'auth_failed',
        providerCode || `HTTP_${res.status}`,
        `PayPal rejected these credentials. Make sure the Client ID and Secret come from a Sandbox app (not a Live app) and were copied without extra spaces.${quoted}`,
        res.status, debugId, elapsed(), 'POST', '/v1/oauth2/token',
      );
    }
    return fail('unreachable', `HTTP_${res.status}`, `PayPal Sandbox returned HTTP ${res.status}, so the connection could not be confirmed.${quoted}`, res.status, debugId, elapsed(), 'POST', '/v1/oauth2/token');
  }

  // Credential check used by the Connection panel. Never exposes the access token.
  async authenticate(clientId, secret) {
    const r = await this.fetchToken(clientId, secret);
    if (r.ok) {
      const { accessToken, ...rest } = r; // eslint-disable-line no-unused-vars
      return rest;
    }
    return r;
  }

  // Generic authenticated JSON call. Returns { ok, httpStatus, body, debugId, durationMs, method, path }
  // or { ok:false, kind, code, message, issues, httpStatus, debugId, durationMs, method, path }.
  // kind: unreachable | unauthorized | rejected | server_error | malformed
  async request({ method, path, accessToken, body, bodyText, requestId, prefer }) {
    const started = Date.now();
    const elapsed = () => Date.now() - started;
    const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
    if (body !== undefined || bodyText !== undefined) headers['Content-Type'] = 'application/json';
    if (requestId) headers['PayPal-Request-Id'] = requestId;
    if (prefer) headers.Prefer = prefer;

    let res;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers,
        body: bodyText !== undefined ? bodyText : body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch (err) {
      return networkFailure(err, this.timeoutMs, elapsed(), method, path);
    }

    const headerDebug = res.headers.get('paypal-debug-id');
    const parsed = await readJson(res);

    if (res.ok) {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, kind: 'malformed', code: 'MALFORMED_RESPONSE', message: `PayPal answered HTTP ${res.status} but the body was not a JSON object.`, issues: [], httpStatus: res.status, debugId: headerDebug, durationMs: elapsed(), method, path };
      }
      return { ok: true, httpStatus: res.status, body: parsed, debugId: headerDebug, durationMs: elapsed(), method, path };
    }

    const err = parsed && typeof parsed === 'object' ? parsed : {};
    const issues = Array.isArray(err.details)
      ? err.details.slice(0, 10).map((d) => ({ issue: asString(d && d.issue, 100), description: asString(d && d.description, 300), field: asString(d && d.field, 200) }))
      : [];
    return {
      ok: false,
      kind: res.status === 401 ? 'unauthorized' : res.status >= 500 ? 'server_error' : 'rejected',
      code: asString(err.name, 100) || `HTTP_${res.status}`,
      message: asString(err.message, 500) || `PayPal returned HTTP ${res.status}.`,
      issues,
      httpStatus: res.status,
      debugId: asString(err.debug_id, 100) || headerDebug,
      durationMs: elapsed(),
      method,
      path,
    };
  }

  // POST /v2/checkout/orders. intent CAPTURE; buyer approval happens on PayPal via the payer-action link.
  createOrder(accessToken, { amount, currency, description, customId, requestId, returnUrl, cancelUrl }) {
    const unit = { custom_id: customId, amount: { currency_code: currency, value: amount } };
    if (description) unit.description = description;
    return this.request({
      method: 'POST',
      path: '/v2/checkout/orders',
      accessToken,
      requestId,
      prefer: 'return=representation',
      body: {
        intent: 'CAPTURE',
        purchase_units: [unit],
        payment_source: {
          paypal: {
            experience_context: { return_url: returnUrl, cancel_url: cancelUrl, user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING' },
          },
        },
      },
    });
  }

  getOrder(accessToken, orderId) {
    assertId(orderId);
    return this.request({ method: 'GET', path: `/v2/checkout/orders/${orderId}`, accessToken });
  }

  // POST /v2/checkout/orders/{id}/capture. Fails at PayPal unless the buyer has approved the order.
  captureOrder(accessToken, orderId, requestId) {
    assertId(orderId);
    return this.request({ method: 'POST', path: `/v2/checkout/orders/${orderId}/capture`, accessToken, requestId, prefer: 'return=representation', body: {} });
  }

  // POST /v1/notifications/verify-webhook-signature.
  // rawEventText is the delivery body exactly as received. It is embedded unchanged, because
  // re-serializing the event can reorder or reformat fields and make PayPal answer FAILURE.
  verifyWebhookSignature(accessToken, f, rawEventText) {
    const j = JSON.stringify;
    const bodyText = `{"auth_algo":${j(f.authAlgo)},"cert_url":${j(f.certUrl)},"transmission_id":${j(f.transmissionId)},`
      + `"transmission_sig":${j(f.transmissionSig)},"transmission_time":${j(f.transmissionTime)},"webhook_id":${j(f.webhookId)},`
      + `"webhook_event":${rawEventText.trim()}}`;
    return this.request({ method: 'POST', path: '/v1/notifications/verify-webhook-signature', accessToken, bodyText });
  }

  // GET /v2/payments/captures/{capture_id}
  getCapture(accessToken, captureId) {
    assertId(captureId);
    return this.request({ method: 'GET', path: `/v2/payments/captures/${captureId}`, accessToken });
  }
}

function assertId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('Refusing to call PayPal with a malformed ID.');
}

async function readJson(res) {
  const text = await res.text().catch(() => '');
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function networkFailure(err, timeoutMs, durationMs, method, path) {
  if (err && err.name === 'TimeoutError') {
    return fail('unreachable', 'TIMEOUT', `PayPal Sandbox did not answer within ${Math.round(timeoutMs / 1000)} seconds.`, null, null, durationMs, method, path);
  }
  const cause = err && err.cause;
  const code = (cause && (cause.code || (cause.errors && cause.errors[0] && cause.errors[0].code))) || 'NETWORK_ERROR';
  return fail('unreachable', code, `Could not connect to PayPal Sandbox (${code}). Check your internet connection, proxy or firewall.`, null, null, durationMs, method, path);
}

function fail(outcome, code, message, httpStatus, debugId, durationMs, method, path) {
  // "kind" lets callers of request() branch the same way for network failures.
  return { ok: false, outcome, kind: outcome === 'unreachable' ? 'unreachable' : outcome, code, message, issues: [], httpStatus, debugId, durationMs, method, path };
}

module.exports = { PayPalClient, SANDBOX_BASE_URL, ID_RE };
