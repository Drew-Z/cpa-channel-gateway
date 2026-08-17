# Stage 3 Evidence Scheduling and Circuit Breaker Plan

## 1. Goal and boundaries

Stage 3 uses evidence from real production requests and explicitly initiated canaries to improve
selection between candidates that already belong to the same logical model. It must not:

- rank model intelligence or infer equivalence between model IDs;
- move `coding-main`, `coding-backup`, pinned aliases, or logical-model membership;
- generate background probes or periodic canaries;
- replay a generation request after any upstream bytes may have been sent;
- persist prompts, responses, request IDs, HTTP headers, endpoints, credentials, raw errors, or user data.

The existing channel-wide reservation and HAProxy `maxconn 1` remain the hard concurrency boundary.
Evidence only changes deterministic ordering and temporary eligibility inside an already approved
candidate group.

## 2. Current baseline and gap

The current scheduler persists channel health (`healthy`, `degraded`, `auth-failed`,
`payment-blocked`, `cooling`) and candidate `misconfigured` state. It handles `Retry-After`, filters
busy/draining/disabled candidates, and never replays a request. It does not yet retain bounded
candidate samples, compare success rate or latency, open a transient-failure circuit, or coordinate
a half-open recovery attempt.

Stage 3 adds candidate evidence without weakening the existing permanent blockers:

- `401/403` remains channel-level `auth-failed`;
- `402` remains channel-level `payment-blocked`;
- `429` remains channel-level `cooling` and honors `Retry-After`;
- `400/404/405/422` remains candidate-level `misconfigured`;
- client cancellation is usage evidence but is not an upstream failure sample;
- timeout, connection failure, and `5xx` are candidate-level transient failures.

## 3. Candidate evidence schema

`runtime/control-state.json` moves to schema v2. The v1 reader remains supported and migrates valid
channel/candidate blockers in memory; new evidence starts empty. A release digest change continues
to remove health blockers and evidence that does not belong to the new candidate inventory.

Each valid candidate key may contain only this allowlisted record:

```json
{
  "health": "misconfigured",
  "updatedAt": 1786900000000,
  "evidence": {
    "sampleCount": 8,
    "successCount": 6,
    "failureCount": 2,
    "consecutiveTransientFailures": 0,
    "ewmaLatencyMs": 1840,
    "lastOutcomeAt": 1786900000000,
    "circuit": "closed",
    "cooldownUntil": null,
    "openCount": 0
  }
}
```

`health` remains optional and currently only accepts `misconfigured`. Evidence fields are bounded
non-negative integers. Counts saturate at 10,000 and are proportionally rescaled before another
sample is added. `ewmaLatencyMs` is bounded to 24 hours. Evidence older than 24 hours is discarded.
The persisted circuit accepts `closed` or `open`; `half-open` is derived at runtime and is never
persisted as an active lease.

## 4. Deterministic constants

Initial constants are intentionally conservative and remain module-level exported test fixtures:

| Constant | Initial value | Purpose |
| --- | ---: | --- |
| Minimum comparable samples | 5 | Ignore unstable success-rate differences |
| EWMA alpha | 0.25 | Prefer recent latency without reacting to one sample |
| Consecutive transient failures to open | 3 | Avoid opening on one upstream incident |
| Base open cooldown | 30 seconds | Delay the first recovery attempt |
| Maximum open cooldown | 5 minutes | Bound exponential cooldown |
| Evidence TTL | 24 hours | Avoid stale history controlling current routing |
| Maximum persisted candidates | Current validated inventory | Prevent unbounded external IDs |

Cooldown is `min(base * 2^(openCount - 1), maximum)`. A successful half-open request resets
`openCount`, closes the circuit, and resets consecutive failures. A failed half-open request opens
the circuit again with the next bounded cooldown.

## 5. Outcome recording

The scheduler receives one terminal observation for a selected candidate:

```js
scheduler.recordOutcome(selection, {
  kind: 'success',
  statusCode: 200,
  durationMs: 1840,
  retryAfter: null
})
```

Allowed `kind` values are `success`, `http-failure`, `transport-failure`, and `cancelled`.
`durationMs` is measured with an injected monotonic millisecond clock and is accepted only for a
completed upstream result. `cancelled` releases the reservation but does not alter candidate
success/failure evidence. A `2xx` response is successful only after its complete JSON body or stream
ends normally; receiving response headers alone is not success. Every completed non-`2xx` result may
increment the bounded failure count, but only timeout, connection failure, and `5xx` increment
`consecutiveTransientFailures` or open the circuit. Classification uses only status code and
transport category; raw errors never enter the scheduler state.

