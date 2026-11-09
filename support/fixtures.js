'use strict';
// ---------------------------------------------------------------------------
// TEST FIXTURE ONLY. This file starts a local HTTP server that imitates the
// shape of PayPal's /v1/oauth2/token endpoint so deterministic behavior
// (error handling, timeouts, secrecy) can be tested offline.
// It is NOT PayPal. Tests using it are NOT PayPal Sandbox integration tests.
// ---------------------------------------------------------------------------
const http = require('node:http');
const crypto = require('node:crypto');
const { openDb } = require('../src/db');
const { PayPalClient } = require('../src/paypal');
const { createApp } = require('../src/app');
const { createAiProvider } = require('../src/ai-provider');
const { planFromPrompt, analyzeRun, suggestTests } = require('../src/ai-engineer');

const GOOD_ID = 'FIXTURE_GOOD_CLIENT_ID';
const GOOD_SECRET = 'fixture-good-secret-123456';
const BAD_SECRET = 'fixture-wrong-secret-99999';
const SLOW_ID = 'FIXTURE_SLOW_CLIENT_ID';

function startFixturePayPal() {
  const seen = [];
  const validTokens = new Set();
  const orders = new Map();
  const captures = new Map();
  const byRequestId = new Map();
  const counters = { token: 0, order: 0, capture: 0 };
  const state = { captureDelayMs: 0 };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const debug = 'fixture-debug-id';

  const orderView = (o) => ({
    id: o.id, intent: 'CAPTURE', status: o.status,
    ...(o.payer ? { payer: o.payer } : {}),
    purchase_units: [{
      reference_id: 'default', amount: o.amount, custom_id: o.customId, ...(o.description ? { description: o.description } : {}),
      ...(o.captureIds.length ? { payments: { captures: o.captureIds.map((id) => captures.get(id)) } } : {}),
    }],
    create_time: o.createTime,
    links: [
      { href: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${o.id}`, rel: 'self', method: 'GET' },
      ...(o.status === 'PAYER_ACTION_REQUIRED' ? [{ href: `https://www.sandbox.paypal.com/checkoutnow?token=${o.id}`, rel: 'payer-action', method: 'GET' }] : []),
    ],
  });

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      let json = null;
      try { json = JSON.parse(raw); } catch { /* not json */ }
      seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, headers: req.headers, body: raw, json });
      const send = (status, body, extra = {}) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('paypal-debug-id', debug);
        for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };

      // ---- token endpoint (the only part Phase 1 used) ----
      if (req.url === '/v1/oauth2/token') {
        const [id, secret] = Buffer.from((req.headers.authorization || '').replace('Basic ', ''), 'base64').toString().split(':');
        if (id === SLOW_ID) return setTimeout(() => send(200, '{}'), 2000);
        if (id === 'FIXTURE_SERVER_ERROR') return send(500, '{"name":"INTERNAL_SERVICE_ERROR"}');
        if (id === 'FIXTURE_MALFORMED_ID') { res.setHeader('paypal-debug-id', debug); return res.end('<html>not json</html>'); }
        if (id === GOOD_ID && secret === GOOD_SECRET) {
          const token = `fixture-token-${++counters.token}`;
          validTokens.add(token);
          return send(200, { scope: 'fixture', access_token: token, token_type: 'Bearer', app_id: 'APP-FIXTURE0001', expires_in: 32400, nonce: 'n' });
        }
        return send(401, { error: 'invalid_client', error_description: 'Client Authentication failed' });
      }

      // ---- Orders / Payments (shape imitates PayPal's v2 API; behavior is the fixture's own) ----
      const bearer = (req.headers.authorization || '').replace('Bearer ', '');
      if (!validTokens.has(bearer)) {
        return send(401, { name: 'AUTHENTICATION_FAILURE', message: 'Authentication failed due to invalid authentication credentials or a missing Authorization header.', debug_id: debug });
      }
      const reqId = req.headers['paypal-request-id'];
      let m;

      if (req.method === 'POST' && req.url === '/v1/notifications/verify-webhook-signature') {
        if (!json || !json.webhook_id || !json.transmission_sig || json.webhook_event === undefined) {
          return send(400, { name: 'INVALID_REQUEST', message: 'Webhook ID missing or request not well-formed.', debug_id: debug });
        }
        if (json.transmission_sig === 'FIXTURE-PAYPAL-DOWN') return send(500, { name: 'INTERNAL_SERVER_ERROR', message: 'An internal server error has occurred.', debug_id: debug });
        // Fixture rule only: this is NOT PayPal's real signature check.
        const ok = json.transmission_sig === 'FIXTURE-VALID-SIG' && json.webhook_id === 'FXWEBHOOK0001';
        return send(200, { verification_status: ok ? 'SUCCESS' : 'FAILURE' });
      }

      if (req.method === 'POST' && req.url === '/v2/checkout/orders') {
        const unit = json && json.purchase_units && json.purchase_units[0];
        const ctx = json && json.payment_source && json.payment_source.paypal && json.payment_source.paypal.experience_context;
        if (!json || json.intent !== 'CAPTURE' || !unit || !unit.amount || typeof unit.amount.value !== 'string' || !ctx || !ctx.return_url) {
          return send(400, { name: 'INVALID_REQUEST', message: 'Request is not well-formed, syntactically incorrect, or violates schema.', debug_id: debug, details: [{ field: '/purchase_units', issue: 'INVALID_ARRAY_MIN_ITEMS', description: 'fixture validation' }] });
        }
        if (unit.amount.value === '66.66') return send(500, { name: 'INTERNAL_SERVER_ERROR', message: 'An internal server error has occurred.', debug_id: debug });
        if (unit.amount.value === '77.77') return send(422, { name: 'UNPROCESSABLE_ENTITY', message: 'The requested action could not be performed, semantically incorrect, or failed business validation.', debug_id: debug, details: [{ issue: 'FIXTURE_RULE', description: 'Fixture refuses amount 77.77.' }] });
        if (reqId && byRequestId.has(`create:${reqId}`)) return send(200, orderView(byRequestId.get(`create:${reqId}`)));
        const order = {
          id: `FXORDER${String(++counters.order).padStart(4, '0')}`, status: 'PAYER_ACTION_REQUIRED', amount: unit.amount,
          customId: unit.custom_id, description: unit.description, createTime: new Date().toISOString(), captureIds: [], payer: null,
        };
        orders.set(order.id, order);
        if (reqId) byRequestId.set(`create:${reqId}`, order);
        return send(201, orderView(order));
      }

      if ((m = req.url.match(/^\/v2\/checkout\/orders\/([A-Z0-9]+)(\/capture)?$/))) {
        const order = orders.get(m[1]);
        if (!order) return send(404, { name: 'RESOURCE_NOT_FOUND', message: 'The specified resource does not exist.', debug_id: debug });
        if (req.method === 'GET' && !m[2]) return send(200, orderView(order));
        if (req.method === 'POST' && m[2]) {
          if (state.captureDelayMs) await sleep(state.captureDelayMs);
          if (order.status === 'COMPLETED') return send(422, { name: 'UNPROCESSABLE_ENTITY', message: 'The requested action could not be performed.', debug_id: debug, details: [{ issue: 'ORDER_ALREADY_CAPTURED', description: 'Order already captured.' }] });
          if (order.status !== 'APPROVED') return send(422, { name: 'UNPROCESSABLE_ENTITY', message: 'The requested action could not be performed, semantically incorrect, or failed business validation.', debug_id: debug, details: [{ issue: 'ORDER_NOT_APPROVED', description: 'Payer has not yet approved the Order for payment.' }] });
          const cap = {
            id: `FXCAPTURE${String(++counters.capture).padStart(4, '0')}`, status: 'COMPLETED', amount: order.amount, final_capture: true,
            seller_protection: { status: 'ELIGIBLE' }, create_time: new Date().toISOString(), update_time: new Date().toISOString(),
          };
          captures.set(cap.id, cap);
          order.captureIds.push(cap.id);
          order.status = 'COMPLETED';
          return send(201, orderView(order));
        }
      }

      if (req.method === 'GET' && (m = req.url.match(/^\/v2\/payments\/captures\/([A-Z0-9]+)$/))) {
        const cap = captures.get(m[1]);
        if (!cap) return send(404, { name: 'RESOURCE_NOT_FOUND', message: 'The specified resource does not exist.', debug_id: debug });
        return send(200, cap);
      }
      return send(404, { name: 'RESOURCE_NOT_FOUND', message: 'Fixture has no such route.', debug_id: debug });
    });
  });

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      seen,
      state,
      count: (method, url) => seen.filter((r) => r.method === method && r.url === url).length,
      // Stands in for the human buyer approving the order on PayPal's website.
      approve: (id) => { const o = orders.get(id); o.status = 'APPROVED'; o.payer = { name: { given_name: 'Fixture', surname: 'Buyer' }, email_address: 'buyer@example.test', payer_id: 'FXPAYER0001' }; },
      setCaptureStatus: (id, status) => { const c = captures.get(id); c.status = status; c.update_time = new Date().toISOString(); },
      invalidateTokens: () => validTokens.clear(),
      close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
    });
  }));
}

