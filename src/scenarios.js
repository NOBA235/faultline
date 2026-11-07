'use strict';
const { ApiError } = require('./errors');
const { LIMITS, KINDS } = require('./forwarder');

const KEY_RE = /^[A-Za-z0-9_-]{8,100}$/;

function parseScenarioInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'invalid_body', 'The request body must be a JSON object.');
  const fields = {};
  const out = { params: {} };
  if (!KINDS.includes(body.kind)) fields.kind = `Choose one of: ${KINDS.join(', ')}.`;
  else out.kind = body.kind;

  const asInt = (v) => (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v)) ? Number(v) : NaN);
  if (body.kind === 'duplicate') {
    const n = asInt(body.count);
    if (!Number.isInteger(n) || n < 2 || n > LIMITS.maxDuplicates) fields.count = `Choose how many deliveries to send in total, from 2 to ${LIMITS.maxDuplicates}.`;
    else out.params.count = n;
    const mode = body.mode === undefined ? 'sequential' : body.mode;
    if (mode !== 'sequential' && mode !== 'concurrent') fields.mode = 'Choose sequential or concurrent.';
    else out.params.mode = mode;
  }
  if (body.kind === 'delay') {
    const s = asInt(body.delaySeconds);
    if (!Number.isInteger(s) || s < LIMITS.minDelaySeconds || s > LIMITS.maxDelaySeconds) fields.delaySeconds = `Choose a delay from ${LIMITS.minDelaySeconds} to ${LIMITS.maxDelaySeconds} seconds.`;
    else out.params.delaySeconds = s;
  }
  if (body.idempotencyKey !== undefined && body.idempotencyKey !== null) {
    if (typeof body.idempotencyKey !== 'string' || !KEY_RE.test(body.idempotencyKey)) fields.idempotencyKey = 'The idempotency key must be 8 to 100 letters, numbers, - or _.';
    else out.idempotencyKey = body.idempotencyKey;
  }
  if (Object.keys(fields).length) throw new ApiError(400, 'validation_failed', 'Some fields need attention.', fields);
  return out;
}

function registerScenarioRoutes({ app, db, forwarder, requireAuth, getProjectRow }) {
  const publicRun = (r) => ({
    id: r.id, eventId: r.event_id, kind: r.kind, label: forwarder.LABELS[r.kind], triggeredBy: r.triggered_by, status: r.status,
    plannedAttempts: r.planned_attempts, destination: r.destination_url, params: JSON.parse(r.params_json),
    createdAt: r.created_at, scheduledFor: r.scheduled_for, startedAt: r.started_at, finishedAt: r.finished_at, errorText: r.error_text,
    verdict: r.verdict || null,
  });

  const publicAttempt = (a) => ({
    id: a.id, attemptNo: a.attempt_no, deliveryKind: a.delivery_kind, destination: a.destination_url, sentAt: a.sent_at, durationMs: a.duration_ms,
    outcome: a.outcome, httpStatus: a.http_status, errorText: a.error_text, responseSnippet: a.response_snippet, responseBytes: a.response_bytes,
    bodySha256: a.body_sha256, requestHeaders: JSON.parse(a.request_headers_json),
  });

  const getEventRow = (projectId, eventId) => {
    const e = db.prepare('SELECT * FROM webhook_events WHERE id = ? AND project_id = ?').get(eventId, projectId);
    if (!e) throw new ApiError(404, 'not_found', 'Event not found.');
    return e;
  };
  const getRunRow = (projectId, runId) => {
    const r = db.prepare('SELECT * FROM scenario_runs WHERE id = ? AND project_id = ?').get(runId, projectId);
    if (!r) throw new ApiError(404, 'not_found', 'Scenario run not found.');
    return r;
  };

  app.post('/api/projects/:id/events/:eventId/scenarios', requireAuth, (req, res) => {
    const project = getProjectRow(req.params.id);
    const event = getEventRow(project.id, req.params.eventId);
    const input = parseScenarioInput(req.body);
    if (event.verification_status !== 'verified') {
      throw new ApiError(409, 'event_not_verified', 'Only events that PayPal verified can be forwarded or used in tests. Verify this event first, or use a different one.');
    }
    const { run, duplicate } = forwarder.startRun(project, event, { kind: input.kind, params: input.params, idempotencyKey: input.idempotencyKey });
    res.status(duplicate ? 200 : 202).json({ run: publicRun(run), duplicate });
  });

  app.get('/api/projects/:id/scenario-runs', requireAuth, (req, res) => {
    const project = getProjectRow(req.params.id);
    const where = ['r.project_id = ?'];
    const args = [project.id];
    if (typeof req.query.eventId === 'string' && req.query.eventId) { where.push('r.event_id = ?'); args.push(req.query.eventId); }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
    const rows = db.prepare(`SELECT r.*, e.paypal_event_id, e.event_type FROM scenario_runs r JOIN webhook_events e ON e.id = r.event_id
      WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC, r.rowid DESC LIMIT ?`).all(...args, limit);
    res.json({
      runs: rows.map((r) => {
        const attempts = db.prepare('SELECT * FROM forward_attempts WHERE run_id = ? ORDER BY attempt_no').all(r.id);
        const sent = attempts.filter((a) => !['dropped', 'blocked'].includes(a.outcome));
        return { ...publicRun(r), paypalEventId: r.paypal_event_id, eventType: r.event_type, requestsSent: sent.length,
          statusCodes: sent.map((a) => a.http_status), dropped: attempts.some((a) => a.outcome === 'dropped') };
      }),
    });
  });

  app.get('/api/projects/:id/scenario-runs/:runId', requireAuth, (req, res) => {
    const project = getProjectRow(req.params.id);
    const run = getRunRow(project.id, req.params.runId);
    const event = db.prepare('SELECT * FROM webhook_events WHERE id = ?').get(run.event_id);
    const attempts = db.prepare('SELECT * FROM forward_attempts WHERE run_id = ? ORDER BY attempt_no').all(run.id);
    const assertions = db.prepare('SELECT * FROM assertion_results WHERE run_id = ? ORDER BY id').all(run.id).map((a) => ({
      id: a.check_id, category: a.category, name: a.name, verdict: a.verdict, summary: a.summary, evidence: JSON.parse(a.evidence_json),
    }));
    res.json({
      run: publicRun(run),
      attempts: attempts.map(publicAttempt),
      assertions,
      snapshots: forwarder.evidence.snapshotsFor(run.id),
      result: forwarder.buildResult(run, attempts, event),
      event: { id: event.id, paypalEventId: event.paypal_event_id, eventType: event.event_type, receivedAt: event.first_received_at, processingStatus: event.processing_status },
    });
  });

  app.post('/api/projects/:id/scenario-runs/:runId/cancel', requireAuth, (req, res) => {
    const project = getProjectRow(req.params.id);
    const run = getRunRow(project.id, req.params.runId);
    forwarder.cancelRun(run.id);
    res.json({ run: publicRun(getRunRow(project.id, run.id)) });
  });
}

module.exports = { registerScenarioRoutes };
