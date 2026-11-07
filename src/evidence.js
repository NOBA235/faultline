'use strict';
const crypto = require('node:crypto');
const { fetchProbe, toCents } = require('./probe');

const iso = () => new Date().toISOString();
const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };

// Collects the evidence the checks need: what the application's probe reports, and what PayPal reports,
// before and after a scenario. Also assembles that evidence (plus stored PayPal data) into a check context.
function createEvidence({ db, config, paypal, service }) {
  const timeoutMs = config.forwardTimeoutMs || 10000;

  function save(runId, projectId, source, phase, r) {
    db.prepare(`INSERT OR REPLACE INTO run_snapshots (run_id, project_id, source, phase, taken_at, outcome, http_status, duration_ms, error_text, data_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(runId, projectId, source, phase, iso(), r.outcome, r.httpStatus ?? null, r.durationMs ?? 0, r.errorText ?? null, r.data ? JSON.stringify(r.data) : null);
  }

  async function paypalSnapshot(project, order) {
    const started = Date.now();
    try {
      const { result } = await service.callPayPal(project, 'get_order', order.id, (t) => paypal.getOrder(t, order.paypal_order_id));
      if (!result.ok) return { outcome: 'error', httpStatus: result.httpStatus, durationMs: Date.now() - started, errorText: `PayPal answered ${result.code}: ${result.message}`, data: null };
      const captures = [];
      for (const unit of Array.isArray(result.body.purchase_units) ? result.body.purchase_units : []) {
        const list = unit && unit.payments && Array.isArray(unit.payments.captures) ? unit.payments.captures : [];
        for (const c of list) if (c && typeof c.id === 'string') captures.push({ id: c.id, status: c.status || null, amount: c.amount && c.amount.value ? c.amount.value : null });
      }
      return { outcome: 'ok', httpStatus: result.httpStatus, durationMs: Date.now() - started, errorText: null,
        data: { orderStatus: typeof result.body.status === 'string' ? result.body.status : null, captureCount: captures.length, captures } };
    } catch (err) {
      return { outcome: 'error', httpStatus: null, durationMs: Date.now() - started, errorText: err && err.message ? err.message : 'PayPal could not be read.', data: null };
    }
  }

  // Reads the probe and (for events tied to an order Faultline created) the order at PayPal. Never throws.
  async function snapshot(project, event, run, phase) {
    const tasks = [];
    if (project.probe_url) {
      tasks.push(fetchProbe({ url: project.probe_url, eventId: event.paypal_event_id, resourceId: event.resource_id, eventType: event.event_type, timeoutMs })
        .then((r) => save(run.id, project.id, 'probe', phase, r)));
    }
    if (event.related_order_id) {
      const order = db.prepare('SELECT * FROM paypal_orders WHERE id = ? AND project_id = ?').get(event.related_order_id, project.id);
      if (order) tasks.push(paypalSnapshot(project, order).then((r) => save(run.id, project.id, 'paypal', phase, r)));
    }
    await Promise.all(tasks);
  }

  const snapshotsFor = (runId) => db.prepare('SELECT * FROM run_snapshots WHERE run_id = ? ORDER BY id').all(runId).map((s) => ({
    source: s.source, phase: s.phase, takenAt: s.taken_at, outcome: s.outcome, httpStatus: s.http_status, durationMs: s.duration_ms, errorText: s.error_text, data: s.data_json ? JSON.parse(s.data_json) : null,
  }));

  function captureIdOf(event, resource) {
    if (event.resource_type === 'capture' && typeof resource.id === 'string') return resource.id;
    if (event.resource_type === 'refund') {
      const up = Array.isArray(resource.links) ? resource.links.find((l) => l && l.rel === 'up') : null;
      const m = up && typeof up.href === 'string' ? up.href.match(/\/v2\/payments\/captures\/([A-Za-z0-9_-]+)$/) : null;
      return m ? m[1] : null;
    }
    return null;
  }

  // What PayPal has told us (verified events and saved captures) about one capture's amount and refunds.
  function moneyFor(project, event, resource) {
    const captureId = captureIdOf(event, resource);
    if (!captureId) return null;
    let captured = null;
    let currency = null;
    const fromAmount = (a) => (a && typeof a === 'object' ? { cents: toCents(a.value), cur: typeof a.currency_code === 'string' ? a.currency_code : null } : null);
    if (event.resource_type === 'capture') { const f = fromAmount(resource.amount); if (f && f.cents !== null) { captured = f.cents; currency = f.cur; } }
    if (captured === null) {
      const row = db.prepare('SELECT amount_value, currency_code FROM paypal_captures WHERE project_id = ? AND paypal_capture_id = ?').get(project.id, captureId);
      if (row && toCents(row.amount_value) !== null) { captured = toCents(row.amount_value); currency = row.currency_code; }
    }
    if (captured === null) {
      for (const e of db.prepare("SELECT raw_body FROM webhook_events WHERE project_id = ? AND verification_status = 'verified' AND resource_type = 'capture' AND resource_id = ?").all(project.id, captureId)) {
        const p = parse(e.raw_body.toString('utf8'));
        const f = p && p.resource ? fromAmount(p.resource.amount) : null;
        if (f && f.cents !== null) { captured = f.cents; currency = f.cur; break; }
      }
    }
    const refunds = new Map();
    for (const e of db.prepare("SELECT raw_body FROM webhook_events WHERE project_id = ? AND verification_status = 'verified' AND event_type = 'PAYMENT.CAPTURE.REFUNDED'").all(project.id)) {
      const p = parse(e.raw_body.toString('utf8'));
      const r = p && p.resource && typeof p.resource === 'object' ? p.resource : null;
      if (!r || typeof r.id !== 'string' || captureIdOf({ resource_type: 'refund' }, r) !== captureId) continue;
      const f = fromAmount(r.amount);
      if (f && f.cents !== null) refunds.set(r.id, f);
    }
    const list = [...refunds.values()];
    const curs = new Set(list.map((x) => x.cur));
    return {
      captureId, capturedCents: captured, currency,
      refundTotalCents: list.reduce((s, x) => s + x.cents, 0),
      refundCurrency: list.length ? (curs.size === 1 ? list[0].cur : 'MIXED') : currency,
      refundEventCount: list.length,
    };
  }

  function buildContext(project, run, event, attemptRows) {
    const payload = parse(event.raw_body.toString('utf8')) || {};
    const resource = payload.resource && typeof payload.resource === 'object' ? payload.resource : {};
    const snaps = db.prepare('SELECT * FROM run_snapshots WHERE run_id = ?').all(run.id);
    const pick = (source, phase) => {
      const s = snaps.find((x) => x.source === source && x.phase === phase);
      return s ? { outcome: s.outcome, errorText: s.error_text, data: s.data_json ? JSON.parse(s.data_json) : null } : null;
    };
    const createTime = typeof payload.create_time === 'string' ? payload.create_time : event.paypal_event_created_at;
    const sentTimes = attemptRows.filter((a) => !['dropped', 'blocked'].includes(a.outcome)).map((a) => a.sent_at).sort();
    let newerDelivered = [];
    if (createTime && sentTimes.length) {
      newerDelivered = db.prepare(`SELECT e2.paypal_event_id AS paypalEventId, e2.event_type AS eventType, e2.paypal_event_created_at AS createTime, MIN(a.sent_at) AS deliveredAt
        FROM webhook_events e2 JOIN forward_attempts a ON a.event_id = e2.id AND a.outcome = 'delivered' AND a.run_id != ?
        WHERE e2.project_id = ? AND e2.id != ? AND e2.verification_status = 'verified' AND e2.paypal_event_created_at > ?
          AND ((e2.related_order_id IS NOT NULL AND e2.related_order_id = ?) OR (e2.resource_id IS NOT NULL AND e2.resource_id = ?))
          AND a.sent_at < ?
        GROUP BY e2.id ORDER BY deliveredAt`).all(run.id, project.id, event.id, createTime, event.related_order_id, event.resource_id, sentTimes[0]);
    }
    return {
      run: { kind: run.kind },
      event: {
        eventType: event.event_type, resourceType: event.resource_type, resourceId: event.resource_id, createTime,
        rawSha256: crypto.createHash('sha256').update(event.raw_body).digest('hex'), transmissionId: event.transmission_id,
      },
      attempts: attemptRows.map((a) => ({ attemptNo: a.attempt_no, outcome: a.outcome, httpStatus: a.http_status, sentAt: a.sent_at, bodySha256: a.body_sha256, requestHeaders: parse(a.request_headers_json) || {} })),
      probe: { configured: Boolean(project.probe_url), settleMs: config.probeSettleMs ?? 500, before: pick('probe', 'before'), after: pick('probe', 'after') },
      paypal: { applicable: Boolean(event.related_order_id), before: pick('paypal', 'before'), after: pick('paypal', 'after') },
      newerDelivered,
      money: moneyFor(project, event, resource),
    };
  }

  function persist(run, projectId, result) {
    const now = iso();
    db.transaction(() => {
      db.prepare('DELETE FROM assertion_results WHERE run_id = ?').run(run.id);
      const ins = db.prepare(`INSERT INTO assertion_results (run_id, project_id, check_id, category, name, verdict, summary, evidence_json, evaluated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const a of result.assertions) ins.run(run.id, projectId, a.id, a.category, a.name, a.verdict, a.summary, JSON.stringify(a.evidence), now);
    })();
  }

  return { snapshot, buildContext, persist, snapshotsFor };
}

module.exports = { createEvidence };
