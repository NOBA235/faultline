# Faultline

Faultline is a payment reliability and webhook fault-injection testing platform for **PayPal Sandbox** integrations.

> Don't just test whether your payment works. Test whether it survives failure.

Payment systems are event-driven. A payment provider can deliver the same webhook notification more than once, notifications can arrive out of order or late, and handlers can fail partway through database updates. Faultline connects to your real PayPal Sandbox environment, receives and verifies genuine PayPal webhooks, forwards them to your application under controlled failure scenarios (duplicate, delayed, dropped, and replayed delivery), evaluates deterministic financial safety invariants, and provides evidence-based failure analysis.

---

## Capabilities Overview

| Area | What Faultline Does |
|---|---|
| **Projects & Credentials** | Create and manage testing projects. Validates credentials via live OAuth2 `POST /v1/oauth2/token` against `https://api-m.sandbox.paypal.com`. Encrypts PayPal Sandbox secrets at rest with AES-256-GCM; secrets are never returned in API responses, browser storage, or logs. |
| **PayPal Sandbox Orders & Captures** | Creates real Sandbox orders (`POST /v2/checkout/orders`), refreshes order status (`GET /v2/checkout/orders/{id}`), captures approved orders (`POST /v2/checkout/orders/{id}/capture`), and inspects capture status (`GET /v2/payments/captures/{capture_id}`). Every PayPal API call is logged with HTTP status, duration, and `paypal-debug-id`. |
| **Webhook Receiver & Signature Verification** | Receives incoming PayPal webhooks at `PUBLIC_BASE_URL/webhooks/paypal/<projectId>`, preserves the exact raw payload bytes and `PayPal-*` headers, and verifies authenticity via PayPal's `POST /v1/notifications/verify-webhook-signature` API. Never labels unverified payloads as verified. |
| **Event Explorer** | Search and filter stored webhook events by verification status, event type, PayPal event ID, or resource ID. Inspect structured payload fields, formatted JSON, byte-exact raw body with SHA-256 digest, saved headers, event lifecycle timeline, inbound delivery history, and fault-injection history. |
| **Test Lab & Fault Injection** | Select any PayPal-verified webhook event and execute **Forward once**, **Duplicate delivery** (2–10 sequential or concurrent copies), **Delayed delivery** (1–3600 seconds), **Dropped delivery** (0 requests sent), or **Replay delivery**. Preserves original PayPal signature headers while adding `X-Faultline-*` metadata headers. |
| **Deterministic Financial Safety Checks** | Evaluates 11 deterministic checks across delivery integrity, HTTP acceptance, PayPal order/capture state, and optional application state probe snapshots (`before` and `after` each run). Separates directly observed facts from inferred risks and never guesses internal database state without a probe. |
| **AI Test Engineer** | Converts plain-English test requests into validated structured test specifications, explains scenario failures strictly from stored execution traces (`observations`, `assumptions`, `recommendations`), and suggests integration-specific follow-up tests. Enforces strict guardrails: cannot fabricate events, execute financial operations, access secrets, or override deterministic verdicts. |
| **Reports & Evidence Exports** | Displays project overview metrics, data-backed distribution breakdowns, reliability findings, failed assertions across runs, and downloadable Markdown (`.md`) and JSON (`.json`) evidence reports. |

---

## Core Architecture & Feature Reference

### 1. Projects & PayPal Sandbox Connection

- Create, edit, and delete projects (project name, PayPal Sandbox Client ID, PayPal Sandbox Secret, webhook destination URL, and optional state probe URL).
- On project creation, credential update, or when selecting **Check connection**, Faultline sends an authenticated `POST /v1/oauth2/token` (`grant_type=client_credentials`) request to `https://api-m.sandbox.paypal.com`.
- A project is marked **Connected** only when PayPal returns a valid access token. Otherwise Faultline displays PayPal's actual error (for example `invalid_client`) or `PayPal unreachable` on network/timeout errors.
- Every connection check is persisted (timestamp, outcome, HTTP status, duration, error code, and PayPal debug ID).
- PayPal Sandbox Secrets are encrypted with AES-256-GCM using `ENCRYPTION_KEY` and authenticated with the project ID as additional authenticated data (AAD).

### 2. PayPal Sandbox Orders & Captures

All payment operations call the official PayPal Orders v2 and Payments v2 REST APIs on `https://api-m.sandbox.paypal.com`:

