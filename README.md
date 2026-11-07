# Faultline

Faultline tests whether a payment integration survives duplicated, delayed, dropped and replayed webhooks, using **real PayPal Sandbox** activity.

> Don't just test whether your payment works. Test whether it survives failure.

## Status: Phase 5 of 6

| Phase | Scope | Status |
|---|---|---|
| 1 | Projects, encrypted credential storage, real PayPal Sandbox authentication check, sign-in, database | Built |
| 2 | Create, retrieve and capture Sandbox orders; capture details; log of every PayPal call | Built |
| 3 | Webhook receiver, PayPal signature verification, event storage, event explorer | Built |
| 4 | Forwarding to your endpoint, fault injection (duplicate, delay, drop, replay), scenario results | Built |
| 5 | Deterministic safety checks, verdicts, overview, reports and exports | **Built (this release)** |
| 6 | AI test engineer | Not built |

Nothing from phases 2 to 6 is simulated. Those parts do not exist yet, and the UI does not show buttons for them.

## What phase 1 does

- Create, edit and delete projects (name, Sandbox Client ID, Sandbox Secret, your webhook endpoint URL).
- On create, and whenever you replace credentials or press **Check connection**, Faultline sends a real `POST /v1/oauth2/token` request (OAuth2 `client_credentials`) to `https://api-m.sandbox.paypal.com`.
- A project shows **Connected** only if PayPal returned a valid access token. Otherwise it shows PayPal's real error (for example `invalid_client`), or *PayPal unreachable* for network problems, timeouts and unexpected responses.
- Every check is saved (time, result, HTTP status, duration, error code, PayPal debug ID).
- The Secret is encrypted with AES-256-GCM before it is stored. It is never returned by the API, never put in the page, never logged, and never kept in browser storage.
- The webhook endpoint URL is **stored only**. Nothing is sent to it in phase 1.

## What phase 2 adds

All of this calls the real PayPal Orders v2 and Payments v2 APIs on `https://api-m.sandbox.paypal.com`, following PayPal's published reference.

| Faultline action | PayPal request |
|---|---|
| Create Sandbox order | `POST /v2/checkout/orders` (intent `CAPTURE`, PayPal wallet, `PayPal-Request-Id`, `Prefer: return=representation`) |
| Refresh from PayPal | `GET /v2/checkout/orders/{id}` |
| Capture payment | `POST /v2/checkout/orders/{id}/capture` (`PayPal-Request-Id` fixed per order) |
| Refresh details (on a capture) | `GET /v2/payments/captures/{capture_id}` |

How a test payment works:

1. Create the order in Faultline. PayPal answers `PAYER_ACTION_REQUIRED` with an approval link.
2. Open **Approve in PayPal Sandbox** and sign in with a Sandbox **personal (buyer)** account. Find or create one at developer.paypal.com under Testing tools, then Sandbox accounts. Approve the payment.
3. PayPal sends you to a Faultline page (`/paypal-return.html`). That page cannot know the outcome. Go back to the order and select **Refresh from PayPal**.
4. When PayPal reports **Approved**, select **Capture payment**. The capture and its details are saved only if PayPal returns them.

Safety and honesty rules in this phase:

- Statuses, IDs and amounts shown are what PayPal returned. If PayPal rejects a request (for example capture before approval), you see PayPal's error name, issue codes and debug ID, and nothing is saved or changed locally.
- Creating an order twice with the same idempotency key (a double click, a retry) never creates a second PayPal order. The form sends a fresh key per order.
- Capture is protected three ways: Faultline refuses a second capture of a completed order without calling PayPal, only one capture request per order can run at a time, and the capture uses a fixed `PayPal-Request-Id`.
- Each order carries `custom_id = faultline:<local id>`, so later phases can tell Faultline-created payments from other Sandbox activity.
- Test orders are limited to 10,000.00 in USD, EUR, GBP, CAD or AUD.
- Access tokens are cached in memory only (never stored, never returned). If PayPal answers 401, Faultline fetches a new token and retries that one request once. There are no other automatic retries: a timeout is reported, not hidden.
- Every PayPal call (including token requests) is logged with time, operation, HTTP status, duration and PayPal debug ID, and shown in **Recent PayPal API calls**. Secrets and tokens are never logged.

## What phase 3 adds

A public receiver for PayPal webhooks, a signature check done by PayPal's own API, and an event explorer.

Receiver URL (shown per project): `PUBLIC_BASE_URL/webhooks/paypal/<project id>`.

