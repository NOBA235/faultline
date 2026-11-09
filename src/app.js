'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const { createCipher, signToken, verifyToken, safeEqualStrings } = require('./crypto');
const { validateProjectInput } = require('./validation');
const { ApiError } = require('./errors');
const { registerOrderRoutes } = require('./orders');
const { createPayPalService } = require('./paypal-service');
const { registerWebhookRoutes } = require('./webhooks');
const { createForwarder } = require('./forwarder');
const { registerScenarioRoutes } = require('./scenarios');
const { registerReportRoutes } = require('./reports');
const { registerAiRoutes } = require('./ai');
const { createAiProvider } = require('./ai-provider');

const SESSION_COOKIE = 'fl_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function createApp({ config, db, paypal, ai }) {
  const cipher = createCipher(config.encryptionKey);
  const aiProvider = ai || createAiProvider({
    apiKey: config.openaiApiKey || null,
    model: config.openaiModel || 'gpt-4o-mini',
    timeoutMs: config.openaiTimeoutMs || 15000,
  });
  const app = express();
  app.disable('x-powered-by');

  const publicBase = (config.publicBaseUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const checksInFlight = new Set(); // project ids with a PayPal check running
  const loginFailures = new Map(); // ip -> { count, resetAt }

  // ---- security headers -------------------------------------------------
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });

  // ---- API guards -------------------------------------------------------
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
      let sameOrigin = false;
      try {
        sameOrigin = new URL(req.headers.origin).host === req.headers.host;
      } catch {
        sameOrigin = false;
      }
      if (!sameOrigin) return next(new ApiError(403, 'forbidden_origin', 'Cross-origin requests are not allowed.'));
    }
    next();
  });
  app.use('/api', express.json({ limit: '16kb' }));

  function requireAuth(req, res, next) {
    const session = verifyToken(readCookie(req, SESSION_COOKIE), config.sessionSecret);
    if (!session || typeof session.exp !== 'number' || session.exp < Date.now()) {
      return next(new ApiError(401, 'not_authenticated', 'Sign in to continue.'));
    }
    next();
  }

  // ---- auth -------------------------------------------------------------
  app.get('/api/health', (req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok' });
  });

  app.get('/api/auth/me', (req, res) => {
    const session = verifyToken(readCookie(req, SESSION_COOKIE), config.sessionSecret);
    res.json({ authenticated: Boolean(session && typeof session.exp === 'number' && session.exp >= Date.now()) });
  });

  app.post('/api/auth/login', (req, res) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const record = loginFailures.get(ip);
    if (record && record.resetAt > now && record.count >= MAX_LOGIN_FAILURES) {
      throw new ApiError(429, 'too_many_attempts', 'Too many failed sign-in attempts. Wait 15 minutes and try again.');
    }
    const password = req.body && typeof req.body.password === 'string' ? req.body.password : '';
    if (!safeEqualStrings(password, config.adminPassword)) {
      const fresh = record && record.resetAt > now ? record : { count: 0, resetAt: now + LOGIN_WINDOW_MS };
      fresh.count += 1;
      loginFailures.set(ip, fresh);
      throw new ApiError(401, 'invalid_password', 'Incorrect password.');
    }
    loginFailures.delete(ip);
    res.cookie(SESSION_COOKIE, signToken({ exp: now + SESSION_TTL_MS }, config.sessionSecret), {
      httpOnly: true,
      sameSite: 'strict',
      secure: config.cookieSecure,
      maxAge: SESSION_TTL_MS,
      path: '/',
    });
    res.json({ authenticated: true });
  });

  app.post('/api/auth/logout', (req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ authenticated: false });
  });

  // ---- projects ---------------------------------------------------------
  const getRow = (id) => {
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    if (!row) throw new ApiError(404, 'not_found', 'Project not found.');
    return row;
  };

  // Public shape. The encrypted secret column is never exposed.
  const toPublic = (r) => ({
    id: r.id,
    name: r.name,
    environment: r.environment,
    clientId: r.paypal_client_id,
    hasSecret: true,
    webhookEndpointUrl: r.webhook_endpoint_url,
    forwardMode: r.forward_mode,
    probeUrl: r.probe_url,
    webhook: {
      receiverUrl: `${publicBase}/webhooks/paypal/${r.id}`,
      receiverIsHttps: publicBase.startsWith('https://'),
      paypalWebhookId: r.paypal_webhook_id,
    },
    connection: {
      status: r.connection_status,
      checkedAt: r.connection_checked_at,
      errorCode: r.connection_error_code,
      errorMessage: r.connection_error_message,
      paypalAppId: r.paypal_app_id,
    },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

  const toCheck = (c) => ({
    id: c.id,
    checkedAt: c.checked_at,
    outcome: c.outcome,
    httpStatus: c.http_status,
    errorCode: c.error_code,
    errorMessage: c.error_message,
    durationMs: c.duration_ms,
    paypalDebugId: c.paypal_debug_id,
  });

  const recentChecks = (id) =>
    db.prepare('SELECT * FROM connection_checks WHERE project_id = ? ORDER BY id DESC LIMIT 10').all(id).map(toCheck);

  // Runs a real authenticated request against PayPal Sandbox and records the outcome.
  async function runConnectionCheck(row) {
    if (checksInFlight.has(row.id)) {
      throw new ApiError(409, 'check_in_progress', 'A connection check for this project is already running.');
    }
    checksInFlight.add(row.id);
    try {
      let result;
      let secret = null;
      try {
        secret = cipher.decrypt(row.paypal_secret_enc, row.id);
      } catch {
        result = {
          ok: false, outcome: 'secret_unreadable', code: 'secret_unreadable', httpStatus: null, debugId: null, durationMs: 0,
          message: 'The stored secret cannot be decrypted. ENCRYPTION_KEY has probably changed since this project was saved. Re-enter the Client ID and Secret.',
        };
      }
      if (!result) result = await paypal.authenticate(row.paypal_client_id, secret);

      const status = result.ok ? 'connected'
        : result.outcome === 'auth_failed' ? 'auth_failed'
        : result.outcome === 'unreachable' ? 'unreachable'
        : 'unverified';
      const checkedAt = new Date().toISOString();
      const errorCode = result.ok ? null : result.code;
      const errorMessage = result.ok ? null : result.message;

      db.transaction(() => {
        db.prepare(`INSERT INTO connection_checks
          (project_id, checked_at, outcome, http_status, error_code, error_message, duration_ms, paypal_debug_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(row.id, checkedAt, result.outcome, result.httpStatus, errorCode, errorMessage, result.durationMs, result.debugId);
        db.prepare(`UPDATE projects SET connection_status = ?, connection_checked_at = ?, connection_error_code = ?,
          connection_error_message = ?, paypal_app_id = ?, updated_at = ? WHERE id = ?`)
          .run(status, checkedAt, errorCode, errorMessage, result.ok ? result.appId : null, checkedAt, row.id);
      })();
      return { status, outcome: result.outcome, httpStatus: result.httpStatus, errorCode, errorMessage, durationMs: result.durationMs, paypalDebugId: result.debugId, checkedAt };
    } finally {
      checksInFlight.delete(row.id);
    }
  }

  app.get('/api/projects', requireAuth, (req, res) => {
    const rows = db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
    res.json({ projects: rows.map(toPublic) });
  });

  app.post('/api/projects', requireAuth, wrap(async (req, res) => {
    const v = validateProjectInput(req.body);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    try {
      db.prepare(`INSERT INTO projects (id, name, paypal_client_id, paypal_secret_enc, webhook_endpoint_url, paypal_webhook_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, v.name, v.clientId, cipher.encrypt(v.clientSecret, id), v.webhookEndpointUrl, v.paypalWebhookId ?? null, now, now);
    } catch (err) {
      if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new ApiError(409, 'name_taken', 'A project with this name already exists.', { name: 'Choose a different name.' });
      }
      throw err;
    }
    const check = await runConnectionCheck(getRow(id));
    res.status(201).json({ project: toPublic(getRow(id)), check });
  }));

  app.get('/api/projects/:id', requireAuth, (req, res) => {
    const row = getRow(req.params.id);
    res.json({ project: toPublic(row), checks: recentChecks(row.id) });
  });

  app.patch('/api/projects/:id', requireAuth, wrap(async (req, res) => {
    const row = getRow(req.params.id);
    const v = validateProjectInput(req.body, { partial: true });
    const replacingCredentials = v.clientId !== undefined;
    if (replacingCredentials && checksInFlight.has(row.id)) {
      throw new ApiError(409, 'check_in_progress', 'A connection check is running. Try again in a moment.');
    }
    const now = new Date().toISOString();
    try {
      db.prepare(`UPDATE projects SET name = ?, webhook_endpoint_url = ?, paypal_webhook_id = ?, forward_mode = ?, probe_url = ?, updated_at = ? WHERE id = ?`)
        .run(v.name ?? row.name, v.webhookEndpointUrl ?? row.webhook_endpoint_url,
          v.paypalWebhookId !== undefined ? v.paypalWebhookId : row.paypal_webhook_id, v.forwardMode ?? row.forward_mode, v.probeUrl !== undefined ? v.probeUrl : row.probe_url, now, row.id);
      if (replacingCredentials) {
        db.prepare(`UPDATE projects SET paypal_client_id = ?, paypal_secret_enc = ?, connection_status = 'unverified',
          connection_checked_at = NULL, connection_error_code = NULL, connection_error_message = NULL, paypal_app_id = NULL WHERE id = ?`)
          .run(v.clientId, cipher.encrypt(v.clientSecret, row.id), row.id);
      }
    } catch (err) {
      if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new ApiError(409, 'name_taken', 'A project with this name already exists.', { name: 'Choose a different name.' });
      }
      throw err;
    }
    const check = replacingCredentials ? await runConnectionCheck(getRow(row.id)) : null;
    res.json({ project: toPublic(getRow(row.id)), check, checks: recentChecks(row.id) });
  }));

  app.post('/api/projects/:id/validate', requireAuth, wrap(async (req, res) => {
    const row = getRow(req.params.id);
    const check = await runConnectionCheck(row);
    res.json({ project: toPublic(getRow(row.id)), check, checks: recentChecks(row.id) });
  }));

  app.delete('/api/projects/:id', requireAuth, (req, res) => {
    const row = getRow(req.params.id);
    if (checksInFlight.has(row.id)) {
      throw new ApiError(409, 'check_in_progress', 'A connection check is running. Try again in a moment.');
    }
    db.prepare('DELETE FROM projects WHERE id = ?').run(row.id);
    res.status(204).end();
  });

  const service = createPayPalService({ db, cipher, paypal });
  registerOrderRoutes({ app, db, paypal, service, config, requireAuth, wrap, getProjectRow: getRow });
  const forwarder = createForwarder({ db, config, paypal, service });
  app.locals.shutdown = () => forwarder.shutdown();
  registerWebhookRoutes({ app, db, paypal, service, config, requireAuth, wrap, getProjectRow: getRow, forwarder });
  registerScenarioRoutes({ app, db, forwarder, requireAuth, getProjectRow: getRow });
  registerReportRoutes({ app, db, forwarder, requireAuth, getProjectRow: getRow });
  registerAiRoutes({ app, db, config, forwarder, ai: aiProvider, requireAuth, wrap, getProjectRow: getRow });

  app.use('/api', (req, res, next) => next(new ApiError(404, 'not_found', 'No such API endpoint.')));

  // ---- static UI --------------------------------------------------------
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ---- errors -----------------------------------------------------------
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ApiError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, fields: err.fields, details: err.details } });
    }
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'invalid_json', message: 'The request body is not valid JSON.' } });
    }
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: { code: 'body_too_large', message: 'The request body is too large.' } });
    }
    // Log the message only: request bodies can contain secrets.
    console.error('[faultline] unhandled error:', err && err.message);
    res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong on the FAULTLINE server. Check the server console.' } });
  });

  return app;
}

module.exports = { createApp };