| Action | PayPal Sandbox Endpoint |
|---|---|
| Create Sandbox order | `POST /v2/checkout/orders` (`intent: CAPTURE`, PayPal wallet context, `PayPal-Request-Id`, `Prefer: return=representation`) |
| Refresh from PayPal | `GET /v2/checkout/orders/{id}` |
| Capture payment | `POST /v2/checkout/orders/{id}/capture` (idempotent `PayPal-Request-Id` per order) |
| Refresh capture details | `GET /v2/payments/captures/{capture_id}` |

**Transaction workflow:**

1. Create an order in Faultline. PayPal returns `PAYER_ACTION_REQUIRED` with a buyer approval link.
2. Open **Approve in PayPal Sandbox** and sign in with a PayPal Sandbox **personal (buyer)** account (found in the PayPal Developer Dashboard under **Testing Tools -> Sandbox Accounts**). Approve the payment.
3. Return to Faultline and select **Refresh from PayPal**.
4. Once PayPal reports `APPROVED`, select **Capture payment**. Faultline stores the capture record only when PayPal confirms it.

**Financial & operational safeguards:**

- Statuses, IDs, and amounts displayed come directly from PayPal's responses.
- Capture is protected by three guards: Faultline blocks capturing an already-completed order, allows only one in-flight capture request per order, and sends a deterministic `PayPal-Request-Id`.
- Each order carries `custom_id = faultline:<localOrderId>` so incoming webhooks can be deterministically linked to the order that triggered them.
- Test orders are capped at `10,000.00` in `USD`, `EUR`, `GBP`, `CAD`, or `AUD`.

### 3. Webhook Ingestion, Signature Verification & Event Explorer

Each project exposes a dedicated webhook receiver URL:

```text
<PUBLIC_BASE_URL>/webhooks/paypal/<projectId>
```

For every incoming request, Faultline:

1. Captures the raw request body as exact bytes (never re-serialized) along with PayPal's transmission headers.
2. Verifies the signature against PayPal's `POST /v1/notifications/verify-webhook-signature` endpoint using the project's configured **PayPal Webhook ID** and the exact raw event payload.
3. Assigns verification status strictly from PayPal's verification response:

| Condition | Verification Status | Faultline HTTP Response |
|---|---|---|
| PayPal returns `verification_status: "SUCCESS"` | **Verified by PayPal** (`verified`) | `200 OK` |
| PayPal returns `FAILURE`, headers are missing, or `paypal-cert-url` is not on `*.paypal.com` | **Verification failed** (`failed`) | `401 Unauthorized` |
| PayPal could not be reached (network error, timeout, 5xx) | **Could not verify** (`error`) | `503 Service Unavailable` (so PayPal retries) |
| Project has no PayPal Webhook ID configured yet | **Not verified** (`unverified`) | `503 Service Unavailable` (so PayPal retries) |
| Request body is empty or not a JSON object | Logged in inbound deliveries | `400 Bad Request` |

- **Natural redeliveries:** If PayPal redelivers the same verified event ID, Faultline records the delivery in the event's inbound delivery history without duplicating the event record. Forged requests with an existing event ID and an invalid signature are recorded separately as failed and never overwrite a verified event.
- **Registering with PayPal Sandbox:**
  1. Start an HTTPS tunnel to port 3000 (for example `ngrok http 3000`).
  2. Set `PUBLIC_BASE_URL=https://<your-tunnel-domain>` in `.env` and restart Faultline.
  3. Copy the project's **Receiver URL** from Faultline, register it in **PayPal Developer Dashboard -> Apps & Credentials -> Sandbox -> Your App -> Webhooks**, and copy the resulting **Webhook ID** into Faultline.
  4. Perform a real Sandbox order approval and capture (events from PayPal's Webhooks Simulator cannot be cryptographically verified by PayPal's verification API).

### 4. Event Forwarding & Fault Injection (Test Lab)

Only PayPal-verified events (`verification_status = 'verified'`) can be forwarded or used in fault-injection scenarios.

**Byte-exact forwarding:** Your application receives the original webhook body byte-for-byte along with PayPal's original signature headers (`paypal-transmission-id`, `paypal-transmission-time`, `paypal-transmission-sig`, `paypal-cert-url`, `paypal-auth-algo`, `paypal-auth-version`, `correlation-id`, `content-type`), allowing your application to run its standard webhook signature verification. Faultline appends explicit metadata headers so fault-injected deliveries are never confused with new financial transactions:

