'use strict';
const crypto = require('node:crypto');
const { ApiError } = require('./errors');
const { validateOrderInput } = require('./validation');
const { ID_RE } = require('./paypal');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const iso = () => new Date().toISOString();
const str = (v, max = 100) => (typeof v === 'string' ? v.slice(0, max) : null);

// Only links that point at a paypal.com host over https are ever shown to the user.
function safePayPalLink(href) {
  try {
    const u = new URL(href);
    return u.protocol === 'https:' && (u.hostname === 'paypal.com' || u.hostname.endsWith('.paypal.com')) ? u.toString() : null;
  } catch {
    return null;
  }
}

function findApproveUrl(body) {
  const links = Array.isArray(body && body.links) ? body.links : [];
  const link = links.find((l) => l && (l.rel === 'payer-action' || l.rel === 'approve'));
  return link ? safePayPalLink(link.href) : null;
}

function extractCaptures(body) {
  const out = [];
  for (const unit of Array.isArray(body && body.purchase_units) ? body.purchase_units : []) {
    const list = unit && unit.payments && Array.isArray(unit.payments.captures) ? unit.payments.captures : [];
    for (const c of list) {
      if (!c || typeof c.id !== 'string' || !ID_RE.test(c.id)) continue;
      out.push({
        paypalId: c.id,
        status: str(c.status, 40) || 'UNKNOWN',
        value: c.amount && typeof c.amount.value === 'string' ? c.amount.value.slice(0, 32) : null,
        currency: c.amount && typeof c.amount.currency_code === 'string' ? c.amount.currency_code.slice(0, 8) : null,
        finalCapture: typeof c.final_capture === 'boolean' ? (c.final_capture ? 1 : 0) : null,
        createTime: str(c.create_time, 40),
        updateTime: str(c.update_time, 40),
        raw: c,
      });
    }
  }
  return out;
}

