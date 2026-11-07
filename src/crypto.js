'use strict';
const crypto = require('node:crypto');

const ALGORITHM = 'aes-256-gcm';

// AES-256-GCM. "context" is authenticated but not encrypted: we pass the project id,
// so a ciphertext copied onto another project row will not decrypt.
function createCipher(hexKey) {
  const key = Buffer.from(hexKey, 'hex');
  if (key.length !== 32) throw new Error('Encryption key must be 32 bytes.');

  return {
    encrypt(plaintext, context) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
      cipher.setAAD(Buffer.from(context, 'utf8'));
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join(':');
    },
    decrypt(payload, context) {
      const parts = String(payload).split(':');
      if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Unrecognized encrypted payload format.');
      const iv = Buffer.from(parts[1], 'base64');
      const tag = Buffer.from(parts[2], 'base64');
      const body = Buffer.from(parts[3], 'base64');
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      decipher.setAAD(Buffer.from(context, 'utf8'));
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    },
  };
}

function signToken(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token, secret) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(body).digest('base64url'));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function safeEqualStrings(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

module.exports = { createCipher, signToken, verifyToken, safeEqualStrings };