| Header | Description |
|---|---|
| `X-Faultline-Scenario` | `forward`, `duplicate`, `delay`, or `replay` |
| `X-Faultline-Delivery-Kind` | `original`, `duplicate`, `delayed`, or `replay` |
| `X-Faultline-Attempt` | Attempt counter, e.g. `2/3` |
| `X-Faultline-Injected` | `false` for baseline single forward; `true` for fault-injected deliveries |
| `X-Faultline-Original-Event-Id` | Original PayPal event ID (`WH-...`) |
| `X-Faultline-Original-Received-At` | ISO-8601 timestamp when Faultline first received the event |
| `X-Faultline-Run-Id` | Faultline scenario run UUID |

**Supported scenarios:**

| Scenario | Behavior |
|---|---|
| **Forward once** (`forward`) | Delivers the stored verified event once to your destination endpoint. |
| **Duplicate delivery** (`duplicate`) | Delivers the exact same verified event 2 to 10 times, either **sequentially** (one after another) or **concurrently** (all at once). |
| **Delayed delivery** (`delay`) | Holds the verified event and forwards it after a configurable delay (1 to 3,600 seconds). Records original reception time, scheduled time, and actual forwarding time. |
| **Dropped delivery** (`drop`) | Deliberately withholds the webhook (0 HTTP requests sent) and records that the event was intentionally dropped. |
| **Replay delivery** (`replay`) | Resends a previously received verified event labeled as a replay while preserving its original PayPal event identity. |

### 5. Deterministic Financial Safety Checks & State Probe

Every completed scenario run is evaluated by deterministic checks in `src/checks.js` using three distinct evidence sources:

- **Observed (`observed`)**: Faultline's own HTTP delivery trace and your endpoint's HTTP status codes, timings, and response snippets.
- **PayPal (`paypal`)**: Verified PayPal webhook payloads and PayPal Order/Capture snapshots read before and after the run.
- **Application State Probe (`probe`)**: An optional test-only `GET` endpoint in your application that Faultline queries before and after each scenario run (after waiting `PROBE_SETTLE_MS`, default `500 ms`).

| Deterministic Check | Evidence Source | Pass Criterion |
|---|---|---|
| **Faultline sent the genuine event unchanged** (`injection_integrity`) | Observed | Every forwarded request carried the exact SHA-256 body and PayPal transmission ID of the stored verified event. |
| **Your endpoint accepted every delivery** (`deliveries_accepted`) | Observed | Every forwarded delivery received an HTTP 2xx response. |
| **A failed delivery is not reported as processed** (`failed_delivery_not_processed`) | Probe | When all deliveries fail, `event.processed_count` does not increase. |
| **An accepted delivery was actually processed** (`accepted_delivery_processed`) | Probe | After at least one HTTP 2xx delivery, `event.processed_count >= 1`. |
| **The same event is processed at most once** (`idempotent_processing`) | Probe | Across duplicate or replayed deliveries, `event.processed_count` is at most 1 (or unchanged if already 1 before the run). |
| **A repeated webhook does not create a second payment record** (`no_second_payment_in_app`) | Probe | `payment.payment_records` is at most 1 (or unchanged). |
| **No new capture appeared at PayPal during the test** (`paypal_payment_unchanged`) | PayPal | Capture count on the linked PayPal Sandbox order did not increase during the webhook scenario. |
| **Refunds reported by PayPal do not exceed the captured amount** (`refund_events_within_captured`) | PayPal | Verified `PAYMENT.CAPTURE.REFUNDED` events for the capture do not sum to more than the captured amount. |
| **Refunds in your application do not exceed the captured amount** (`app_refunds_within_captured`) | Probe | `payment.refunded_amount <= payment.captured_amount`. |
| **A late, older event does not overwrite newer payment state** (`no_stale_overwrite`) | Probe | Delivering an older event after a newer event for the same payment does not move `payment.status` backward. |
| **The payment only makes valid state changes** (`valid_state_transition`) | Probe | `payment.status` stays unchanged or makes a valid PayPal lifecycle transition. |

**Verdict rules:**
- **Failed**: At least one deterministic check failed.
- **Passed**: Zero checks failed **and** at least one application-state (`probe`) check passed.
- **Inconclusive**: Zero checks failed, but no application-state check could be evaluated (for example when no state probe is configured). HTTP 2xx responses alone never mark a payment-safety scenario as `Passed`.