function registerOrderRoutes({ app, db, paypal, service, config, requireAuth, wrap, getProjectRow }) {
  const { callPayPal, toApiError } = service;
  const publicBase = (config.publicBaseUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const busy = new Set();

  // ---- helpers --------------------------------------------------------
  async function withLock(key, fn) {
    if (busy.has(key)) throw new ApiError(409, 'operation_in_progress', 'Another request for this order is already running. Try again in a moment.');
    busy.add(key);
    try {
      return await fn();
    } finally {
      busy.delete(key);
    }
  }

  const getOrderRow = (projectId, orderId) => {
    const row = db.prepare('SELECT * FROM paypal_orders WHERE id = ? AND project_id = ?').get(orderId, projectId);
    if (!row) throw new ApiError(404, 'not_found', 'Order not found.');
    return row;
  };

  const publicOrder = (r) => ({
    id: r.id,
    paypalOrderId: r.paypal_order_id,
    intent: r.intent,
    status: r.status,
    amount: { value: r.amount_value, currencyCode: r.currency_code },
    description: r.description,
    approveUrl: r.approve_url,
    customId: `faultline:${r.id}`,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastSyncedAt: r.last_synced_at,
  });

  const publicCapture = (r, withRaw) => ({
    id: r.id,
    orderId: r.order_id,
    paypalCaptureId: r.paypal_capture_id,
    status: r.status,
    amount: r.amount_value === null ? null : { value: r.amount_value, currencyCode: r.currency_code },
    finalCapture: r.final_capture === null ? null : Boolean(r.final_capture),
    paypalCreatedAt: r.paypal_created_at,
    paypalUpdatedAt: r.paypal_updated_at,
    lastSyncedAt: r.last_synced_at,
    ...(withRaw ? { raw: JSON.parse(r.raw_json) } : {}),
  });

  function orderDetail(order) {
    const captures = db.prepare('SELECT * FROM paypal_captures WHERE order_id = ? ORDER BY created_at, rowid').all(order.id).map((c) => publicCapture(c, true));
    return { order: publicOrder(order), captures, raw: JSON.parse(order.raw_json) };
  }

  function upsertCaptures(projectId, orderId, captures, now) {
    const stmt = db.prepare(`INSERT INTO paypal_captures
      (id, order_id, project_id, paypal_capture_id, status, amount_value, currency_code, final_capture, paypal_created_at, paypal_updated_at, raw_json, created_at, last_synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (project_id, paypal_capture_id) DO UPDATE SET
        status = excluded.status, amount_value = excluded.amount_value, currency_code = excluded.currency_code,
        final_capture = excluded.final_capture, paypal_created_at = excluded.paypal_created_at,
        paypal_updated_at = excluded.paypal_updated_at, raw_json = excluded.raw_json, last_synced_at = excluded.last_synced_at`);
    for (const c of captures) {
      stmt.run(crypto.randomUUID(), orderId, projectId, c.paypalId, c.status, c.value, c.currency, c.finalCapture, c.createTime, c.updateTime, JSON.stringify(c.raw), now, now);
    }
  }

  // Saves what PayPal said about an order (status, full response, any captures it contains).
  function applyOrderResponse(order, body) {
    const now = iso();
    const status = typeof body.status === 'string' ? body.status.slice(0, 40) : order.status;
    const captures = extractCaptures(body);
    db.transaction(() => {
      db.prepare('UPDATE paypal_orders SET status = ?, raw_json = ?, approve_url = COALESCE(?, approve_url), updated_at = ?, last_synced_at = ? WHERE id = ?')
        .run(status, JSON.stringify(body), findApproveUrl(body), now, now, order.id);
      upsertCaptures(order.project_id, order.id, captures, now);
    })();
    return captures.length;
  }

  async function refreshOrderFromPayPal(project, order) {
    const { result } = await callPayPal(project, 'get_order', order.id, (t) => paypal.getOrder(t, order.paypal_order_id));
    if (!result.ok) throw toApiError(result);
    applyOrderResponse(order, result.body);
  }

  const findByKey = (projectId, key) => db.prepare('SELECT * FROM paypal_orders WHERE project_id = ? AND idempotency_key = ?').get(projectId, key);

  // ---- routes ---------------------------------------------------------
  app.post('/api/projects/:id/orders', requireAuth, wrap(async (req, res) => {
    const project = getProjectRow(req.params.id);
    const v = validateOrderInput(req.body);
    const key = v.idempotencyKey || crypto.randomUUID();

    const existing = findByKey(project.id, key);
    if (existing) return res.status(200).json({ order: publicOrder(existing), duplicate: true });

    const localId = crypto.randomUUID();
    const { result, callIds } = await callPayPal(project, 'create_order', null, (t) => paypal.createOrder(t, {
      amount: v.amount,
      currency: v.currency,
      description: v.description,
      customId: `faultline:${localId}`,
      // PayPal stores request IDs per merchant account, so scope ours to project + key.
      requestId: `fl-${sha256(`${project.id}:${key}`).slice(0, 64)}`,
      returnUrl: `${publicBase}/paypal-return.html`,
      cancelUrl: `${publicBase}/paypal-return.html`,
    }));
    if (!result.ok) throw toApiError(result);

    const body = result.body;
    if (typeof body.id !== 'string' || !ID_RE.test(body.id)) {
      throw new ApiError(502, 'paypal_malformed_response', 'PayPal answered successfully but the response had no usable order ID, so nothing was saved.', undefined,
        { httpStatus: result.httpStatus, name: 'MALFORMED_RESPONSE', message: null, debugId: result.debugId, issues: [] });
    }

    const now = iso();
    const status = typeof body.status === 'string' ? body.status.slice(0, 40) : 'UNKNOWN';
    let row;
    try {
      db.prepare(`INSERT INTO paypal_orders
        (id, project_id, paypal_order_id, idempotency_key, intent, amount_value, currency_code, description, status, approve_url, raw_json, created_at, updated_at, last_synced_at)
        VALUES (?, ?, ?, ?, 'CAPTURE', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(localId, project.id, body.id, key, v.amount, v.currency, v.description ?? null, status, findApproveUrl(body), JSON.stringify(body), now, now, now);
      row = getOrderRow(project.id, localId);
    } catch (err) {
      if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        // Same request arrived twice at once: PayPal returned the same order for the same Request-Id.
        const dup = findByKey(project.id, key);
        if (dup) {
          for (const id of callIds) db.prepare('UPDATE paypal_api_calls SET order_id = ? WHERE id = ?').run(dup.id, id);
          return res.status(200).json({ order: publicOrder(dup), duplicate: true });
        }
      }
      throw err;
    }
    for (const id of callIds) db.prepare('UPDATE paypal_api_calls SET order_id = ? WHERE id = ?').run(localId, id);
    res.status(201).json({ order: publicOrder(row), duplicate: false });
  }));

  app.get('/api/projects/:id/orders', requireAuth, (req, res) => {
    const project = getProjectRow(req.params.id);
    const rows = db.prepare('SELECT * FROM paypal_orders WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100').all(project.id);
    res.json({ orders: rows.map(publicOrder) });
  });

  app.get('/api/projects/:id/orders/:orderId', requireAuth, (req, res) => {
    const project = getProjectRow(req.params.id);
    res.json(orderDetail(getOrderRow(project.id, req.params.orderId)));
  });

  app.get('/api/projects/:id/paypal-calls', requireAuth, (req, res) => {
    const project = getProjectRow(req.params.id);
    const rows = db.prepare(`SELECT c.*, o.paypal_order_id FROM paypal_api_calls c
      LEFT JOIN paypal_orders o ON o.id = c.order_id WHERE c.project_id = ? ORDER BY c.id DESC LIMIT 20`).all(project.id);
    res.json({ calls: rows.map((c) => ({
      id: c.id, calledAt: c.called_at, operation: c.operation, method: c.method, path: c.path, httpStatus: c.http_status,
      durationMs: c.duration_ms, outcome: c.outcome, errorName: c.error_name, errorMessage: c.error_message,
      paypalDebugId: c.paypal_debug_id, paypalOrderId: c.paypal_order_id,
    })) });
  });

  app.post('/api/projects/:id/orders/:orderId/refresh', requireAuth, wrap(async (req, res) => {
    const project = getProjectRow(req.params.id);
    const order = getOrderRow(project.id, req.params.orderId);
    await withLock(order.id, () => refreshOrderFromPayPal(project, order));
    res.json(orderDetail(getOrderRow(project.id, order.id)));
  }));

  app.post('/api/projects/:id/orders/:orderId/capture', requireAuth, wrap(async (req, res) => {
    const project = getProjectRow(req.params.id);
    const order = getOrderRow(project.id, req.params.orderId);
    await withLock(order.id, async () => {
      const already = db.prepare('SELECT 1 FROM paypal_captures WHERE order_id = ?').get(order.id);
      if (order.status === 'COMPLETED' && already) {
        throw new ApiError(409, 'already_captured', 'This order is already captured. Nothing was sent to PayPal.');
      }
      const { result } = await callPayPal(project, 'capture_order', order.id,
        (t) => paypal.captureOrder(t, order.paypal_order_id, `fl-capture-${order.id}`));
      if (!result.ok) throw toApiError(result);
      const found = applyOrderResponse(order, result.body);
      // If PayPal reports the order completed but returned no capture, read the order back instead of guessing.
      if (found === 0) await refreshOrderFromPayPal(project, getOrderRow(project.id, order.id));
    });
    res.json(orderDetail(getOrderRow(project.id, order.id)));
  }));

  app.post('/api/projects/:id/orders/:orderId/captures/:captureId/refresh', requireAuth, wrap(async (req, res) => {
    const project = getProjectRow(req.params.id);
    const order = getOrderRow(project.id, req.params.orderId);
    const cap = db.prepare('SELECT * FROM paypal_captures WHERE id = ? AND order_id = ?').get(req.params.captureId, order.id);
    if (!cap) throw new ApiError(404, 'not_found', 'Capture not found.');
    await withLock(order.id, async () => {
      const { result } = await callPayPal(project, 'get_capture', order.id, (t) => paypal.getCapture(t, cap.paypal_capture_id));
      if (!result.ok) throw toApiError(result);
      const [parsed] = extractCaptures({ purchase_units: [{ payments: { captures: [result.body] } }] });
      if (!parsed) {
        throw new ApiError(502, 'paypal_malformed_response', 'PayPal returned capture details without a usable capture ID, so nothing was updated.');
      }
      upsertCaptures(project.id, order.id, [parsed], iso());
    });
    res.json(orderDetail(getOrderRow(project.id, order.id)));
  }));
}

module.exports = { registerOrderRoutes, extractCaptures, safePayPalLink };
