'use strict';
// Local sample target application + state probe for testing Faultline.
// Usage (Windows CMD):
//   node scripts/demo-receiver.js            (correctly idempotent handler)
//   node scripts/demo-receiver.js buggy      (intentionally non-idempotent handler to demonstrate failure detection)
const http = require('node:http');

const mode = (process.argv[2] || process.env.DEMO_MODE || 'idempotent').toLowerCase();
const isBuggy = mode === 'buggy';
const port = Number(process.env.DEMO_PORT) || 4000;

const state = {
  processed: new Map(), // paypal_event_id -> count
  records: new Map(),   // resource_id -> count
  status: null,
  capturedCents: 0,
  refundedCents: 0,
  currency: 'USD',
};

const cents = (v) => Math.round(parseFloat(v || '0') * 100);
const fmt = (c) => (c / 100).toFixed(2);
const rank = { PENDING: 1, APPROVED: 3, COMPLETED: 4 };

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    if (req.method === 'GET' && url.pathname === '/faultline-probe') {
      const eventId = url.searchParams.get('event_id');
      const resourceId = url.searchParams.get('resource_id');
      const body = {
        event: { processed_count: state.processed.get(eventId) || 0 },
        payment: {
          ...(state.status ? { status: state.status } : {}),
          captured_amount: fmt(state.capturedCents),
          refunded_amount: fmt(state.refundedCents),
          currency: state.currency,
          payment_records: state.records.get(resourceId) || 0,
        },
      };
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(body));
    }

    if (req.method === 'POST' && url.pathname === '/webhooks/paypal') {
      let ev;
      try {
        ev = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.statusCode = 400;
        return res.end('invalid json');
      }

      const seen = state.processed.get(ev.id) || 0;
      const attempt = req.headers['x-faultline-attempt'] || '1/1';
      const kind = req.headers['x-faultline-delivery-kind'] || 'original';
      console.log(`[demo-receiver] ${ev.event_type} (${ev.id}) kind=${kind} attempt=${attempt} seen_before=${seen}`);

      if (isBuggy || seen === 0) {
        state.processed.set(ev.id, seen + 1);
        const r = ev.resource || {};
        if (ev.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
          state.records.set(r.id, (state.records.get(r.id) || 0) + 1);
          state.status = 'COMPLETED';
          if (r.amount && r.amount.value) state.capturedCents = cents(r.amount.value);
          if (r.amount && r.amount.currency_code) state.currency = r.amount.currency_code;
        } else if (ev.event_type === 'CHECKOUT.ORDER.APPROVED') {
          if (isBuggy || (rank[state.status] || 0) < rank.APPROVED) state.status = 'APPROVED';
        } else if (ev.event_type === 'PAYMENT.CAPTURE.REFUNDED') {
          const amt = r.amount ? cents(r.amount.value) : 0;
          if (isBuggy || state.refundedCents + amt <= state.capturedCents) state.refundedCents += amt;
        }
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ received: true, mode }));
    }

    res.statusCode = 404;
    res.end('not found');
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Demo receiver listening on http://127.0.0.1:${port} (mode: ${isBuggy ? 'buggy / non-idempotent' : 'idempotent'})`);
  console.log(`  Webhook endpoint URL: http://127.0.0.1:${port}/webhooks/paypal`);
  console.log(`  State probe URL:      http://127.0.0.1:${port}/faultline-probe`);
});