// ---------------------------------------------------------------------------
// TEST FIXTURE: a stand-in for the developer's own webhook endpoint. It records
// every request it receives and answers however the test tells it to.
// ---------------------------------------------------------------------------
function startFixtureDestination() {
  const received = [];
  const state = { handler: () => ({ status: 200, body: 'ok' }) };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const rec = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks), at: Date.now() };
      received.push(rec);
      const r = state.handler(rec, received.length) || { status: 200 };
      setTimeout(() => {
        res.statusCode = r.status;
        for (const [k, v] of Object.entries(r.headers || {})) res.setHeader(k, v);
        res.end(r.body ?? 'ok');
      }, r.delayMs || 0);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({
      url: `http://127.0.0.1:${server.address().port}/webhooks/paypal`,
      port: server.address().port,
      received,
      state,
      close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
    });
  }));
}

// ---------------------------------------------------------------------------
// TEST FIXTURE: a stand-in for a developer's APPLICATION, with switchable behavior (correct or buggy) and a state
// probe. It exists so the checks can be shown to pass a correct handler and to catch specific, planted bugs.
// ---------------------------------------------------------------------------
function startFixtureApp(opts = {}) {
  const state = { processed: new Map(), records: new Map(), status: null, captured: 0, refunded: 0, currency: 'USD', requests: 0, probeRequests: [], probeMode: 'ok', omit: [] };
  const cents = (v) => Math.round(parseFloat(v) * 100);
  const fmt = (c) => (c / 100).toFixed(2);
  const rank = { PENDING: 1, APPROVED: 3, COMPLETED: 4 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/probe') {
        state.probeRequests.push({ query: Object.fromEntries(url.searchParams), headers: req.headers });
        if (state.probeMode === 'down') { res.statusCode = 500; return res.end('probe down'); }
        if (state.probeMode === 'notjson') return res.end('<html>nope</html>');
        if (state.probeMode === 'invalid') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ event: { processed_count: -1 } })); }
        const body = { event: { processed_count: state.processed.get(url.searchParams.get('event_id')) || 0 }, payment: { status: state.status, captured_amount: fmt(state.captured), refunded_amount: fmt(state.refunded), currency: state.currency, payment_records: state.records.get(url.searchParams.get('resource_id')) || 0 } };
        for (const k of state.omit) { delete body.payment[k]; if (k === 'processed_count') delete body.event.processed_count; }
        if (state.status === null) delete body.payment.status;
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify(body));
      }
      state.requests += 1;
      const n = state.requests;
      let ev; try { ev = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.statusCode = 400; return res.end('bad'); }
      const seen = state.processed.get(ev.id) || 0;
      if (opts.failMode === 'rollback_500' && n === 1) { res.statusCode = 500; return res.end('rolled back'); }
      if (!(opts.idempotent && seen > 0)) {
        state.processed.set(ev.id, seen + 1);
        const r = ev.resource || {};
        if (ev.event_type === 'PAYMENT.CAPTURE.COMPLETED') { state.records.set(r.id, (state.records.get(r.id) || 0) + 1); state.status = 'COMPLETED'; state.captured = cents(r.amount.value); }
        if (ev.event_type === 'CHECKOUT.ORDER.APPROVED') { if (opts.naiveStatus || (rank[state.status] || 0) < rank.APPROVED) state.status = 'APPROVED'; }
        if (ev.event_type === 'PAYMENT.CAPTURE.REFUNDED') {
          const amt = cents(r.amount.value);
          if (!(opts.refundLimit && state.refunded + amt > state.captured)) state.refunded += amt;
        }
      }
      if (opts.failMode === 'commit_then_500' && n === 1) { res.statusCode = 500; return res.end('failed after commit'); }
      res.end('ok');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({ webhookUrl: `${base}/webhooks/paypal`, probeUrl: `${base}/probe`, state, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) });
  }));
}

