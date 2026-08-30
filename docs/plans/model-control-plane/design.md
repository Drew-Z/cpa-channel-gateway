# Model Control Plane Design

## Decision Summary

Keep CPA and HAProxy as the internal execution plane. Add a small Node.js control gateway that owns the single public port, serves the WebUI, authenticates requests, resolves logical models, enforces a per-channel semaphore, and selects either native passthrough or the internal CPA adapter for each request.

```text
Codex / Claude Code / API clients
                |
        Cloudflare Tunnel
                |
   Node control gateway :PUBLIC_PORT
   /v1/* router       /admin/* WebUI/API
          |                     |
 native Responses         adapted protocols
          |                     |
          |             CPA 127.0.0.1:24675
          |                     |
          +----------+----------+
                     |
 HAProxy 127.0.0.1:19001..190NN
 one backend and one hard slot per channel
                |
        upstream channels
```

The control gateway is the policy layer. CPA remains the protocol adapter. HAProxy remains the final physical concurrency boundary.

## Why CPA Alone Is Insufficient

CPA can expose aliases and choose among configured credentials, but the current gateway maps every public alias to one declared channel/model. It has no project-specific concept of:

- one logical model with candidates from different physical channels;
- channel-wide busy state shared across all model names;
- operator-defined model equivalence;
- passive health scoring plus explicit task-based test history;
- draining a channel before configuration changes;
- an admin workflow with revisioned private configuration.

Trying to encode those rules only in generated CPA aliases would require rewriting configuration whenever channel health or busy state changes. Per-request scheduling belongs in a stable outer router.

## Public Routing Contract

The control gateway accepts:

- `POST /v1/responses`
- `POST /v1/chat/completions`
- `POST /v1/messages`
- `GET /v1/models`

For generation requests it buffers and validates the JSON request body up to a configured limit, resolves `model`, and selects one of two transports:

- `native-passthrough`: for Responses-compatible upstreams, rewrite the logical model to the upstream model and forward the actual incoming client request directly through that channel's HAProxy listener;
- `adapted`: rewrite the model to the selected direct CPA alias and let CPA translate Responses, Chat Completions, or Claude Messages.

Both transports stream the upstream response back without buffering the response body and acquire the same channel semaphore.

Model resolution order:

1. stable or pinned alias;
2. logical model ID;
3. direct `<channel>/<upstream-model-id>` ID.

Direct IDs pin model selection but still acquire the channel semaphore.

### Native Header Policy

The native path forwards headers from the actual incoming Codex request. It does not load a saved header template and does not synthesize an official client identity.

| Action | Headers |
| --- | --- |
| Replace | `Authorization`, upstream API-key headers, `Host`, `Content-Length` |
| Strip | `Cookie`, `Proxy-Authorization`, `Connection`, `Proxy-Connection`, `Keep-Alive`, `Transfer-Encoding`, `TE`, `Trailer`, `Upgrade`, inbound `X-Forwarded-*`, and `CF-*` |
| Preserve | actual remaining end-to-end content negotiation, client metadata, feature, version, and request-correlation headers received on that request |

Header values are never persisted. Diagnostics may record an allowlisted header-name set and an HMAC fingerprint so two runs can be compared without storing raw values.

## Logical Model Data Model

```json
{
  "id": "gpt-4o",
  "enabled": true,
  "exposeDirectCandidates": true,
  "candidates": [
    {
      "channel": "free",
      "upstreamModel": "gpt-4o",
      "protocol": "responses",
      "priority": 100,
      "enabled": true
    },
    {
      "channel": "free2",
      "upstreamModel": "gpt-4o-compatible",
      "protocol": "responses",
      "priority": 80,
      "enabled": true
    }
  ]
}
```

Exact upstream IDs can form a default group. Different IDs require explicit operator grouping because equal names do not prove equal capability, and different names do not prove equivalence.

Stable aliases should target logical models. Existing pinned aliases remain exact candidate routes until their approval semantics are redesigned explicitly.

## Scheduler

MVP candidate filtering:

1. channel and candidate enabled;
2. protocol matches the incoming API;
3. candidate is not authentication-failed, payment-blocked, misconfigured, or cooling;
4. declared capabilities satisfy the request;
5. prefer candidates with an immediately available channel semaphore.

