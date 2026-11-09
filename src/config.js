'use strict';
const path = require('node:path');

function readInt(value, fallback, min, max, name, problems) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`${name} must be a whole number between ${min} and ${max}.`);
    return fallback;
  }
  return n;
}

function loadConfig(env = process.env) {
  const problems = [];

  const encryptionKey = (env.ENCRYPTION_KEY || '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(encryptionKey)) {
    problems.push('ENCRYPTION_KEY must be 64 hex characters (32 bytes). Run "npm run setup" to generate one.');
  }
  const sessionSecret = (env.SESSION_SECRET || '').trim();
  if (sessionSecret.length < 32) {
    problems.push('SESSION_SECRET must be at least 32 characters. Run "npm run setup" to generate one.');
  }
  const adminPassword = env.ADMIN_PASSWORD || '';
  if (adminPassword.length < 12) {
    problems.push('ADMIN_PASSWORD must be at least 12 characters.');
  }
  const port = readInt(env.PORT, 3000, 1, 65535, 'PORT', problems);
  const forwardTimeoutMs = readInt(env.FORWARD_TIMEOUT_MS, 10000, 1000, 60000, 'FORWARD_TIMEOUT_MS', problems);
  const probeSettleMs = readInt(env.PROBE_SETTLE_MS, 500, 0, 10000, 'PROBE_SETTLE_MS', problems);
  const paypalTimeoutMs = readInt(env.PAYPAL_TIMEOUT_MS, 10000, 1000, 60000, 'PAYPAL_TIMEOUT_MS', problems);
  const openaiTimeoutMs = readInt(env.OPENAI_TIMEOUT_MS, 15000, 1000, 60000, 'OPENAI_TIMEOUT_MS', problems);

  const openaiApiKey = (env.OPENAI_API_KEY || '').trim() || null;
  const openaiModel = (env.OPENAI_MODEL || '').trim() || 'gpt-4o-mini';
  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(openaiModel)) {
    problems.push('OPENAI_MODEL must be a valid model identifier (1-100 letters, numbers, ., _, :, or -).');
  }

  const host = env.HOST || '127.0.0.1';
  const publicBaseUrl = (env.PUBLIC_BASE_URL || `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`).trim().replace(/\/+$/, '');
  try {
    const u = new URL(publicBaseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol');
  } catch {
    problems.push('PUBLIC_BASE_URL must be a full http:// or https:// URL, for example http://127.0.0.1:3000');
  }

  if (problems.length) {
    const err = new Error('Invalid configuration:\n - ' + problems.join('\n - '));
    err.code = 'INVALID_CONFIG';
    throw err;
  }

  return {
    host,
    publicBaseUrl,
    port,
    databasePath: path.resolve(env.DATABASE_PATH || 'data/faultline.db'),
    encryptionKey,
    sessionSecret,
    adminPassword,
    cookieSecure: env.COOKIE_SECURE === 'true',
    paypalTimeoutMs,
    forwardTimeoutMs,
    probeSettleMs,
    openaiApiKey,
    openaiModel,
    openaiTimeoutMs,
  };
}

module.exports = { loadConfig };
