'use strict';
const crypto = require('node:crypto');
const { ApiError } = require('./errors');
const { createEvidence } = require('./evidence');
const { evaluate } = require('./checks');

const iso = () => new Date().toISOString();
const KINDS = ['forward', 'duplicate', 'delay', 'drop', 'replay'];
const LIMITS = { maxDuplicates: 10, minDelaySeconds: 1, maxDelaySeconds: 3600, maxActiveRuns: 5, maxScheduledRuns: 50 };
// Headers copied unchanged from PayPal's original delivery so the destination can run its normal signature check.
const PAYPAL_HEADERS = ['content-type', 'paypal-auth-algo', 'paypal-auth-version', 'paypal-cert-url', 'paypal-transmission-id',
  'paypal-transmission-sig', 'paypal-transmission-time', 'correlation-id'];
const LABELS = { forward: 'Forward once', duplicate: 'Duplicate delivery', delay: 'Delayed delivery', drop: 'Dropped delivery', replay: 'Replay delivery' };

function createForwarder({ db, config, paypal, service }) {
  const evidence = createEvidence({ db, config, paypal, service });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const timers = new Map(); // runId -> timeout handle (delayed runs waiting to fire)
  let closed = false;
  const timeoutMs = config.forwardTimeoutMs || 10000;
  const publicBase = (config.publicBaseUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');

  const getRun = (id) => db.prepare('SELECT * FROM scenario_runs WHERE id = ?').get(id);

  // Forwarding Faultline's own receiver to itself would loop forever.
  function blockedReason(destination) {
    let u;
    try { u = new URL(destination); } catch { return 'The destination is not a valid URL.'; }
    if (u.pathname.startsWith('/webhooks/paypal/')) {
      const own = new URL(publicBase);
      const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
      const samePort = config.port !== undefined && String(u.port || (u.protocol === 'https:' ? 443 : 80)) === String(config.port);
      if (u.host === own.host || (loopback && samePort)) {
        return 'The destination is Faultline\'s own webhook receiver. Forwarding there would loop, so nothing was sent.';
      }
    }
    return null;
  }

  function buildHeaders(event, run, attemptNo, total, deliveryKind) {
    const stored = JSON.parse(event.headers_json);
    const h = {};
    for (const k of PAYPAL_HEADERS) if (typeof stored[k] === 'string') h[k] = stored[k];
    if (!h['content-type']) h['content-type'] = 'application/json';
    h['user-agent'] = 'Faultline/0.4';
    h['x-faultline-run-id'] = run.id;
    h['x-faultline-scenario'] = run.kind;
    h['x-faultline-delivery-kind'] = deliveryKind;
    h['x-faultline-attempt'] = `${attemptNo}/${total}`;
    h['x-faultline-injected'] = deliveryKind === 'original' ? 'false' : 'true';
    if (event.paypal_event_id) h['x-faultline-original-event-id'] = event.paypal_event_id;
    h['x-faultline-original-received-at'] = event.first_received_at;
    return h;
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

  function saveAttempt(a) {
    db.prepare(`INSERT INTO forward_attempts
      (run_id, project_id, event_id, attempt_no, delivery_kind, destination_url, sent_at, duration_ms, outcome, http_status, error_text,
       response_snippet, response_bytes, body_sha256, request_headers_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(a.runId, a.projectId, a.eventId, a.attemptNo, a.deliveryKind, a.destination, a.sentAt, a.durationMs, a.outcome, a.httpStatus ?? null,
        a.errorText ?? null, a.snippet ?? null, a.responseBytes ?? null, a.bodySha, JSON.stringify(a.headers));
  }

  // One real HTTP POST of the original bytes. Every outcome is recorded; nothing is assumed.
  async function sendAttempt({ run, event, attemptNo, total, deliveryKind, destination }) {
    const headers = buildHeaders(event, run, attemptNo, total, deliveryKind);
    const base = { runId: run.id, projectId: run.project_id, eventId: event.id, attemptNo, deliveryKind, destination, headers,
      bodySha: crypto.createHash('sha256').update(event.raw_body).digest('hex') };
    const sentAt = iso();
    const started = Date.now();
    let rec;
    try {
      const res = await fetch(destination, { method: 'POST', headers, body: event.raw_body, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
      const body = await readLimited(res, 65536);
      const outcome = res.status >= 200 && res.status < 300 ? 'delivered' : res.status >= 300 && res.status < 400 ? 'redirect_not_followed' : 'http_error';
      rec = { ...base, sentAt, durationMs: Date.now() - started, outcome, httpStatus: res.status, snippet: body.toString('utf8').slice(0, 2000), responseBytes: body.length,
        errorText: outcome === 'delivered' ? null : outcome === 'redirect_not_followed' ? 'The destination answered with a redirect. Faultline does not follow redirects.' : `The destination answered HTTP ${res.status}.` };
    } catch (err) {
      const timedOut = err && err.name === 'TimeoutError';
      const cause = err && err.cause;
      const code = (cause && (cause.code || (cause.errors && cause.errors[0] && cause.errors[0].code))) || 'NETWORK_ERROR';
      rec = { ...base, sentAt, durationMs: Date.now() - started, outcome: timedOut ? 'timeout' : 'network_error',
        errorText: timedOut ? `The destination did not answer within ${Math.round(timeoutMs / 1000)} seconds.` : `Could not reach the destination (${code}).` };
    }
    saveAttempt(rec);
    return rec;
  }

  function refreshEventStatus(eventId) {
    const rows = db.prepare('SELECT outcome FROM forward_attempts WHERE event_id = ?').all(eventId).map((r) => r.outcome);
    let status = 'stored';
    if (rows.includes('delivered')) status = 'forwarded';
    else if (rows.some((o) => !['dropped', 'blocked'].includes(o))) status = 'forward_failed';
    else if (rows.includes('dropped')) status = 'dropped';
    db.prepare('UPDATE webhook_events SET processing_status = ? WHERE id = ?').run(status, eventId);
  }

  async function executeRun(runId) {
    if (closed) return;
    const run = getRun(runId);
    if (!run || !['queued', 'scheduled'].includes(run.status)) return;
    db.prepare("UPDATE scenario_runs SET status = 'running', started_at = ? WHERE id = ?").run(iso(), runId);
    const event = db.prepare('SELECT * FROM webhook_events WHERE id = ?').get(run.event_id);
    const params = JSON.parse(run.params_json);
    let status = 'completed';
    let errorText = null;
    let verdict = null;
    let verdictReason = null;
    let risks = null;
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(run.project_id);
    try {
      const blocked = blockedReason(run.destination_url);
      const prior = db.prepare("SELECT COUNT(*) AS n FROM forward_attempts WHERE event_id = ? AND outcome NOT IN ('dropped', 'blocked')").get(event.id).n;
      const firstKind = prior === 0 ? 'original' : 'replay';
      if (!blocked) await evidence.snapshot(project, event, run, 'before');
      const send = (attemptNo, deliveryKind) => sendAttempt({ run, event, attemptNo, total: run.planned_attempts, deliveryKind, destination: run.destination_url });
      if (blocked) {
        saveAttempt({ runId, projectId: run.project_id, eventId: event.id, attemptNo: 1, deliveryKind: firstKind, destination: run.destination_url, sentAt: iso(), durationMs: 0,
          outcome: 'blocked', errorText: blocked, bodySha: crypto.createHash('sha256').update(event.raw_body).digest('hex'), headers: {} });
        status = 'failed';
        errorText = blocked;
        verdict = 'inconclusive';
        verdictReason = `The scenario could not run: ${blocked}`;
      } else if (run.kind === 'drop') {
        saveAttempt({ runId, projectId: run.project_id, eventId: event.id, attemptNo: 1, deliveryKind: 'dropped', destination: run.destination_url, sentAt: iso(), durationMs: 0,
          outcome: 'dropped', errorText: 'Deliberately withheld by Faultline. No request was sent.', bodySha: crypto.createHash('sha256').update(event.raw_body).digest('hex'), headers: {} });
      } else if (run.kind === 'duplicate') {
        const kinds = Array.from({ length: run.planned_attempts }, (_, i) => (i === 0 ? firstKind : 'duplicate'));
        if (params.mode === 'concurrent') await Promise.all(kinds.map((k, i) => send(i + 1, k)));
        else for (let i = 0; i < kinds.length; i++) await send(i + 1, kinds[i]);
      } else if (run.kind === 'delay') {
        await send(1, 'delayed');
      } else if (run.kind === 'replay') {
        await send(1, 'replay');
      } else {
        await send(1, firstKind);
      }
      if (!blocked) {
        if (project.probe_url && run.kind !== 'drop') await sleep(config.probeSettleMs ?? 500);
        await evidence.snapshot(project, event, run, 'after');
        try {
          const rows = db.prepare('SELECT * FROM forward_attempts WHERE run_id = ? ORDER BY attempt_no').all(runId);
          const result = evaluate(evidence.buildContext(project, run, event, rows));
          evidence.persist(run, project.id, result);
          verdict = result.verdict;
          verdictReason = result.reason;
          risks = result.risks;
        } catch (err) {
          if (closed) return;
          verdict = 'inconclusive';
          verdictReason = `The checks could not be evaluated: ${err && err.message}`;
          console.error('[faultline] check evaluation failed:', err && err.message);
        }
      }
    } catch (err) {
      if (closed) return; // shutting down: the run stays 'running' and is marked interrupted on the next start
      status = 'failed';
      verdict = 'inconclusive';
      verdictReason = 'The scenario did not finish, so no checks were evaluated.';
      errorText = `Faultline could not finish this scenario: ${err && err.message}`;
      console.error('[faultline] scenario run failed:', err && err.message);
    }
    if (closed) return;
    db.prepare('UPDATE scenario_runs SET status = ?, finished_at = ?, error_text = ?, verdict = ?, verdict_reason = ?, evaluated_at = ?, risks_json = ? WHERE id = ?')
      .run(status, iso(), errorText, verdict, verdictReason, verdict ? iso() : null, risks ? JSON.stringify(risks) : null, runId);
    refreshEventStatus(event.id);
  }

  // Every background start goes through here so a failure can never become an unhandled rejection.
  const launch = (runId) => {
    executeRun(runId).catch((err) => { if (!closed) console.error('[faultline] scenario run crashed:', err && err.message); });
  };

  function arm(runId, ms) {
    const t = setTimeout(() => { timers.delete(runId); launch(runId); }, Math.max(0, ms));
    if (t.unref) t.unref();
    timers.set(runId, t);
  }

  // Creates a run (idempotent per key) and starts it in the background.
  function startRun(project, event, { kind, params = {}, idempotencyKey, triggeredBy = 'manual' }) {
    if (!KINDS.includes(kind)) throw new ApiError(400, 'validation_failed', 'Unknown scenario.');
    const key = idempotencyKey || crypto.randomUUID();
    const existing = db.prepare('SELECT * FROM scenario_runs WHERE project_id = ? AND idempotency_key = ?').get(project.id, key);
    if (existing) return { run: existing, duplicate: true };

    const active = db.prepare("SELECT COUNT(*) AS n FROM scenario_runs WHERE project_id = ? AND status IN ('queued', 'running')").get(project.id).n;
    const scheduled = db.prepare("SELECT COUNT(*) AS n FROM scenario_runs WHERE project_id = ? AND status = 'scheduled'").get(project.id).n;
    if (active >= LIMITS.maxActiveRuns || scheduled >= LIMITS.maxScheduledRuns) {
      throw new ApiError(409, 'too_many_runs', 'Too many scenarios are running or waiting for this project. Wait for some to finish.');
    }
    const id = crypto.randomUUID();
    const now = Date.now();
    const planned = kind === 'duplicate' ? params.count : 1;
    const scheduledFor = kind === 'delay' ? new Date(now + params.delaySeconds * 1000).toISOString() : null;
    db.prepare(`INSERT INTO scenario_runs (id, project_id, event_id, kind, triggered_by, params_json, idempotency_key, status, planned_attempts, destination_url, created_at, scheduled_for)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, project.id, event.id, kind, triggeredBy, JSON.stringify(params), key, kind === 'delay' ? 'scheduled' : 'queued', planned, project.webhook_endpoint_url, new Date(now).toISOString(), scheduledFor);
    if (kind === 'delay') arm(id, params.delaySeconds * 1000);
    else setImmediate(() => launch(id));
    return { run: getRun(id), duplicate: false };
  }

  function cancelRun(runId) {
    const run = getRun(runId);
    if (!run) throw new ApiError(404, 'not_found', 'Scenario run not found.');
    if (run.status !== 'scheduled') throw new ApiError(409, 'not_cancellable', 'Only a scenario that is still waiting can be cancelled.');
    clearTimeout(timers.get(runId));
    timers.delete(runId);
    db.prepare("UPDATE scenario_runs SET status = 'cancelled', finished_at = ?, error_text = ? WHERE id = ?").run(iso(), 'Cancelled before it was sent. The destination received nothing from this run.', runId);
  }

  // Called by the webhook receiver for a new verified event when the project forwards automatically.
  function autoForward(project, eventId) {
    try {
      const event = db.prepare('SELECT * FROM webhook_events WHERE id = ?').get(eventId);
      if (event) startRun(project, event, { kind: 'forward', idempotencyKey: `auto:${eventId}`, triggeredBy: 'auto' });
    } catch (err) {
      console.error('[faultline] automatic forwarding could not start:', err && err.message);
    }
  }

  // After a restart: re-arm waiting runs, and mark runs that were mid-flight as interrupted (never guess).
  function recover() {
    for (const r of db.prepare("SELECT * FROM scenario_runs WHERE status IN ('queued', 'scheduled')").all()) {
      if (r.status === 'scheduled') arm(r.id, new Date(r.scheduled_for).getTime() - Date.now());
      else setImmediate(() => launch(r.id));
    }
    for (const r of db.prepare("SELECT * FROM scenario_runs WHERE status = 'running'").all()) {
      db.prepare("UPDATE scenario_runs SET status = 'failed', finished_at = ?, error_text = ? WHERE id = ?")
        .run(iso(), 'Faultline stopped while this scenario was running. Attempts already sent are recorded.', r.id);
      refreshEventStatus(r.event_id);
    }
  }

  function shutdown() {
    closed = true;
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  }

  // Facts only. Pass/fail judgments about the application come from deterministic checks in a later phase.
  function buildResult(run, attempts, event) {
    const sent = attempts.filter((a) => !['dropped', 'blocked'].includes(a.outcome));
    const statusCodes = sent.map((a) => a.http_status);
    const delivered = sent.filter((a) => a.outcome === 'delivered').length;
    const failed = sent.filter((a) => ['network_error', 'timeout'].includes(a.outcome)).length;
    const rejected = sent.length - delivered - failed;
    const eventHash = event ? crypto.createHash('sha256').update(event.raw_body).digest('hex') : null;
    const params = JSON.parse(run.params_json);
    const done = ['completed', 'failed', 'cancelled'].includes(run.status);
    const observations = [];
    if (attempts.some((a) => a.outcome === 'dropped')) observations.push('Faultline deliberately withheld this event. No request was sent to the destination.');
    if (attempts.some((a) => a.outcome === 'blocked')) observations.push(attempts.find((a) => a.outcome === 'blocked').error_text);
    if (sent.length) observations.push(`Sent ${sent.length} of ${run.planned_attempts} planned request(s). Responses: ${sent.map((a) => a.http_status ?? a.outcome).join(', ')}.`);
    if (sent.length > 1) {
      const codes = new Set(sent.map((a) => (a.outcome === 'delivered' ? 'accepted' : a.outcome)));
      if (codes.size > 1) observations.push('The destination did not answer every delivery the same way.');
    }
    if (sent.length && sent.every((a) => a.body_sha256 === eventHash)) observations.push('Every request carried the stored event body unchanged (same SHA-256 as the original delivery).');
    if (run.status === 'scheduled') observations.push(`Waiting to deliver at ${run.scheduled_for}.`);
    const first = sent[0];
    return {
      scenario: run.kind,
      scenarioLabel: LABELS[run.kind],
      originalEventId: event ? event.paypal_event_id : null,
      status: run.status,
      completed: run.status === 'completed',
      destination: run.destination_url,
      plannedAttempts: run.planned_attempts,
      requestsSent: sent.length,
      acceptedCount: delivered,
      rejectedCount: rejected,
      failedCount: failed,
      dropped: attempts.some((a) => a.outcome === 'dropped'),
      statusCodes,
      createdAt: run.created_at,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      totalMs: run.started_at && run.finished_at ? new Date(run.finished_at) - new Date(run.started_at) : null,
      delay: run.kind === 'delay' ? {
        requestedSeconds: params.delaySeconds,
        eventReceivedAt: event ? event.first_received_at : null,
        scheduledFor: run.scheduled_for,
        forwardedAt: first ? first.sent_at : null,
        heldForMs: first && event ? new Date(first.sent_at) - new Date(event.first_received_at) : null,
        waitedMs: first ? new Date(first.sent_at) - new Date(run.created_at) : null,
      } : null,
      errors: attempts.filter((a) => a.error_text && a.outcome !== 'dropped').map((a) => ({ attempt: a.attempt_no, outcome: a.outcome, message: a.error_text })),
      errorText: run.error_text,
      observations,
      verdict: {
        status: run.verdict || 'not_evaluated',
        message: run.verdict_reason || (done ? 'No verdict was recorded for this run.' : 'This scenario has not finished.'),
      },
      risks: run.risks_json ? JSON.parse(run.risks_json) : [],
    };
  }

  recover();
  return { startRun, cancelRun, autoForward, buildResult, shutdown, executeRun, evidence, LIMITS, KINDS, LABELS };
}

module.exports = { createForwarder, LIMITS, KINDS };