**State Probe Contract (optional, test environments only):**

```http
GET <probe_url>?event_id=WH-...&resource_id=...&event_type=PAYMENT.CAPTURE.COMPLETED
```

```json
{
  "event": { "processed_count": 1 },
  "payment": {
    "status": "COMPLETED",
    "captured_amount": "10.10",
    "refunded_amount": "0.00",
    "currency": "USD",
    "payment_records": 1
  }
}
```

### 6. AI Test Engineer

The AI Test Engineer (`src/ai-engineer.js`, `src/ai.js`) supports three evidence-driven workflows:

1. **Natural-Language Test Planning**: Converts plain-English prompts (such as `"Test whether my application processes the same completed payment webhook twice"`) into a validated structured test specification (`objective`, `requiredSourceEvent`, `scenario`, `plannedAttempts`, `expectedBehavior`, `assertions` mapped to `src/checks.js`, `failureConditions`, and `financialOperationsAllowed: false`). Specifications are validated before storage and re-validated before execution.
2. **Evidence-Based Failure Analysis**: Analyzes completed or failed scenario runs using only the stored execution trace (`scenario_runs`, `forward_attempts`, `assertion_results`, `run_snapshots`, `webhook_events`). Explains what happened, what was expected, what actually happened (including mixed retry sequences such as HTTP 500 followed by HTTP 200), where the failure occurred, why it matters, what to investigate, and concrete remediation steps. Strictly separates **Directly observed facts**, **Assumptions and blind spots**, and **Recommendations**, and flags **Insufficient evidence** whenever internal state could not be observed.
3. **Integration-Specific Test Suggestions**: Recommends additional tests based on the project's stored verified events, previous scenario runs, and failed or unevaluated checks.

**Enforced AI safety boundaries:**
- Cannot fabricate PayPal events or run scenarios on unverified deliveries.
- Cannot directly execute financial operations (creating orders, capturing payments, or issuing refunds).
- Cannot invent results or override deterministic verdicts (`enforceAnalysisGuardrails` locks `deterministicVerdict.canOverride = false`).
- Cannot access or reveal PayPal secrets, encryption keys, or session tokens.

---

## Requirements

