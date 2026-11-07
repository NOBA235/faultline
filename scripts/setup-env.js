'use strict';
// Creates .env with freshly generated random secrets. Never overwrites an existing .env.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const target = path.join(__dirname, '..', '.env');
const example = path.join(__dirname, '..', '.env.example');

if (fs.existsSync(target)) {
  console.error('.env already exists, so nothing was changed. Delete it first if you want new values.');
  process.exit(1);
}

const adminPassword = crypto.randomBytes(12).toString('base64url');
const values = {
  ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
  SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
  ADMIN_PASSWORD: adminPassword,
};

const content = fs.readFileSync(example, 'utf8').replace(/^(ENCRYPTION_KEY|SESSION_SECRET|ADMIN_PASSWORD)=.*$/gm, (_, k) => `${k}=${values[k]}`);
fs.writeFileSync(target, content, { mode: 0o600 });

console.log('Created .env');
console.log(`\nYour FAULTLINE sign-in password: ${adminPassword}`);
console.log('(It is also saved in .env. Keep ENCRYPTION_KEY: if it is lost, stored PayPal secrets cannot be decrypted.)');