For every request that reaches it, Faultline:

1. Saves the body as exact bytes (never re-serialized) together with the PayPal signature headers.
2. Asks PayPal to verify it with `POST /v1/notifications/verify-webhook-signature`, passing the stored webhook ID and the event text unchanged (PayPal's own guidance: re-serializing can make a genuine event fail).
3. Labels it from PayPal's answer only. **Verified** means PayPal answered `SUCCESS`. Nothing else is ever labeled verified.

| Situation | Label | Our HTTP reply |
|---|---|---|
| PayPal answers SUCCESS | Verified by PayPal | 200 |
| PayPal answers FAILURE, signature headers missing, or certificate URL not on paypal.com (PayPal is not asked) | Verification failed | 401 |
| PayPal could not be asked (error, timeout, unreachable) | Could not verify | 503 so PayPal retries |
| Project has no PayPal Webhook ID yet | Not verified | 503 so PayPal retries |
| Body is empty or not a JSON object | no event stored, delivery logged | 400 |

Also:

- **Duplicates:** the same verified event delivered again (PayPal retries, or two at once) is recorded as a *redelivery* of the one stored event. The event keeps a delivery history. A forged copy with the same event ID and a bad signature is stored separately as failed and never touches the verified event.
- **Everything is kept:** rejected and malformed requests appear under **Recent inbound deliveries**, so nothing is silently accepted or silently dropped.
- **Linking:** an event is linked to a Faultline order only when its `custom_id` is the `faultline:<id>` tag Faultline sent, or its PayPal IDs match an order or capture Faultline saved. Otherwise it shows "Not linked". It is never guessed.
- **Event explorer:** filter by verification state and event type, search by event ID or resource ID, open an event to see its headers, formatted payload, the exact raw body, original delivery time (PayPal's transmission time header), reception time, and delivery history. **Verify again** re-asks PayPal about a stored delivery, for example after you add the Webhook ID.
- **Processing status** says what happened to the event afterwards (stored, forwarded, forward failed, dropped). See phase 4.

### Registering the webhook with PayPal

PayPal can only deliver to a public https address, so your computer needs a tunnel.

1. Start an https tunnel to port 3000. With ngrok, for example: `ngrok http 3000`. Copy the https address it shows.
2. Put that address in `.env` as `PUBLIC_BASE_URL=https://...` and restart Faultline (`Ctrl+C`, then `npm start`).
3. Open your project in Faultline and copy its **Receiver URL**.
4. In the PayPal Developer Dashboard open **Apps & Credentials**, switch to **Sandbox**, open your app, and find **Webhooks**. Add a webhook with the Receiver URL and choose events (for example Checkout order approved and Payment capture completed).
5. Copy the **Webhook ID** PayPal shows (not your Client ID) and save it in the project's **Webhooks from PayPal** panel.
6. Create an order in Faultline, approve it as a Sandbox buyer, and capture it. The resulting events should appear in the Event explorer as **Verified by PayPal**.

Events sent from PayPal's Webhooks Simulator cannot be verified. Use real Sandbox payments.

## What phase 4 adds

Faultline can now send a stored, PayPal-verified event to your own application and deliberately break the delivery in four ways. Set your application's URL as the project's **webhook endpoint URL** (the field you filled in when creating the project).

Only events that PayPal verified can be forwarded or used in tests. Unverified and failed deliveries are never sent to your application.

**What your application receives.** The original body, byte for byte, and PayPal's signature headers unchanged (`paypal-transmission-id`, `paypal-transmission-time`, `paypal-transmission-sig`, `paypal-cert-url`, `paypal-auth-algo`, `paypal-auth-version`, `correlation-id`, `content-type`). Your application can therefore run its normal webhook verification. Faultline adds headers that say what it is doing, so a delivery is never mistaken for a new payment:

| Header | Meaning |
|---|---|
| `X-Faultline-Scenario` | `forward`, `duplicate`, `delay` or `replay` |
| `X-Faultline-Delivery-Kind` | `original`, `duplicate`, `delayed` or `replay` |
| `X-Faultline-Attempt` | for example `2/3` |
| `X-Faultline-Injected` | `false` only for the original delivery |
| `X-Faultline-Original-Event-Id` | the PayPal event ID |
| `X-Faultline-Original-Received-At` | when Faultline first received the event |
| `X-Faultline-Run-Id` | the scenario run |

**Forwarding mode** (per project):

- **Manual** (default): events are held. Nothing reaches your application until you run a scenario. Use this for dropped and delayed tests.
- **Automatic**: each *new* verified event is forwarded once, right after PayPal gets its reply. PayPal's own repeat deliveries of the same event are recorded but not forwarded again. Use the duplicate scenario to make duplicates on purpose.

**Scenarios** (open a verified event in the Event explorer, then use **Test lab**):

| Scenario | What Faultline does |
|---|---|
| Forward once | Sends the event one time. |
| Duplicate delivery | Sends the same event 2 to 10 times in total, one after another or all at once. |
| Delayed delivery | Holds the event, then sends it after 1 second to 1 hour. Shows when it arrived and when it was actually sent. A waiting run can be cancelled and survives a restart. |
| Dropped delivery | Sends nothing, and records that the drop was deliberate. |
| Replay delivery | Sends a previously received event again, labeled as a replay. |

Every attempt is saved with its destination, send time, duration, outcome, HTTP status, a short piece of your application's reply, any error, and the SHA-256 of the body it sent.

**What a result means.**

- *Accepted* means your application replied with HTTP 2xx. It does not mean your application handled the payment correctly.
- *Rejected* means a non-2xx reply. A redirect is reported as a redirect and is not followed. *Timed out* and *could not connect* are reported as such.
- A scenario is **completed** when every planned step ran. That says nothing about whether your application behaved well. The verdict comes from the checks described under phase 5.
- A run keeps the destination URL it was created with, even if you change the project afterwards.

**Limits and honest caveats.**

- Delayed and replayed deliveries carry PayPal's *original* transmission time. If your application rejects stale timestamps, it may refuse them. That is a real result, not a Faultline fault.
- Faultline cannot see inside your application. It knows what your endpoint answered, not what it did with the event.
- Forwarding to Faultline's own receiver is blocked, so it cannot loop.
- At most 5 scenarios run at the same time per project. Requests time out after `FORWARD_TIMEOUT_MS` (default 10 seconds). Your application's reply is read up to 64 KB and the first 2,000 characters are kept.
- If Faultline stops while a scenario is running, that run is marked as interrupted on the next start. Attempts already sent stay recorded.

## What phase 5 adds

Deterministic checks, a verdict for every scenario run, a real-numbers overview, and exportable reports. No AI is involved in any verdict.

### Be careful what a check can know

Faultline sees three kinds of evidence. Every check says which one it used.

| Evidence | Where it comes from |
|---|---|
| **Observed** | Faultline's own requests and your endpoint's HTTP replies. |
| **PayPal** | Verified webhook events and PayPal's API (the order and its captures). |
| **Probe** | A test-only endpoint **you** add to your application, which reports its own state. |

Without a probe, Faultline cannot know whether your application processed an event once or five times. It then says **not evaluable**, never pass or fail.

### The checks

| Check | Evidence | Passes when | Fails when |
|---|---|---|---|
| Faultline sent the genuine event unchanged | Observed | Every request carried the stored body and PayPal's transmission ID | A request differed (the test is then not trustworthy) |
| Your endpoint accepted every delivery | Observed | Every request got HTTP 2xx | Any request got non-2xx, a redirect, a timeout or no connection |
| A failed delivery is not reported as processed | Probe | All deliveries failed and `processed_count` did not rise | All deliveries failed but `processed_count` rose |
| An accepted delivery was actually processed | Probe | After a 2xx, `processed_count` is 1 or more | 2xx, but the event shows as not processed |
| The same event is processed at most once | Probe | `processed_count` ends at most 1 (or unchanged if already 1) | It is higher |
| A repeated webhook does not create a second payment record | Probe | `payment_records` ends at most 1 (or unchanged) | It is higher |
| No new capture appeared at PayPal | PayPal | The order's capture count did not rise | A new capture appeared |
| Refunds reported by PayPal do not exceed the captured amount | PayPal | Verified refund events total at most the captured amount | They total more |
| Refunds in your application do not exceed the captured amount | Probe | `refunded_amount` is at most the captured amount | It is more |
| A late, older event does not overwrite newer state | Probe | Status did not move back to an earlier state | Status moved back |
| The payment only makes valid state changes | Probe | Status stayed the same or made a valid PayPal capture or order transition | An invalid change (for example REFUNDED back to COMPLETED) |

A check that cannot run says why: **not evaluable** (evidence missing, for example the probe was down or did not report a field) or **not applicable** (the scenario cannot test it, for example the stale-overwrite check needs a newer event for the same payment to have been delivered first).

### Verdict rules

- **Failed**: at least one check failed.
- **Passed**: nothing failed, **and** at least one check on your application's own state (a probe check) held.
- **Inconclusive**: otherwise. Getting 2xx replies, a clean delivery, or PayPal-side facts alone never produce "passed".

The checks that read PayPal (capture count, refund events) can fail a run but can never pass one on their own, because they say nothing about your application.

### The state probe (optional, strongly recommended)

Add a test-only `GET` endpoint to your application and put its URL in the project's **State probe** panel. Use **Test probe** to check it. Faultline calls it before and after each scenario (after waiting `PROBE_SETTLE_MS`, default 500 ms, so asynchronous handlers can finish):

```
GET <probe url>?event_id=WH-...&resource_id=...&event_type=PAYMENT.CAPTURE.COMPLETED

{
  "event":   { "processed_count": 1 },
  "payment": { "status": "COMPLETED", "captured_amount": "10.10", "refunded_amount": "0.00",
               "currency": "USD", "payment_records": 1 }
}
```

Every field is optional. A check runs only when the fields it needs are present. Use PayPal's status names. The probe exposes your payment state, so add it only to a test environment.

How to set up the scenarios for the harder checks:

- **Idempotency and second payment:** run *Duplicate delivery* on a capture event.
- **Stale overwrite:** receive a payment's events, forward the *newer* one (for example Payment capture completed), then run *Delayed delivery* on the *older* one (for example Checkout order approved). Both events must belong to the same order or capture.
- **Refund total:** forward a Payment capture refunded event for a capture you also have the completed event for.

### Overview, findings and reports

- **Overview** shows counts read straight from stored data. No sample or estimated numbers.
- **Test history** lists every run with its verdict and can be filtered by verdict.
- **Reports and reliability findings** groups failed checks across runs, shows checks that were never evaluated, and attaches general guidance for each kind of failure. The guidance is static advice, not generated from your code.
- **Downloads:** a Markdown report and a full JSON evidence export. Both include notices explaining what each label means. They contain no secrets and no AI-written content.

## Requirements

- Windows with Command Prompt (CMD)
- [Node.js 22 LTS](https://nodejs.org/) (20 or newer works)
- A PayPal developer account (free)

## Set up (Windows CMD)

```
cd path\to\faultline
npm install
npm run setup
npm start
```

`npm run setup` creates `.env` with random keys and prints your sign-in password once (it is also saved in `.env`). It refuses to overwrite an existing `.env`.

Open http://127.0.0.1:3000 and sign in.

To run the automated tests:

```
npm test
```

## Get PayPal Sandbox credentials

1. Go to https://developer.paypal.com and sign in.
2. Open **Apps & Credentials**.
3. Switch the toggle to **Sandbox**.
4. Create an app (or open the default one).
5. Copy the **Client ID** and **Secret** into Faultline's New project form.

Live credentials will be rejected by the Sandbox. That is expected.

## Environment variables

| Name | Required | Default | Purpose |
|---|---|---|---|
| `ENCRYPTION_KEY` | yes | none | 64 hex characters. Encrypts stored PayPal secrets. If it is lost or changed, stored secrets cannot be read and must be re-entered. |
| `SESSION_SECRET` | yes | none | At least 32 characters. Signs the sign-in cookie. |
| `ADMIN_PASSWORD` | yes | none | At least 12 characters. The password for the Faultline UI. |
| `PORT` | no | `3000` | HTTP port. |
| `HOST` | no | `127.0.0.1` | Bind address. Keep it on localhost unless you add HTTPS. |
| `DATABASE_PATH` | no | `data/faultline.db` | SQLite file. |
| `PAYPAL_TIMEOUT_MS` | no | `10000` | Timeout for requests to PayPal (1000 to 60000). |
| `PUBLIC_BASE_URL` | no | `http://HOST:PORT` | The address your browser uses for Faultline. PayPal sends the buyer back here after approval. |
| `FORWARD_TIMEOUT_MS` | no | `10000` | How long Faultline waits for your application to answer a forwarded event or its probe (1000 to 60000). |
| `PROBE_SETTLE_MS` | no | `500` | How long Faultline waits after the last delivery before reading your state probe (0 to 10000). |
| `COOKIE_SECURE` | no | `false` | Set `true` only when serving over HTTPS. |

`.env` is git-ignored. Never commit it.

## What was verified

Run in a Linux container, Node 22:

- **119 automated tests pass** (`npm test`). Phase 5 adds pure unit tests for every check (synthetic evidence, no network), and end-to-end tests against a stand-in application with switchable behavior: a correctly idempotent handler passes, and each planted bug is caught (processes every copy, commits then answers 500, overwrites newer state, accepts over-refunds). Other tests cover probe failures (down, not JSON, wrong format, missing field, unreachable), a missing probe giving "inconclusive", the verdict rules, overview numbers matching stored rows, findings, and report exports.
- Protections were checked by deliberately breaking them (earlier phases: capture lock, byte-exact bodies, the "verified" label, drop, idempotent scenario creation; this phase: the idempotency comparison, the rule that only application-state evidence can make a run "passed", and taking the after-snapshot). The tests failed each time.
- The UI was driven in headless Chromium: probe setup and test, a buggy application failing with evidence, a correct one passing, a run without a probe reported as inconclusive, history filtering, and a real Markdown report download with no secrets in it.
- The unzipped package installs from scratch with `npm install` and the full suite passes.
- The unmodified server, pointed at the real Sandbox address, reported **PayPal unreachable** (the container has no route to PayPal) and did not mark anything connected.

## What was NOT verified

- **No request has reached the real PayPal Sandbox, and no real PayPal webhook has reached Faultline.** Tests labeled `[fixture]` use local stand-ins for PayPal and for your application, and made-up event bodies. They test Faultline's behavior, not PayPal's or your application's. A real PayPal signature has never been verified by this code, and no real application or real probe has been tested.
- The refund check reads Payment capture refunded events as PayPal documents them (the `up` link to the capture and the refund amount). That shape has not been checked against a real Sandbox refund event. Faultline does not issue refunds itself.
- Probe results are only as good as your probe. If it reports wrong state, the checks will judge wrong state.
- Request shapes for PayPal were written from PayPal's published reference. Watch on your first real run: PayPal might not accept an `http://127.0.0.1` return URL for order approval (use your tunnel address as `PUBLIC_BASE_URL`), and the Sandbox app needs the Checkout feature (the default Sandbox app has it).
- The buyer approval step is a human step on PayPal's website. No test automates it.

Your first real checks, in order: project shows **Connected**; **Create Sandbox order** returns an approval link; after approving as a buyer, **Refresh** shows **Approved**; **Capture** shows **Completed**; the webhook registered with PayPal shows **Verified by PayPal** events; **Forward once** reaches your application; and **Test probe** shows your application's state. Whatever differs, the screen shows the real response.

## Security notes

- Sign-in is a single shared password with a 12-hour signed, HttpOnly, SameSite=Strict cookie and rate limiting (5 failures per 15 minutes per address). It is built for running locally. Do not expose it to the internet as is.
- Cross-origin writes are rejected, and a strict Content-Security-Policy is set.
- The state probe URL is user-controlled in the same way (GET only, redirects not followed, replies size-limited) and exposes your application's payment state, so use it only in a test environment.
- Your webhook endpoint URL is user-controlled, and Faultline sends requests to it. Point it only at systems you own. Redirects are not followed, replies are size-limited, and Faultline's own receiver is blocked as a destination.
- The webhook receiver is public by design (PayPal must reach it). It accepts up to 1 MB per request, allows 600 requests per minute per address, and stores everything that reaches it so you can inspect forged or malformed requests. The project ID in its URL is random but is not a secret. Verification, not the URL, decides what is trusted.

## Troubleshooting

- **`npm install` fails on `better-sqlite3`** (messages about `node-gyp`, Python or Visual Studio): delete `package-lock.json` and `node_modules` if they exist, then run `npm install` again. This project ships without a lock file on purpose, because a lock file makes npm compile the database library from source instead of using its prebuilt Windows binary. Use Node 22 LTS.
- **"Invalid configuration" when starting**: run `npm run setup`, or fill in `.env` from `.env.example`.
- **Stored secret "cannot be decrypted"**: `ENCRYPTION_KEY` changed. Edit the project and enter the credentials again.

## Layout

```
src/      server, API, orders, webhooks, forwarder, scenarios, checks, probe, evidence, reports, PayPal client and shared PayPal service, crypto, database
public/   the UI (plain HTML, CSS, JavaScript; no build step)
test/     automated tests
support/  test fixtures (local stand-in for PayPal, tests only)
scripts/  setup-env.js
```
