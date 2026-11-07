'use strict';
const { ApiError } = require('./errors');

const iso = () => new Date().toISOString();
const str = (v, max = 100) => (typeof v === 'string' ? v.slice(0, max) : null);

// Shared by every feature that calls PayPal for a project: token cache (memory only),
// one retry after a rejected token, and a log row for every call. Never logs secrets or tokens.
function createPayPalService({ db, cipher, paypal }) {
  const tokens = new Map(); // projectId -> { token, expiresAt, fingerprint }

  function recordCall(projectId, orderId, operation, result) {
    const outcome = result.ok ? 'ok' : result.kind === 'unreachable' ? 'unreachable' : 'paypal_error';
    const info = db.prepare(`INSERT INTO paypal_api_calls
      (project_id, order_id, called_at, operation, method, path, http_status, duration_ms, outcome, error_name, error_message, paypal_debug_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(projectId, orderId, iso(), operation, result.method || '?', result.path || '?', result.httpStatus ?? null,
        result.durationMs ?? 0, outcome, result.ok ? null : result.code, result.ok ? null : str(result.message, 500), result.debugId ?? null);
    return Number(info.lastInsertRowid);
  }

  function toApiError(r) {
    const details = { httpStatus: r.httpStatus ?? null, name: r.code ?? null, message: r.message ?? null, debugId: r.debugId ?? null, issues: r.issues || [] };
    const issueText = details.issues.length ? ` (${details.issues.map((i) => i.issue).filter(Boolean).join(', ')})` : '';
    switch (r.kind) {
      case 'unauthorized':
      case 'auth_failed':
        return new ApiError(502, 'paypal_auth_failed', `PayPal did not accept this project's credentials (${r.code}). ${r.message}`, undefined, details);
      case 'rejected':
        return new ApiError(422, 'paypal_rejected', `PayPal rejected the request: ${r.code}${issueText}. ${r.message}`, undefined, details);
      case 'server_error':
        return new ApiError(502, 'paypal_server_error', `PayPal Sandbox had an internal error (HTTP ${r.httpStatus}). ${r.message}`, undefined, details);
      case 'malformed':
        return new ApiError(502, 'paypal_malformed_response', r.message, undefined, details);
      default:
        return new ApiError(502, 'paypal_unreachable', r.message, undefined, details);
    }
  }

  async function getToken(project, orderId, forceRefresh = false) {
    const cached = tokens.get(project.id);
    if (!forceRefresh && cached && cached.fingerprint === project.paypal_secret_enc && cached.expiresAt > Date.now()) return cached.token;
    let secret;
    try {
      secret = cipher.decrypt(project.paypal_secret_enc, project.id);
    } catch {
      throw new ApiError(409, 'secret_unreadable', 'The stored secret cannot be decrypted. ENCRYPTION_KEY has probably changed. Edit the project and enter the credentials again.');
    }
    const r = await paypal.fetchToken(project.paypal_client_id, secret);
    recordCall(project.id, orderId, 'get_token', r);
    if (!r.ok) throw toApiError(r);
    const ttl = Math.max((r.expiresIn ?? 300) - 60, 30);
    tokens.set(project.id, { token: r.accessToken, expiresAt: Date.now() + ttl * 1000, fingerprint: project.paypal_secret_enc });
    return r.accessToken;
  }

  // Runs one PayPal operation. If PayPal says the token is no longer valid, gets a fresh one and retries once.
  async function callPayPal(project, operation, orderId, exec) {
    let result = await exec(await getToken(project, orderId));
    let callId = recordCall(project.id, orderId, operation, result);
    const callIds = [callId];
    if (!result.ok && result.kind === 'unauthorized') {
      tokens.delete(project.id);
      result = await exec(await getToken(project, orderId, true));
      callIds.push(recordCall(project.id, orderId, operation, result));
    }
    return { result, callIds };
  }

  return { callPayPal, toApiError, recordCall };
}

module.exports = { createPayPalService };
