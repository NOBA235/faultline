'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createCipher, signToken, verifyToken, safeEqualStrings } = require('../src/crypto');

const key = () => crypto.randomBytes(32).toString('hex');

test('encrypt/decrypt round-trips and output does not contain the plaintext', () => {
  const c = createCipher(key());
  const enc = c.encrypt('super-secret-value', 'proj-1');
  assert.ok(!enc.includes('super-secret-value'));
  assert.equal(c.decrypt(enc, 'proj-1'), 'super-secret-value');
});

test('same plaintext encrypts differently each time (random IV)', () => {
  const c = createCipher(key());
  assert.notEqual(c.encrypt('x'.repeat(12), 'p'), c.encrypt('x'.repeat(12), 'p'));
});

test('decrypt fails for tampered data, wrong context and wrong key', () => {
  const k = key();
  const c = createCipher(k);
  const enc = c.encrypt('secret-secret', 'proj-1');
  const parts = enc.split(':');
  const tampered = [parts[0], parts[1], parts[2], Buffer.from('AAAAAAAAAAAAAAAAAAAAAA==', 'base64').toString('base64')].join(':');
  assert.throws(() => c.decrypt(tampered, 'proj-1'));
  assert.throws(() => c.decrypt(enc, 'proj-2'));
  assert.throws(() => createCipher(key()).decrypt(enc, 'proj-1'));
  assert.throws(() => c.decrypt('garbage', 'proj-1'));
});

test('rejects keys that are not 32 bytes', () => {
  assert.throws(() => createCipher('abcd'));
});

test('signed tokens verify, and tampering or a wrong secret is rejected', () => {
  const t = signToken({ exp: 123 }, 'secret-a'.repeat(5));
  assert.deepEqual(verifyToken(t, 'secret-a'.repeat(5)), { exp: 123 });
  assert.equal(verifyToken(t, 'secret-b'.repeat(5)), null);
  assert.equal(verifyToken(t.replace(/.$/, (ch) => (ch === 'A' ? 'B' : 'A')), 'secret-a'.repeat(5)), null);
  assert.equal(verifyToken('nodot', 'x'), null);
  assert.equal(verifyToken(undefined, 'x'), null);
});

test('safeEqualStrings compares correctly', () => {
  assert.equal(safeEqualStrings('abc', 'abc'), true);
  assert.equal(safeEqualStrings('abc', 'abd'), false);
  assert.equal(safeEqualStrings('abc', 'abcd'), false);
});