const ADMIN_PASSWORD = 'test-admin-password-123';

// ---------------------------------------------------------------------------
// TEST FIXTURE: an offline, injected mock for the official OpenAI SDK client.
// Records every model invocation so tests can assert secret/data minimization,
// schema validation, timeout handling, and deterministic verdict immutability
// without requiring a real OPENAI_API_KEY or making external network calls.
// ---------------------------------------------------------------------------
function createMockOpenAIClient(opts = {}) {
  const calls = [];
  let customHandler = opts.handler || null;

  function defaultResponder(params) {
    const sys = (params.messages.find((m) => m.role === 'system') || {}).content || '';
    const usr = (params.messages.find((m) => m.role === 'user') || {}).content || '';

    if (sys.includes('Faultline AI Test Planner')) {
      const promptMatch = usr.match(/<untrusted_developer_request>\n([\s\S]*?)\n<\/untrusted_developer_request>/);
      const ctxMatch = usr.match(/<allowlisted_event_metadata>\n([\s\S]*?)\n<\/allowlisted_event_metadata>/);
      const promptText = promptMatch ? promptMatch[1] : '';
      const ctx = ctxMatch ? JSON.parse(ctxMatch[1]) : { verifiedEvents: [], probeConfigured: false };
      const mappedEvents = (ctx.verifiedEvents || []).map((e) => ({
        id: e.id,
        paypal_event_id: e.paypalEventId,
        event_type: e.eventType,
        resource_type: e.resourceType,
        paypal_event_created_at: e.paypalEventCreatedAt,
        processing_status: e.processingStatus,
      }));
      try {
        const planned = planFromPrompt(promptText, {
          verifiedEvents: mappedEvents,
          selectedEventId: ctx.selectedEventId,
          probeConfigured: ctx.probeConfigured,
        });
        return {
          objective: planned.spec.objective,
          requiredEventType: planned.spec.requiredSourceEvent.eventType,
          requiredVerificationStatus: 'verified',
          matchedEventId: planned.matchedEventId,
          scenario: {
            kind: planned.spec.scenario.kind,
            params: planned.spec.scenario.params,
          },
          expectedBehavior: planned.spec.expectedBehavior,
          assertions: planned.spec.assertions.map((a) => a.id),
          failureConditions: planned.spec.failureConditions,
          financialOperationsAllowed: false,
        };
      } catch (err) {
        return { refusal: err.message || 'Unrecognized or unsafe request.' };
      }
    }

    if (sys.includes('Faultline AI Run Analyzer')) {
      const traceMatch = usr.match(/<allowlisted_execution_trace>\n([\s\S]*?)\n<\/allowlisted_execution_trace>/);
      const safeTrace = traceMatch ? JSON.parse(traceMatch[1]) : {};
      const baseline = analyzeRun({
        ...safeTrace,
        run: { ...safeTrace.run, destination: 'https://endpoint.test/webhooks' },
      });
      return {
        whatWasExpected: baseline.whatWasExpected,
        whereFailureOccurred: baseline.whereFailureOccurred,
        whyItMatters: baseline.whyItMatters,
        whatToInvestigate: baseline.whatToInvestigate,
        remediation: baseline.remediation,
        recommendations: baseline.recommendations,
      };
    }

    if (sys.includes('Faultline AI Follow-Up Test Advisor')) {
      const evMatch = usr.match(/<allowlisted_project_evidence>\n([\s\S]*?)\n<\/allowlisted_project_evidence>/);
      const safeEv = evMatch ? JSON.parse(evMatch[1]) : {};
      const mapped = suggestTests({
        project: {
          probeUrl: safeEv.probeConfigured ? 'http://probe.local/probe' : null,
          paypalWebhookId: safeEv.webhookIdConfigured ? 'WHID' : null,
          forwardMode: safeEv.forwardMode || 'manual',
        },
        verifiedEvents: (safeEv.verifiedEvents || []).map((e) => ({
          id: e.id,
          paypal_event_id: e.paypalEventId,
          event_type: e.eventType,
          resource_type: e.resourceType,
          paypal_event_created_at: e.paypalEventCreatedAt,
          processing_status: e.processingStatus,
          related_order_id: e.hasRelatedOrder ? 'ord-shared' : null,
        })),
        unverifiedEvents: [],
        runs: (safeEv.runs || []).map((r) => ({
          id: r.id,
          event_id: r.eventId,
          kind: r.kind,
          params: r.params,
          status: r.status,
          verdict: r.verdict,
        })),
        failedAssertions: (safeEv.failedAssertions || []).map((f) => ({
          run_id: f.runId,
          event_id: f.eventId,
          check_id: f.checkId,
          name: f.name,
          summary: f.summary,
        })),
        neverEvaluatedChecks: (safeEv.neverEvaluatedChecks || []).map((c) => ({
          check_id: c.checkId,
          name: c.name,
        })),
      });
      return {
        summary: mapped.summary,
        suggestions: mapped.suggestions.map((s) => ({
          id: s.id,
          priority: s.priority,
          title: s.title,
          rationale: s.rationale,
          basedOn: s.basedOn,
          eventId: s.eventId,
          scenario: { kind: s.scenario.kind, params: s.scenario.params },
          targetChecks: s.targetChecks,
        })),
      };
    }

    return {};
  }

  const client = {
    chat: {
      completions: {
        create: async (params, reqOpts = {}) => {
          const sys = (params.messages.find((m) => m.role === 'system') || {}).content || '';
          const usr = (params.messages.find((m) => m.role === 'user') || {}).content || '';
          calls.push({
            model: params.model,
            temperature: params.temperature,
            max_completion_tokens: params.max_completion_tokens,
            response_format: params.response_format,
            messages: params.messages,
            systemPrompt: sys,
            userPrompt: usr,
          });
          if (customHandler) {
            const customResult = await customHandler(params, reqOpts);
            if (typeof customResult === 'string') {
              return { choices: [{ message: { content: customResult } }] };
            }
            return { choices: [{ message: { content: JSON.stringify(customResult) } }] };
          }
          const jsonObj = defaultResponder(params);
          return { choices: [{ message: { content: JSON.stringify(jsonObj) } }] };
        },
      },
    },
  };

  return {
    client,
    calls,
    setHandler: (fn) => { customHandler = fn; },
  };
}