An active channel is omitted from candidate selection for every logical and direct model. If another candidate is idle, the scheduler uses it. If all candidates are busy, the public router returns `429 all_candidates_busy` with a short `Retry-After` hint and does not forward or enqueue another generation request. The channel remains visible as `busy` in the admin UI, and transient busy state does not remove models from `/v1/models`.

MVP ordering among eligible idle candidates:

1. health state: healthy, unknown, degraded;
2. operator priority descending;
3. recent success ratio descending;
4. EWMA latency ascending;
5. deterministic channel ID tie-break.

The health score is intentionally conservative. It changes only from explicit test results and real traffic. It does not generate periodic synthetic traffic.

## Per-Channel Semaphore

The Node process holds one semaphore per channel:

```text
channel id -> idle | one active request
```

The reservation records request ID, logical model, direct model, start time, and source (`production` or `manual-test`). It never records prompts or response bodies.

Release conditions include normal response end, client disconnect, upstream error, timeout, and process shutdown. Streaming responses hold the semaphore until the stream closes.

HAProxy keeps `maxconn 1`, `http-reuse never`, HTTP/1.1, and `retries 0` as defense in depth. The scheduler's state is used for routing decisions; HAProxy protects the invariant if a bug or internal direct call bypasses the scheduler.

## Failure State Machine

```text
unknown -> healthy       explicit test or real request succeeds
healthy -> degraded      timeout or transient 5xx
degraded -> open         threshold reached in a rolling window
open -> half-open        cooldown expires
half-open -> healthy     next real/manual request succeeds
half-open -> open        next request fails
any -> auth-failed       401/403
any -> payment-blocked   402
any -> cooling           429, honor Retry-After
any -> misconfigured     400/404/405/422 classified as protocol/path error
```

MVP does not transparently replay a generation POST after forwarding it upstream. A failed request changes selection for future requests. This preserves the existing no-retry policy and avoids duplicate generation when the upstream may have accepted work before the transport failed.

## Manual Model Test

`POST /admin/api/tests` accepts channel, provider model, and an optional protocol override. The override is limited to `openai-compatible`, `responses`, or `claude`, affects only this fixed-task request, and never silently changes configuration. The server:

1. checks admin authorization and rate limit;
2. tries to acquire the exact channel semaphore without queueing;
3. sends the fixed poetry task through the same selected transport and HAProxy path as production;
4. validates HTTP status and extracted non-empty text;
5. validates protocol-specific response semantics and records only redacted metadata;
6. releases the semaphore.

A busy result is not a failed model test. It is reported as `channel_busy` and sends no upstream request.

The admin API does not automatically retry the same generation request under another protocol. After a recent successful override test, `POST /admin/api/protocols/apply` can explicitly apply the protocol only to the exact model, with exact target/protocol confirmation and a second admin confirmation in the UI. A channel may contain models using different protocols; its protocol remains only a default for models without an explicit override. Application writes a revision and still requires runtime apply or restart.

## WebUI

The first usable UI has five work views rather than a marketing dashboard:

- **Overview**: channel state, active model, reservation elapsed time, health, cooldown, and config revision.
- **Channels**: add, edit, disable, drain, replace key, synchronize models, and delete.
- **Models**: provider-model inventory, verification state, protocol/capabilities, logical grouping, and direct test.
- **Routing**: logical models, candidate order, stable aliases, and pinned routes.
- **Changes**: validation output, pending diff, apply, rollback, and redacted audit history.

The UI should use the existing Node process and static assets. A separate frontend server, database server, or second public port is unnecessary for this single-tenant deployment.

## Private Storage

Use small atomic JSON files rather than introducing a database in MVP:

- `config/providers.local.json`: private channel URLs, API keys, protocol, enabled state, and priority;
- `config/routes.local.json`: provider models, logical groups, aliases, protocol, and capability metadata;
- `runtime/control-state.json`: redacted last test and passive health state;
- `runtime/config-revisions/`: private configuration backups and manifests.

