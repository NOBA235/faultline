'use strict';
require('dotenv').config({ quiet: true });
const { loadConfig } = require('./config');
const { openDb } = require('./db');
const { PayPalClient } = require('./paypal');
const { createApp } = require('./app');

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err.message);
  console.error('\nCopy .env.example to .env and fill it in, or run: npm run setup');
  process.exit(1);
}

const db = openDb(config.databasePath);
const paypal = new PayPalClient({ timeoutMs: config.paypalTimeoutMs });
const app = createApp({ config, db, paypal });

const server = app.listen(config.port, config.host, () => {
  console.log(`FAULTLINE listening on http://${config.host}:${config.port}`);
  console.log('PayPal environment: Sandbox (https://api-m.sandbox.paypal.com)');
  console.log(
    config.openaiApiKey
      ? `AI Test Engineer: OpenAI configured (model: ${config.openaiModel})`
      : 'AI Test Engineer: OpenAI disabled (set OPENAI_API_KEY in .env to enable AI planning and trace analysis)'
  );
});

function shutdown() {
  app.locals.shutdown();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