async function startTestApp(fixtureUrl, timeoutMs = 400, opts = {}) {
  const config = {
    encryptionKey: crypto.randomBytes(32).toString('hex'),
    sessionSecret: crypto.randomBytes(32).toString('hex'),
    adminPassword: ADMIN_PASSWORD,
    cookieSecure: false,
    publicBaseUrl: 'http://127.0.0.1:3000',
    forwardTimeoutMs: 1500,
    probeSettleMs: 120,
    openaiModel: 'gpt-4o-mini',
    openaiTimeoutMs: 1500,
    ...(opts.config || {}),
  };
  const db = openDb(opts.dbFile || ':memory:');
  const mockOpenAI = opts.mockOpenAI || createMockOpenAIClient(opts.aiOverrides || {});
  const ai = opts.ai !== undefined
    ? opts.ai
    : opts.aiConfigured === false
      ? createAiProvider({ apiKey: null, model: config.openaiModel, timeoutMs: config.openaiTimeoutMs })
      : createAiProvider({
        apiKey: null,
        model: config.openaiModel,
        timeoutMs: config.openaiTimeoutMs,
        client: mockOpenAI.client,
      });
  const app = createApp({ config, db, paypal: new PayPalClient({ baseUrl: fixtureUrl, timeoutMs }), ai });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  let cookie = '';
  async function request(method, path, body, extraHeaders = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders },
      body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, headers: res.headers, text, json };
  }
  async function login() {
    const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: ADMIN_PASSWORD }) });
    cookie = res.headers.get('set-cookie').split(';')[0];
    return res;
  }
  return { base, db, config, request, login, app, mockOpenAI, close: () => new Promise((r) => { app.locals.shutdown(); server.closeAllConnections(); server.close(() => { db.close(); r(); }); }) };
}

const goodProject = (over = {}) => ({
  name: 'Checkout service',
  clientId: GOOD_ID,
  clientSecret: GOOD_SECRET,
  webhookEndpointUrl: 'http://localhost:4000/webhooks/paypal',
  ...over,
});

module.exports = { startFixturePayPal, startFixtureDestination, startFixtureApp, startTestApp, createMockOpenAIClient, goodProject, GOOD_ID, GOOD_SECRET, BAD_SECRET, SLOW_ID, ADMIN_PASSWORD };