`channels.local.env` remains the source for process-level secrets such as gateway key, management key, and Cloudflare token. A migration command imports current channel entries into `providers.local.json` without printing secrets.

All writes use temporary files, validation, atomic replacement, mode `0600` where supported, and rollback on validation failure.

## Runtime Apply

The parent Node control gateway owns the public listener so admin actions do not need to restart the Pterodactyl server. CPA moves to an internal listener.

Apply sequence:

1. serialize the control job;
2. write a candidate private configuration revision;
3. validate routes and generate CPA/HAProxy files;
4. stop new reservations and drain active requests;
5. replace internal CPA/HAProxy children;
6. run readiness checks;
7. commit the revision or restore the previous internal release;
8. resume routing.

MVP may return a short `503 reloading` window while internal children change. Zero-downtime dual internal stacks are unnecessary for one user and one-concurrency channels.

## Administration Security

- Gateway API keys never authorize `/admin`.
- `CPA_MANAGEMENT_KEY` is used only to establish an admin session and is not stored in browser local storage.
- The session cookie is HttpOnly, Secure, SameSite=Strict, short-lived, and revocable on process restart.
- Mutations require CSRF protection and `Origin` validation.
- Channel API keys are accepted on create/replace, written server-side, and returned only as masked presence. The separate gateway client key is revealed only after an authenticated same-origin `POST` with CSRF protection; the response is `no-store`, and the UI automatically restores its mask.
- Authenticated channel status may include the validated upstream Base URL for operator identification. Admin responses are `no-store`; public APIs and logs never expose the URL.
- Errors are classified and redacted before persistence or display.
- Cloudflare Access can be added in front of `/admin/*`; it is recommended but not required for the first single-user build.

## Client-Environment Fidelity

The gateway supports fidelity without requiring a local test runner:

1. **Transparent client passthrough**: if an incoming client and selected channel both use Responses, the gateway forwards the actual request body and reviewed non-sensitive end-to-end headers through the native path.
2. **Protocol-faithful canary**: a server-generated test uses the same public API shape, SSE/non-SSE behavior, content negotiation, and error parsing expected for the selected protocol, but identifies itself honestly as the gateway.
3. **Adapted transport**: when CPA must translate between Responses, Chat Completions, or Claude Messages, the result is labeled `adapted` and is not described as an exact native-client request.

Reviewed channel profiles are limited to `responses-native`, `openai-chat`, and `claude-messages`. They define public protocol behavior, not copied private identity headers. CPA's standard Codex compatibility headers may be enabled for adapted Responses traffic; identity confusion, Claude cloaking, and system-prompt substitution remain disabled.

Official OpenAI documentation confirms that custom providers can add headers, but it does not define Codex's internal header set as a stable public contract. The gateway therefore preserves headers actually received from clients and uses documented public protocol fields for server-generated requests. See [Advanced Configuration](https://learn.chatgpt.com/docs/config-file/config-advanced).

## Compatibility and Migration

- Existing direct model IDs remain valid.
- Existing `coding-main` and `coding-backup` continue to work while their targets migrate from exact routes to logical models.
- Existing ignored private files are imported; no secrets enter Git.
- Cloudflare Tunnel continues pointing to the same public port.
- The Pterodactyl startup command remains `node index.js`; only the child topology changes.
- Local Codex configuration and runtime are outside this MVP; no local helper is required.

## Main Trade-offs

- **Outer router versus CPA-only config**: adds one small proxy hop but provides the missing model and channel policy boundary.
- **JSON versus SQLite**: atomic JSON is simpler and sufficient for one operator and a small catalog; a database can be introduced if multi-process or high-volume history appears later.
- **No automatic replay**: a single request may fail instead of silently switching, but duplicate generations and ambiguous costs are avoided.
- **Passive health**: reacts to real outcomes without wasting channel quota, but an idle channel's status can become stale until manually tested or used.
- **Native versus adapted transport**: native same-protocol requests preserve actual client behavior, while CPA translation keeps broader upstream compatibility but cannot be presented as an exact client-wire test.
- **Reject instead of queue**: temporarily hiding busy channels prevents duplicate use and keeps latency predictable, but clients receive `429` when every candidate is occupied and must retry later.