Every selection object has an idempotent observation guard. Duplicate `end`, `close`, timeout, or
error events cannot add multiple samples. The gateway still performs zero cross-candidate replays.

## 6. Eligibility and half-open

Candidate eligibility is evaluated in this order:

1. source policy (`staged` is manual-test only) and streaming capability;
2. pending drain/suppression and the channel-wide reservation;
3. channel `auth-failed`, `payment-blocked`, or active `cooling`;
4. candidate `misconfigured`;
5. candidate circuit.

An open circuit is excluded until `cooldownUntil`. After expiry, it becomes half-open eligible. The
first real request or explicit manual canary atomically acquires a runtime-only half-open token. Other
requests continue to exclude that candidate until the trial finishes. No timer sends traffic.

The scheduler checks the half-open token and obtains the channel reservation in one synchronous
selection step. If either cannot be obtained, it releases the other immediately before trying an
alternate candidate. A failed selection attempt therefore cannot strand a half-open token or a
channel lease.

If a logical model has only one candidate, cooldown expiry must still allow its half-open trial; a
candidate cannot remain permanently locked solely because there is no alternate.

## 7. Ordering

After eligibility filtering, candidates use this stable order:

1. channel health rank;
2. operator candidate priority;
3. success rate, only when both candidates have at least five unexpired samples;
4. EWMA latency, only when both candidates have a value;
5. channel ID, upstream model ID, then protocol.

Unknown evidence is neutral. It never outranks a higher operator priority and never receives an
invented zero-percent success rate or zero latency. Health and explicit priority therefore remain
the primary administrative controls.

## 8. Admin and observability contract

Authenticated admin status may expose only:

- bounded sample/success/failure counts and calculated success rate;
- EWMA latency, consecutive transient failures, circuit state, and cooldown timestamp;
- low-sensitivity selection/exclusion reason codes such as `priority`, `better-success-rate`,
  `lower-ewma-latency`, `channel-cooling`, `circuit-open`, or `half-open-busy`.

It must not expose raw exception messages, request metadata, response text, endpoint URLs in history,
or a claim that operational success rate measures model capability. `/v1/models` remains unchanged.

## 9. Delivery slices

### 3A. Pure evidence reducer

- Add a pure evidence module with outcome classification, bounded counter updates, EWMA, TTL,
  cooldown, state restoration, and comparison helpers.
- Cover every constant and boundary with an injected clock.

### 3B. Scheduler integration

- Add circuit eligibility, atomic half-open tokens, evidence-aware ordering, and idempotent terminal
  observation.
- Preserve channel-wide mutual exclusion, direct-route behavior, streaming filtering, and no replay.

### 3C. Persistence migration

- Upgrade control-state to v2 with an explicit v1 reader.
- Validate the full allowlist, inventory bounds, release changes, corrupt files, and memory fallback.

### 3D. Gateway and admin status

- Record latency and classified terminal outcomes in native and adapted transports.
- Render low-sensitive evidence and reason codes in the existing admin page without changing public
  model IDs or API credentials.

### 3E. Deployment acceptance

- Run the complete local gate and an Edge desktop/mobile visual check.
- Deploy one commit through `AUTO_UPDATE=1`.
- Use an existing authenticated admin session for read-only status, then one explicitly selected
  exact canary and one stream/non-stream business pair. Do not test the circuit by injecting a
  production failure.

## 10. Required tests and gates

Tests must prove:

- sample threshold, ties, counter saturation, EWMA, TTL, and deterministic ordering;
- three consecutive transient failures open the circuit while interleaved success resets it;
- cooldown expiry permits exactly one half-open trial under concurrent requests;
- half-open success closes and failure reopens with bounded backoff;
- `401/403`, `402`, `429`, protocol errors, cancellation, and transient errors retain distinct rules;
- v1 state migration, v2 restore, corrupt input, release change, and unwritable storage;
- one-candidate recovery, direct-route compatibility, stream lifetime, and no request replay;
- admin output contains only allowlisted fields and reason codes.

Final local gate:

```bash
npm test
npm run check
npm run audit:public
node --check src/scheduler.mjs
node --check src/control-state.mjs
node --check src/control-gateway.mjs
git diff --check
```

## 11. Production safety gate

Stage 3 implementation does not authorize `migrate:routes -- --apply`, provider migration, logical
group creation, alias movement, production failure injection, credential reads, or server renewal.
Those operations remain separate explicit approvals.
