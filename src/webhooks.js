'use strict';
const crypto = require('node:crypto');
const express = require('express');
const { ApiError } = require('./errors');

const iso = () => new Date().toISOString();
const str = (v, max = 200) => (typeof v === 'string' && v !== '' ? v.slice(0, max) : null);
const KEEP_HEADERS = ['content-type', 'user-agent', 'correlation-id', 'paypal-auth-algo', 'paypal-auth-version',
  'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time'];
const STATUSES = ['verified', 'failed', 'error', 'unverified'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function registerWebhookRoutes({ app, db, paypal, service, config, requireAuth, wrap, getProjectRow, forwarder }) {
  const { callPayPal, toApiError } = service;
  const hits = new Map(); // ip -> { count, resetAt }
  const busy = new Set();

  const pickHeaders = (h) => Object.fromEntries(KEEP_HEADERS.filter((k) => typeof h[k] === 'string').map((k) => [k, h[k].slice(0, 600)]));

  function rateLimited(ip) {
    const now = Date.now();
    const r = hits.get(ip);
    if (!r || r.resetAt < now) { hits.set(ip, { count: 1, resetAt: now + 60000 }); return false; }
    r.count += 1;
    return r.count > 600;
  }

  // Asks PayPal to verify the delivery. Never returns "verified" unless PayPal said SUCCESS.
  async function verifySignature(project, headers, rawBuf) {
    if (!project.paypal_webhook_id) {
      return { status: 'unverified', code: 'webhook_not_configured', detail: 'This project has no PayPal Webhook ID yet, so the signature could not be checked. Add the Webhook ID from the PayPal Developer Dashboard.' };
    }
    const f = {
      authAlgo: headers['paypal-auth-algo'], certUrl: headers['paypal-cert-url'], transmissionId: headers['paypal-transmission-id'],
      transmissionSig: headers['paypal-transmission-sig'], transmissionTime: headers['paypal-transmission-time'], webhookId: project.paypal_webhook_id,
    };
    const missing = Object.entries(f).filter(([, v]) => typeof v !== 'string' || v === '').map(([k]) => k);
    if (missing.length) {
      return { status: 'failed', code: 'missing_signature_headers', detail: `This request did not include PayPal's signature headers (${missing.join(', ')}), so it is not a signed PayPal delivery.` };
    }
    let certOk = false;
    try {
      const u = new URL(f.certUrl);
      certOk = u.protocol === 'https:' && (u.hostname === 'paypal.com' || u.hostname.endsWith('.paypal.com')) && f.certUrl.length <= 500;
    } catch { certOk = false; }
    if (!certOk) {
      return { status: 'failed', code: 'cert_url_not_paypal', detail: 'The certificate URL header does not point to an https paypal.com address, so the delivery was not sent to PayPal for verification.' };
    }
    if (!/^[a-zA-Z0-9]+$/.test(f.authAlgo) || f.transmissionId.length > 50) {
      return { status: 'failed', code: 'malformed_signature_headers', detail: 'The PayPal signature headers are malformed.' };
    }

    let result;
    try {
      ({ result } = await callPayPal(project, 'verify_webhook_signature', null, (t) => paypal.verifyWebhookSignature(t, f, rawBuf.toString('utf8'))));
    } catch (err) {
      if (err instanceof ApiError) return { status: 'error', code: err.code, detail: `Could not ask PayPal to verify: ${err.message}` };
      throw err;
    }
    if (!result.ok) {
      const e = toApiError(result);
      return { status: 'error', code: e.code, detail: `Could not ask PayPal to verify: ${e.message}` };
    }
    const vs = result.body.verification_status;
    if (vs === 'SUCCESS') return { status: 'verified', code: 'ok', detail: 'PayPal confirmed the signature (verification_status SUCCESS).' };
    if (vs === 'FAILURE') {
      return { status: 'failed', code: 'signature_invalid', detail: 'PayPal reported verification_status FAILURE, so this delivery is not confirmed as coming from PayPal. Common causes: a wrong Webhook ID, an event from the Webhooks Simulator (it cannot be verified), or an altered or forged request.' };
    }
    return { status: 'error', code: 'unexpected_verification_response', detail: 'PayPal answered without a recognizable verification_status.' };
  }

  function describeEvent(obj) {
    const r = obj.resource && typeof obj.resource === 'object' ? obj.resource : {};
    return {
      paypalEventId: str(obj.id, 100), eventType: str(obj.event_type, 100), resourceType: str(obj.resource_type, 100),
      resourceId: str(r.id, 100), createdAt: str(obj.create_time, 40),
    };
  }

  // Links an event to a Faultline-created order using the custom_id Faultline sends, or PayPal's own IDs.
  function findOrder(projectId, obj) {
    const r = obj.resource && typeof obj.resource === 'object' ? obj.resource : {};
    const unit = Array.isArray(r.purchase_units) ? r.purchase_units[0] : null;
    for (const c of [r.custom_id, unit && unit.custom_id]) {
      const m = typeof c === 'string' ? c.match(/^faultline:([0-9a-f-]{36})$/) : null;
      if (m) {
        const row = db.prepare('SELECT id FROM paypal_orders WHERE id = ? AND project_id = ?').get(m[1], projectId);
        if (row) return row.id;
      }
    }
    const related = r.supplementary_data && r.supplementary_data.related_ids ? r.supplementary_data.related_ids.order_id : null;
    const orderIds = [related, typeof obj.event_type === 'string' && obj.event_type.startsWith('CHECKOUT.ORDER.') ? r.id : null];
    for (const id of orderIds) {
      if (typeof id !== 'string') continue;
      const row = db.prepare('SELECT id FROM paypal_orders WHERE paypal_order_id = ? AND project_id = ?').get(id, projectId);
      if (row) return row.id;
    }
    if (typeof r.id === 'string') {
      const cap = db.prepare('SELECT order_id FROM paypal_captures WHERE paypal_capture_id = ? AND project_id = ?').get(r.id, projectId);
      if (cap) return cap.order_id;
    }
    return null;
  }

  function recordDelivery(d) {
    db.prepare(`INSERT INTO webhook_deliveries
      (project_id, event_id, received_at, transmission_id, transmission_time, verification_status, response_status, is_redelivery, body_bytes, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(d.projectId, d.eventId, d.receivedAt, str(d.headers['paypal-transmission-id'], 100), str(d.headers['paypal-transmission-time'], 60),
        d.status, d.responseStatus, d.redelivery ? 1 : 0, d.bytes, d.note ? d.note.slice(0, 500) : null);
  }

  // ---- public receiver (PayPal calls this) ---------------------------------
  app.post('/webhooks/paypal/:projectId', express.raw({ type: () => true, limit: '1mb' }), wrap(async (req, res) => {
    if (rateLimited(req.ip || 'unknown')) return res.status(429).json({ received: false, error: 'rate_limited' });
    const project = UUID_RE.test(req.params.projectId) ? db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.projectId) : null;
    if (!project) return res.status(404).json({ received: false, error: 'unknown_project' });

    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const receivedAt = iso();
    const headers = pickHeaders(req.headers);

    let obj = null;
    try { obj = JSON.parse(raw.toString('utf8')); } catch { obj = null; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      recordDelivery({ projectId: project.id, eventId: null, receivedAt, headers, status: 'failed', responseStatus: 400, redelivery: false, bytes: raw.length, note: 'The body was empty or not a JSON object. Nothing was stored as an event.' });
      return res.status(400).json({ received: false, error: 'malformed_body' });
    }

    const sig = await verifySignature(project, req.headers, raw);
    const meta = describeEvent(obj);
    let eventId = null;
    let redelivery = false;

    if (sig.status === 'verified' && meta.paypalEventId) {
      const existing = db.prepare("SELECT id FROM webhook_events WHERE project_id = ? AND paypal_event_id = ? AND verification_status = 'verified'").get(project.id, meta.paypalEventId);
      if (existing) { eventId = existing.id; redelivery = true; }
    }
    if (!eventId) {
      const orderId = findOrder(project.id, obj);
      const insert = () => {
        const id = crypto.randomUUID();
        db.prepare(`INSERT INTO webhook_events
          (id, project_id, paypal_event_id, event_type, resource_type, resource_id, paypal_event_created_at, transmission_id, transmission_time,
           first_received_at, raw_body, headers_json, verification_status, verification_code, verification_detail, related_order_id, origin)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, project.id, meta.paypalEventId, meta.eventType, meta.resourceType, meta.resourceId, meta.createdAt,
            str(headers['paypal-transmission-id'], 100), str(headers['paypal-transmission-time'], 60), receivedAt, raw,
            JSON.stringify(headers), sig.status, sig.code, sig.detail, orderId, orderId ? 'faultline_order' : 'unlinked');
        return id;
      };
      try {
        eventId = insert();
      } catch (err) {
        if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
          // Two copies of the same verified event arrived at once.
          const ex = db.prepare("SELECT id FROM webhook_events WHERE project_id = ? AND paypal_event_id = ? AND verification_status = 'verified'").get(project.id, meta.paypalEventId);
          if (!ex) throw err;
          eventId = ex.id;
          redelivery = true;
        } else throw err;
      }
    }

    // 200 only for a verified delivery. Forged or unsigned requests get 401; when PayPal could not be asked
    // (or the project has no Webhook ID yet) we answer 503 so PayPal retries later. Everything is stored.
    const responseStatus = sig.status === 'verified' ? 200 : sig.status === 'failed' ? 401 : 503;
    recordDelivery({ projectId: project.id, eventId, receivedAt, headers, status: sig.status, responseStatus, redelivery, bytes: raw.length, note: sig.detail });
    // Automatic mode: pass each NEW verified event on to the project's endpoint, after PayPal has its answer.
    // PayPal's own redeliveries are recorded above but not forwarded again; the duplicate scenario produces duplicates on purpose.
    if (sig.status === 'verified' && !redelivery && project.forward_mode === 'auto') forwarder.autoForward(project, eventId);
    res.status(responseStatus).json({ received: true, verification: sig.status, eventId, redelivery });
  }));

  // ---- authenticated API -----------------------------------------------------
  const publicEvent = (e) => ({
    id: e.id,
    paypalEventId: e.paypal_event_id,
    eventType: e.event_type,
    resourceType: e.resource_type,
    resourceId: e.resource_id,
    paypalEventCreatedAt: e.paypal_event_created_at,
    originalDeliveryTime: e.transmission_time,
    receivedAt: e.first_received_at,
    verification: { status: e.verification_status, code: e.verification_code, detail: e.verification_detail },
    processingStatus: e.processing_status,
    origin: e.origin,
    relatedOrder: e.related_order_id ? { id: e.related_order_id, paypalOrderId: e.paypal_order_id ?? null } : null,
    deliveryCount: e.delivery_count ?? undefined,
  });

  const likeEscape = (s) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

  app.get('/api/projects/:id/events', requireAuth, (req, res) => {
    const project = getProjectRow(req.params.id);
    const where = ['e.project_id = ?'];
    const args = [project.id];
    if (req.query.status !== undefined) {
      if (!STATUSES.includes(req.query.status)) throw new ApiError(400, 'validation_failed', 'Unknown verification status filter.');
      where.push('e.verification_status = ?'); args.push(req.query.status);
    }
    if (typeof req.query.type === 'string' && req.query.type) { where.push('e.event_type = ?'); args.push(req.query.type.slice(0, 100)); }
    if (typeof req.query.q === 'string' && req.query.q.trim()) {
      const like = likeEscape(req.query.q.trim().slice(0, 100));
      where.push("(e.paypal_event_id LIKE ? ESCAPE '\\' OR e.resource_id LIKE ? ESCAPE '\\' OR e.event_type LIKE ? ESCAPE '\\')");
      args.push(like, like, like);
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM webhook_events e WHERE ${where.join(' AND ')}`).get(...args).n;
    const rows = db.prepare(`SELECT e.*, o.paypal_order_id,
        (SELECT COUNT(*) FROM webhook_deliveries d WHERE d.event_id = e.id) AS delivery_count
      FROM webhook_events e LEFT JOIN paypal_orders o ON o.id = e.related_order_id
      WHERE ${where.join(' AND ')} ORDER BY e.first_received_at DESC, e.rowid DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    const eventTypes = db.prepare('SELECT DISTINCT event_type FROM webhook_events WHERE project_id = ? AND event_type IS NOT NULL ORDER BY event_type').all(project.id).map((r) => r.event_type);
    res.json({ events: rows.map(publicEvent), total, eventTypes });
  });

  function eventDetail(project, eventId) {
    const e = db.prepare(`SELECT e.*, o.paypal_order_id FROM webhook_events e LEFT JOIN paypal_orders o ON o.id = e.related_order_id
      WHERE e.id = ? AND e.project_id = ?`).get(eventId, project.id);
    if (!e) throw new ApiError(404, 'not_found', 'Event not found.');
    const rawText = e.raw_body.toString('utf8');
    let payload = null;
    try { payload = JSON.parse(rawText); } catch { payload = null; }
    const deliveries = db.prepare('SELECT * FROM webhook_deliveries WHERE event_id = ? ORDER BY id').all(e.id).map(publicDelivery);
    const runs = db.prepare('SELECT id, kind, status, verdict, planned_attempts, created_at FROM scenario_runs WHERE event_id = ? ORDER BY created_at DESC, rowid DESC').all(e.id)
      .map((r) => ({ id: r.id, kind: r.kind, status: r.status, verdict: r.verdict, plannedAttempts: r.planned_attempts, createdAt: r.created_at }));
    return { event: publicEvent(e), headers: JSON.parse(e.headers_json), payload, rawText, rawBytes: e.raw_body.length, deliveries, runs };
  }

  const publicDelivery = (d) => ({
    id: d.id, eventId: d.event_id, receivedAt: d.received_at, transmissionId: d.transmission_id, transmissionTime: d.transmission_time,
    verificationStatus: d.verification_status, responseStatus: d.response_status, isRedelivery: Boolean(d.is_redelivery),
    bodyBytes: d.body_bytes, note: d.note,
    ...(d.event_type !== undefined ? { eventType: d.event_type, paypalEventId: d.paypal_event_id } : {}),
  });

  app.get('/api/projects/:id/events/:eventId', requireAuth, (req, res) => {
    res.json(eventDetail(getProjectRow(req.params.id), req.params.eventId));
  });

  app.get('/api/projects/:id/webhook-deliveries', requireAuth, (req, res) => {
    const project = getProjectRow(req.params.id);
    const rows = db.prepare(`SELECT d.*, e.event_type, e.paypal_event_id FROM webhook_deliveries d
      LEFT JOIN webhook_events e ON e.id = d.event_id WHERE d.project_id = ? ORDER BY d.id DESC LIMIT 30`).all(project.id);
    res.json({ deliveries: rows.map(publicDelivery) });
  });

  // Re-asks PayPal to verify a stored delivery (for example after adding the Webhook ID).
  app.post('/api/projects/:id/events/:eventId/reverify', requireAuth, wrap(async (req, res) => {
    const project = getProjectRow(req.params.id);
    const e = db.prepare('SELECT * FROM webhook_events WHERE id = ? AND project_id = ?').get(req.params.eventId, project.id);
    if (!e) throw new ApiError(404, 'not_found', 'Event not found.');
    if (e.verification_status === 'verified') throw new ApiError(409, 'already_verified', 'This event is already verified.');
    if (busy.has(e.id)) throw new ApiError(409, 'operation_in_progress', 'A verification for this event is already running.');
    busy.add(e.id);
    try {
      const sig = await verifySignature(project, JSON.parse(e.headers_json), e.raw_body);
      if (sig.status === 'verified' && e.paypal_event_id) {
        const dup = db.prepare("SELECT id FROM webhook_events WHERE project_id = ? AND paypal_event_id = ? AND verification_status = 'verified'").get(project.id, e.paypal_event_id);
        if (dup) throw new ApiError(409, 'duplicate_verified_event', 'PayPal confirms this delivery, but a verified copy of the same event is already stored. This copy was left unchanged.');
      }
      db.prepare('UPDATE webhook_events SET verification_status = ?, verification_code = ?, verification_detail = ? WHERE id = ?').run(sig.status, sig.code, sig.detail, e.id);
    } finally {
      busy.delete(e.id);
    }
    res.json(eventDetail(project, e.id));
  }));
}

module.exports = { registerWebhookRoutes };
