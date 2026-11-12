'use strict';
const crypto = require('node:crypto');
const { ApiError } = require('./errors');
const {
  validateTestSpec,
  suggestTests,
  sanitizePromptInput,
  sanitizeEventsForAi,
  sanitizeTraceForAi,
  sanitizeEvidenceForAi,
  buildPlanFromModelOutput,
  buildAnalysisFromModelOutput,
  buildSuggestionsFromModelOutput,
} = require('./ai-engineer');

const iso = () => new Date().toISOString();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const KEY_RE = /^[A-Za-z0-9_-]{8,100}$/;
const AI_RATE_WINDOW_MS = 60 * 1000;
const DEFAULT_AI_RATE_MAX = 20;

function registerAiRoutes({ app, db, config, forwarder, ai, requireAuth, wrap, getProjectRow }) {
  const rateBuckets = new Map(); // key -> { count, resetAt }
  const maxPerMinute = (config && config.aiRateLimitMax) || DEFAULT_AI_RATE_MAX;

  function enforceAiRateLimit(req, projectId) {
    const key = `${req.ip || 'local'}:${projectId}`;
    const now = Date.now();
    const bucket = rateBuckets.get(key);
    if (bucket && bucket.resetAt > now) {
      if (bucket.count >= maxPerMinute) {
        throw new ApiError(
          429,
          'ai_rate_limited',
          `Too many AI requests for this project (${maxPerMinute} per minute limit). Wait a moment and try again.`
        );
      }
      bucket.count += 1;
    } else {
      rateBuckets.set(key, { count: 1, resetAt: now + AI_RATE_WINDOW_MS });
    }
  }

  const publicPlan = (r) => ({
    id: r.id,
    projectId: r.project_id,
    prompt: r.prompt,
    provider: r.provider,
    validationStatus: r.validation_status,
    validationErrors: r.validation_errors_json ? JSON.parse(r.validation_errors_json) : [],
    matchedEventId: r.matched_event_id,
    executedRunId: r.executed_run_id,
    createdAt: r.created_at,
    spec: JSON.parse(r.spec_json),
  });

  const publicAnalysis = (r) => ({
    id: r.id,
    runId: r.run_id,
    projectId: r.project_id,
    provider: r.provider,
    evidenceHash: r.evidence_hash,
    createdAt: r.created_at,
    ...JSON.parse(r.analysis_json),
  });

  const publicRunSummary = (r) => ({
    id: r.id,
    eventId: r.event_id,
    kind: r.kind,
    label: forwarder.LABELS[r.kind],
    triggeredBy: r.triggered_by,
    status: r.status,
    plannedAttempts: r.planned_attempts,
    destination: r.destination_url,
    params: JSON.parse(r.params_json),
    createdAt: r.created_at,
    scheduledFor: r.scheduled_for,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    errorText: r.error_text,
    verdict: r.verdict || null,
  });

  function buildExecutionTrace(project, run) {
    const event = db.prepare('SELECT id, paypal_event_id, event_type, resource_type, resource_id, paypal_event_created_at, transmission_time, first_received_at, verification_status, processing_status, origin, related_order_id FROM webhook_events WHERE id = ? AND project_id = ?').get(run.event_id, project.id);
    if (!event) throw new ApiError(404, 'not_found', 'Source webhook event for this run was not found.');
    const attempts = db.prepare('SELECT attempt_no, delivery_kind, destination_url, sent_at, duration_ms, outcome, http_status, error_text, response_snippet, response_bytes, body_sha256 FROM forward_attempts WHERE run_id = ? ORDER BY attempt_no').all(run.id)
      .map((a) => ({
        attemptNo: a.attempt_no,
        deliveryKind: a.delivery_kind,
        destination: a.destination_url,
        sentAt: a.sent_at,
        durationMs: a.duration_ms,
        outcome: a.outcome,
        httpStatus: a.http_status,
        errorText: a.error_text,
        responseSnippet: a.response_snippet,
        responseBytes: a.response_bytes,
        bodySha256: a.body_sha256,
      }));
    const assertions = db.prepare('SELECT check_id, category, name, verdict, summary, evidence_json FROM assertion_results WHERE run_id = ? ORDER BY id').all(run.id)
      .map((a) => ({
        id: a.check_id,
        category: a.category,
        name: a.name,
        verdict: a.verdict,
        summary: a.summary,
        evidence: JSON.parse(a.evidence_json),
      }));
    const snapshots = forwarder.evidence.snapshotsFor(run.id);

    return {
      run: {
        id: run.id,
        kind: run.kind,
        label: forwarder.LABELS[run.kind],
        status: run.status,
        triggeredBy: run.triggered_by,
        plannedAttempts: run.planned_attempts,
        destination: run.destination_url,
        params: JSON.parse(run.params_json),
        createdAt: run.created_at,
        scheduledFor: run.scheduled_for,
        startedAt: run.started_at,
        finishedAt: run.finished_at,
        errorText: run.error_text,
        verdict: run.verdict,
        verdictReason: run.verdict_reason,
        risks: run.risks_json ? JSON.parse(run.risks_json) : [],
      },
      event: {
        id: event.id,
        paypalEventId: event.paypal_event_id,
        eventType: event.event_type,
        resourceType: event.resource_type,
        resourceId: event.resource_id,
        paypalEventCreatedAt: event.paypal_event_created_at,
        originalDeliveryTime: event.transmission_time,
        receivedAt: event.first_received_at,
        verificationStatus: event.verification_status,
        processingStatus: event.processing_status,
        origin: event.origin,
      },
      attempts,
      assertions,
      snapshots,
      probeConfigured: Boolean(project.probe_url),
      probeSettleMs: config.probeSettleMs ?? 500,
    };
  }

  function collectSuggestionEvidence(project) {
    const verifiedEvents = db.prepare(`SELECT id, paypal_event_id, event_type, resource_type, resource_id, paypal_event_created_at, first_received_at, processing_status, related_order_id
      FROM webhook_events WHERE project_id = ? AND verification_status = 'verified' ORDER BY first_received_at DESC, rowid DESC LIMIT 50`).all(project.id);
    const unverifiedEvents = db.prepare(`SELECT id, paypal_event_id, event_type, verification_status
      FROM webhook_events WHERE project_id = ? AND verification_status != 'verified' ORDER BY first_received_at DESC, rowid DESC LIMIT 20`).all(project.id);
    const runs = db.prepare(`SELECT id, event_id, kind, params_json, status, verdict, created_at
      FROM scenario_runs WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100`).all(project.id)
      .map((r) => ({ ...r, params: JSON.parse(r.params_json) }));
    const failedAssertions = db.prepare(`SELECT a.run_id, a.check_id, a.name, a.summary, r.event_id
      FROM assertion_results a JOIN scenario_runs r ON r.id = a.run_id
      WHERE a.project_id = ? AND a.verdict = 'fail' ORDER BY a.id DESC LIMIT 20`).all(project.id);
    const neverEvaluatedChecks = db.prepare(`SELECT check_id, MIN(name) AS name
      FROM assertion_results WHERE project_id = ? AND verdict != 'not_applicable'
      GROUP BY check_id HAVING SUM(verdict = 'pass') = 0 AND SUM(verdict = 'fail') = 0 AND SUM(verdict = 'not_evaluable') > 0`).all(project.id);

    return {
      project: {
        id: project.id,
        probeUrl: project.probe_url,
        paypalWebhookId: project.paypal_webhook_id,
        forwardMode: project.forward_mode,
      },
      verifiedEvents,
      unverifiedEvents,
      runs,
      failedAssertions,
      neverEvaluatedChecks,
    };
  }

  // ---- AI provider status -------------------------------------------------
  app.get('/api/projects/:id/ai/status', requireAuth, (req, res) => {
    getProjectRow(req.params.id);
    res.json(ai.status());
  });

  // ---- Natural-language test planning (OpenAI model + strict validation) ---
  app.post('/api/projects/:id/ai/plans', requireAuth, wrap(async (req, res) => {
    const project = getProjectRow(req.params.id);
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      throw new ApiError(400, 'invalid_body', 'The request body must be a JSON object.');
    }
    const rawPrompt = typeof req.body.prompt === 'string' ? req.body.prompt : '';
    const selectedEventId = typeof req.body.eventId === 'string' && req.body.eventId ? req.body.eventId : null;
    if (selectedEventId) {
      const ev = db.prepare('SELECT id, verification_status FROM webhook_events WHERE id = ? AND project_id = ?').get(selectedEventId, project.id);
      if (!ev) throw new ApiError(404, 'not_found', 'Selected webhook event was not found in this project.');
      if (ev.verification_status !== 'verified') {
        throw new ApiError(409, 'event_not_verified', 'Only events verified by PayPal can be used in a test plan.');
      }
    }

    const cleanPrompt = sanitizePromptInput(rawPrompt);
    enforceAiRateLimit(req, project.id);

    const verifiedEvents = db.prepare(`SELECT id, paypal_event_id, event_type, resource_type, resource_id, paypal_event_created_at, first_received_at, processing_status
      FROM webhook_events WHERE project_id = ? AND verification_status = 'verified' ORDER BY first_received_at DESC, rowid DESC LIMIT 100`).all(project.id);

    const allowlistedContext = sanitizeEventsForAi(verifiedEvents, {
      selectedEventId,
      probeConfigured: Boolean(project.probe_url),
    });

    const rawModelOutput = await ai.generateTestPlan({
      prompt: cleanPrompt,
      allowlistedContext,
    });

    const { spec, matchedEventId } = buildPlanFromModelOutput(rawModelOutput, {
      prompt: cleanPrompt,
      verifiedEvents,
      selectedEventId,
      probeConfigured: Boolean(project.probe_url),
    });

    const id = crypto.randomUUID();
    const now = iso();
    db.prepare(`INSERT INTO ai_test_plans
      (id, project_id, prompt, provider, spec_json, validation_status, validation_errors_json, matched_event_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, project.id, cleanPrompt, ai.providerLabel, JSON.stringify(spec), 'valid', JSON.stringify([]), matchedEventId, now);

    const saved = db.prepare('SELECT * FROM ai_test_plans WHERE id = ?').get(id);
    res.status(201).json({ plan: publicPlan(saved) });
  }));

  app.get('/api/projects/:id/ai/plans', requireAuth, (req, res) => {
    const project = getProjectRow(req.params.id);
    const rows = db.prepare('SELECT * FROM ai_test_plans WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 30').all(project.id);
    res.json({ plans: rows.map(publicPlan) });
  });

  app.get('/api/projects/:id/ai/plans/:planId', requireAuth, (req, res) => {
    const project = getProjectRow(req.params.id);
    const row = db.prepare('SELECT * FROM ai_test_plans WHERE id = ? AND project_id = ?').get(req.params.planId, project.id);
    if (!row) throw new ApiError(404, 'not_found', 'Test plan not found.');
    res.json({ plan: publicPlan(row) });
  });

  // Validates the stored test specification again and executes it against a real, PayPal-verified event (behind user confirmation).
  app.post('/api/projects/:id/ai/plans/:planId/execute', requireAuth, (req, res) => {
    const project = getProjectRow(req.params.id);
    const row = db.prepare('SELECT * FROM ai_test_plans WHERE id = ? AND project_id = ?').get(req.params.planId, project.id);
    if (!row) throw new ApiError(404, 'not_found', 'Test plan not found.');

    let spec = null;
    try { spec = JSON.parse(row.spec_json); } catch { spec = null; }
    const validation = validateTestSpec(spec);
    if (row.validation_status !== 'valid' || !validation.valid) {
      throw new ApiError(422, 'invalid_plan_spec', `This test plan did not pass specification validation and cannot be executed: ${validation.errors.join(' ')}`);
    }

    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if (body.idempotencyKey !== undefined && body.idempotencyKey !== null) {
      if (typeof body.idempotencyKey !== 'string' || !KEY_RE.test(body.idempotencyKey)) {
        throw new ApiError(400, 'validation_failed', 'Some fields need attention.', { idempotencyKey: 'The idempotency key must be 8 to 100 letters, numbers, - or _.' });
      }
    }

    const targetEventId = (typeof body.eventId === 'string' && body.eventId) ? body.eventId : row.matched_event_id;
    if (!targetEventId) {
      throw new ApiError(400, 'missing_source_event', 'Select a PayPal-verified webhook event stored in this project to run this test plan against.');
    }

    const event = db.prepare('SELECT * FROM webhook_events WHERE id = ? AND project_id = ?').get(targetEventId, project.id);
    if (!event) throw new ApiError(404, 'not_found', 'Event not found in this project.');
    if (event.verification_status !== 'verified') {
      throw new ApiError(409, 'event_not_verified', 'Only events that PayPal verified can be used in tests. Verify this event first, or choose a verified event.');
    }

    const idempotencyKey = body.idempotencyKey || `aiplan_${row.id.replace(/[^A-Za-z0-9_-]/g, '')}_${event.id.slice(0, 8)}`;
    const { run, duplicate } = forwarder.startRun(project, event, {
      kind: spec.scenario.kind,
      params: spec.scenario.params || {},
      idempotencyKey,
      triggeredBy: 'ai_plan',
    });

    db.prepare('UPDATE ai_test_plans SET matched_event_id = ?, executed_run_id = ? WHERE id = ?').run(event.id, run.id, row.id);
    const updatedPlan = db.prepare('SELECT * FROM ai_test_plans WHERE id = ?').get(row.id);
    res.status(duplicate ? 200 : 202).json({
      run: publicRunSummary(run),
      duplicate,
      plan: publicPlan(updatedPlan),
    });
  });

  // ---- Evidence-based failure analysis (OpenAI model + strict guardrails) --
  app.post('/api/projects/:id/scenario-runs/:runId/analyze', requireAuth, wrap(async (req, res) => {
    const project = getProjectRow(req.params.id);
    const run = db.prepare('SELECT * FROM scenario_runs WHERE id = ? AND project_id = ?').get(req.params.runId, project.id);
    if (!run) throw new ApiError(404, 'not_found', 'Scenario run not found.');
    if (!['completed', 'failed', 'cancelled'].includes(run.status)) {
      throw new ApiError(409, 'run_not_finished', 'This scenario has not finished yet. Wait for it to finish before analyzing the execution trace.');
    }

    enforceAiRateLimit(req, project.id);

    const trace = buildExecutionTrace(project, run);
    const allowlistedTrace = sanitizeTraceForAi(trace);
    const evidenceHash = sha256(JSON.stringify(allowlistedTrace));

    const rawModelOutput = await ai.generateRunAnalysis({ allowlistedTrace });
    const analysis = buildAnalysisFromModelOutput(rawModelOutput, trace);

    const id = crypto.randomUUID();
    const now = iso();

    db.prepare(`INSERT INTO ai_run_analyses (id, run_id, project_id, provider, analysis_json, evidence_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (run_id) DO UPDATE SET
        provider = excluded.provider,
        analysis_json = excluded.analysis_json,
        evidence_hash = excluded.evidence_hash,
        created_at = excluded.created_at`)
      .run(id, run.id, project.id, ai.providerLabel, JSON.stringify(analysis), evidenceHash, now);

    const saved = db.prepare('SELECT * FROM ai_run_analyses WHERE run_id = ?').get(run.id);
    res.json({ analysis: publicAnalysis(saved) });
  }));

  app.get('/api/projects/:id/scenario-runs/:runId/analysis', requireAuth, (req, res) => {
    const project = getProjectRow(req.params.id);
    const run = db.prepare('SELECT id FROM scenario_runs WHERE id = ? AND project_id = ?').get(req.params.runId, project.id);
    if (!run) throw new ApiError(404, 'not_found', 'Scenario run not found.');
    const saved = db.prepare('SELECT * FROM ai_run_analyses WHERE run_id = ?').get(run.id);
    res.json({ analysis: saved ? publicAnalysis(saved) : null });
  });

  // ---- Coverage-gap analysis (deterministic) & AI follow-up suggestions ---
  app.get('/api/projects/:id/ai/suggestions', requireAuth, (req, res) => {
    const project = getProjectRow(req.params.id);
    const evidence = collectSuggestionEvidence(project);
    const result = suggestTests(evidence);
    res.json({
      ...result,
      source: 'deterministic_coverage',
      provider: null,
      aiConfigured: ai.isConfigured(),
    });
  });

  app.post('/api/projects/:id/ai/suggestions', requireAuth, wrap(async (req, res) => {
    const project = getProjectRow(req.params.id);
    enforceAiRateLimit(req, project.id);
    const evidence = collectSuggestionEvidence(project);

    if (evidence.verifiedEvents.length === 0) {
      // Ensure AI configuration check still runs so unconfigured servers report 503 ai_not_configured consistently
      if (!ai.isConfigured()) {
        await ai.generateTestSuggestions({ allowlistedEvidence: sanitizeEvidenceForAi(evidence) });
      }
      const empty = suggestTests(evidence);
      return res.json({
        ...empty,
        source: ai.providerName || 'ai',
        provider: ai.providerLabel,
        aiConfigured: true,
      });
    }

    const allowlistedEvidence = sanitizeEvidenceForAi(evidence);
    const rawModelOutput = await ai.generateTestSuggestions({ allowlistedEvidence });
    const validated = buildSuggestionsFromModelOutput(rawModelOutput, evidence);

    res.json({
      ...validated,
      source: ai.providerName || 'ai',
      provider: ai.providerLabel,
      aiConfigured: true,
    });
  }));
}

module.exports = { registerAiRoutes };
