'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { openDb, MIGRATIONS } = require('../src/db');
const { safePayPalLink } = require('../src/orders');

test('a version-1 database upgrades to the latest version and keeps its projects', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faultline-'));
  const file = path.join(dir, 'old.db');
  try {
    const old = new Database(file);
    old.exec(MIGRATIONS[0]);
    old.pragma('user_version = 1');
    old.prepare(`INSERT INTO projects (id, name, paypal_client_id, paypal_secret_enc, webhook_endpoint_url, created_at, updated_at)
      VALUES ('p1', 'Old project', 'CLIENT_ID_1234', 'v1:a:b:c', 'http://localhost/x', 'now', 'now')`).run();
    old.close();

    const db = openDb(file);
    assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS.length);
    assert.equal(db.prepare('SELECT name FROM projects').get().name, 'Old project');
    for (const table of ['paypal_orders', 'paypal_captures', 'paypal_api_calls', 'webhook_events', 'webhook_deliveries']) {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n, 0);
    }
    db.close();
    openDb(file).close(); // opening again is a no-op
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('only https links on paypal.com hosts are ever offered as approval links', () => {
  assert.ok(safePayPalLink('https://www.sandbox.paypal.com/checkoutnow?token=ABC'));
  assert.ok(safePayPalLink('https://paypal.com/x'));
  for (const bad of ['http://www.sandbox.paypal.com/x', 'https://evil.example/paypal.com', 'https://paypal.com.evil.example/x', 'javascript:alert(1)', 'not a url', undefined]) {
    assert.equal(safePayPalLink(bad), null, String(bad));
  }
});