- Windows with Command Prompt (`cmd.exe`)
- [Node.js 22 LTS](https://nodejs.org/) (Node.js 20+ supported)
- A free [PayPal Developer](https://developer.paypal.com) account

---

## Setup & Running (Windows CMD)

```cmd
cd c:\Users\User\Downloads\faultline
npm install
npm run setup
npm start
```

- `npm run setup` generates `.env` with cryptographically random `ENCRYPTION_KEY`, `SESSION_SECRET`, and `ADMIN_PASSWORD` values (and prints the admin password to the console). It refuses to overwrite an existing `.env`.
- Open `http://127.0.0.1:3000` in your browser and sign in with `ADMIN_PASSWORD`.

To run the automated test suite:

```cmd
npm test
```

---

## Local Demonstration Path (Windows CMD)

Faultline includes a standalone local webhook receiver and state probe (`scripts/demo-receiver.js`) with switchable `buggy` (non-idempotent, allows stale overwrites) and `idempotent` modes so you can verify end-to-end fault detection locally:

1. **Start Faultline** in Command Prompt window 1:
   ```cmd
   npm start
   ```
2. **Start the demo receiver in `buggy` mode** in Command Prompt window 2:
   ```cmd
   node scripts\demo-receiver.js buggy
   ```
   The demo receiver listens on `http://127.0.0.1:4000` and exposes:
   - Webhook endpoint URL: `http://127.0.0.1:4000/webhooks/paypal`
   - State probe URL: `http://127.0.0.1:4000/faultline-probe`
3. **Create a project in Faultline** with your PayPal Sandbox `Client ID` and `Secret`, webhook endpoint `http://127.0.0.1:4000/webhooks/paypal`, and state probe URL `http://127.0.0.1:4000/faultline-probe`.
4. **Receive a verified PayPal Sandbox webhook** (via an HTTPS tunnel registered in your PayPal Sandbox app settings) and open **AI Test Engineer** or **Test Lab**.
5. **Run a Duplicate Delivery (x2 or x3) scenario**:
   - In `buggy` mode, the run verdict is **Failed** because `event.processed_count` and `payment.payment_records` increase with every duplicate delivery.
   - Select **Analyze with AI Test Engineer** on the run to inspect the evidence-backed failure breakdown and remediation guidance.
6. **Verify the fix in `idempotent` mode**:
   - Restart the demo receiver in idempotent mode (`Ctrl+C`, then `node scripts\demo-receiver.js idempotent`), re-run the duplicate delivery scenario, and observe that all application-state checks **Pass**.

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `ENCRYPTION_KEY` | Yes | — | 64 hex characters (32 bytes). Encrypts stored PayPal Sandbox secrets with AES-256-GCM. |
| `SESSION_SECRET` | Yes | — | At least 32 characters. Signs the `HttpOnly` authentication cookie. |
| `ADMIN_PASSWORD` | Yes | — | At least 12 characters. Password for signing in to the Faultline UI. |
| `PORT` | No | `3000` | HTTP server port (`1`–`65535`). |
| `HOST` | No | `127.0.0.1` | Bind address. Keep on localhost unless behind an HTTPS reverse proxy. |
| `DATABASE_PATH` | No | `data/faultline.db` | Path to the SQLite database file. |
| `PAYPAL_TIMEOUT_MS` | No | `10000` | Timeout in milliseconds for outbound requests to PayPal Sandbox (`1000`–`60000`). |
| `FORWARD_TIMEOUT_MS` | No | `10000` | Timeout in milliseconds when forwarding webhooks or querying your state probe (`1000`–`60000`). |
| `PROBE_SETTLE_MS` | No | `500` | Wait time in milliseconds after the final delivery attempt before reading the post-run state probe (`0`–`10000`). |
| `PUBLIC_BASE_URL` | No | `http://HOST:PORT` | Public base URL used for PayPal approval return links and displayed webhook receiver URLs. |
| `COOKIE_SECURE` | No | `false` | Set to `true` when serving Faultline over HTTPS. |

---

## Verification & Truthful Limitations

### What Was Verified
- **Automated Test Suite (`npm test`)**: **131 automated tests pass** across `test/api.test.js`, `test/paypal.test.js`, `test/orders.test.js`, `test/webhooks.test.js`, `test/scenarios.test.js`, `test/checks.test.js`, `test/checks-integration.test.js`, `test/reports.test.js`, `test/ai-engineer.test.js`, `test/ai-integration.test.js`, `test/crypto.test.js`, `test/config.test.js`, and `test/db.test.js`.
- Verified capabilities include: AES-256-GCM secret encryption and redaction, PayPal OAuth2 token validation, order creation/refresh/capture and capture lookup, raw-byte webhook ingestion and PayPal signature verification, baseline forwarding, duplicate/delayed/dropped/replay fault injection, all 11 deterministic financial safety checks, Markdown/JSON evidence exports, natural-language test planning, evidence-based failure analysis, test suggestions, and AI safety guardrails.

### What Requires External Credentials / Live Sandbox Activity
- **Automated tests use local stand-in servers (`[fixture]`)**: No automated test contacts the live `https://api-m.sandbox.paypal.com` servers or receives a live webhook from PayPal. Live PayPal Sandbox verification requires your own PayPal Sandbox `Client ID`, `Secret`, `Webhook ID`, and a public HTTPS tunnel.
- **Buyer approval is an interactive browser step**: Approving a newly created Sandbox order on PayPal's checkout page requires signing in with a PayPal Sandbox buyer account in your browser.
- **Delayed and replayed webhook timestamps**: Faultline preserves PayPal's original `paypal-transmission-time` header so signature verification remains valid. If your receiving application enforces a strict timestamp freshness window, it may reject delayed or replayed deliveries; Faultline records and reports that rejection honestly.

---

## Repository Layout

```text
src/       Express app, PayPal Sandbox client & service, webhooks, forwarder, scenarios,
           deterministic checks, state probe, evidence snapshots, reports, AI Test Engineer,
           AES-256-GCM crypto, config validation, and SQLite database migrations
public/    Frontend web application (vanilla HTML, CSS, and JavaScript; zero build step)
scripts/   Environment generator (setup-env.js) and local demo receiver (demo-receiver.js)
support/   Controllable PayPal Sandbox and target-application test fixtures
test/      Automated unit and end-to-end integration test suites
```
