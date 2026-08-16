# Model Control Plane PRD

## Goal

Turn the current single-tenant CPA + HAProxy deployment into a manageable model gateway that:

- aggregates the same logical model from multiple physical channels;
- prefers an eligible, healthy, idle channel without violating per-channel serialization;
- lets the operator add, disable, drain, and remove channels and models from a WebUI;
- provides an explicit task-based model test instead of meaningless ping prompts;
- remains a single-public-port deployment suitable for the 2-core/3-GB Pterodactyl container;
- uses protocol-faithful request profiles and transparent client passthrough where possible, without depending on a local Codex test runner.

## Confirmed Facts

- The deployment is single-tenant and exposes one public port through Cloudflare Tunnel.
- CPA already adapts OpenAI Chat Completions, OpenAI Responses, and Claude Messages compatible channels.
- Every physical channel has one HAProxy backend with `maxconn 1`, `maxqueue 8`, and `retries 0`.
- That HAProxy invariant serializes all models and protocols belonging to the same physical channel.
- The current stable alias resolves to one fixed channel/model pair. It cannot select among multiple providers of the same model per request.
- `/models` discovery proves catalog presence only. It does not prove that a model works with a protocol or capability.
- Canary requests are real generation requests and must not run concurrently with production traffic on the same channel.
- CPA reconstructs upstream requests for its protocol adapters. A request produced by CPA cannot by itself prove how an upstream behaves when it receives the real Codex client envelope.
- The gateway already keeps private channel URLs, credentials, routes, runtime releases, and logs out of Git.

## Terms

- **Channel**: one physical upstream account/endpoint with a shared concurrency limit.
- **Provider model**: one upstream model ID available from one channel.
- **Logical model**: one public model ID backed by one or more provider models.
- **Candidate**: a channel/provider-model pair eligible to serve a logical model.
- **Direct model ID**: the existing `<channel>/<upstream-model-id>` ID that pins a request to one candidate.
- **Stable alias**: a client-facing name such as `coding-main` that can point to a logical model.

## Requirements

### R1. Channel Management

- The WebUI must list enabled, disabled, draining, busy, cooling, and configuration-error channels.
- The operator can add a channel using name, base URL, API key, default protocol, and priority.
- API keys are write-only: the UI can replace but never read them back.
- Deletion must disable and drain a channel first. An active reservation cannot be silently terminated.
- Configuration writes must be validated, backed up, and atomically applied or rolled back.

### R2. Model Catalog and Grouping

- The operator can explicitly synchronize one channel or all enabled channels from `/models`.
- New provider models default to the channel protocol and remain unverified until tested.
- Exact upstream model IDs may be grouped automatically only when they match exactly.
- The operator can manually merge differently named provider models into one logical model.
- Direct model IDs remain available for diagnosis and exact routing.
- Public logical IDs must not expose channel credentials or upstream URLs.

### R3. Request Scheduling

- A logical request is filtered by enabled state, protocol, declared capability, cooldown, and circuit state.
- An idle eligible candidate is preferred over a busy candidate.
- A channel with an active reservation is temporarily hidden from all new scheduling decisions, including requests for its other models.
- If every candidate for a logical model is busy, the gateway immediately returns `429 all_candidates_busy`; it does not enqueue the request on a busy channel.
- Health eligibility and health state come first; among candidates in the same health state, operator priority is the primary MVP ordering control and recent success/failure and latency are tie-breakers.
- When a candidate is selected, its channel semaphore is acquired before forwarding and released only after the response stream closes.
- No channel may have more than one active request across all of its models and protocols.
- HAProxy `maxconn 1` remains as defense in depth even after the scheduler adds its own semaphore.
- Direct model IDs use the same channel semaphore and cannot bypass concurrency controls.

### R4. Failure Handling

- Real request outcomes update passive health without creating extra probe traffic.
- `401/403` marks the channel authentication-failed and disables automatic selection.
- `402` marks the channel payment-blocked and disables automatic selection.
- `429` opens a cooldown honoring `Retry-After` when present.
- protocol/path errors such as `400/404/405/422` mark the candidate misconfigured instead of switching models silently.
- timeout and `5xx` degrade or open the circuit for subsequent requests.
- MVP must not replay a generation request automatically after it has been sent upstream. A later request may use another candidate.

### R5. Task-Based Availability Test

- The operator can run a server-side API canary on an exact provider model.
- The test sends one meaningful fixed task: `请写一首四句七言绝句，主题是秋夜读书。只输出诗题和诗句。`
- A test acquires the same channel semaphore as normal traffic. If the channel is busy, the UI reports busy and sends no upstream request.
- Tests are rate-limited and never run periodically unless a later explicit feature enables a schedule.
- Success requires a 2xx response and non-empty extracted text.
- The UI stores status, protocol, latency, timestamp, and redacted error class. It does not persist or log the generated poem.
- A test result must identify the request profile and whether the upstream request used native protocol forwarding or CPA's `adapted` transport.

### R6. WebUI and Administration Security

- The WebUI is served under `/admin` on the existing public port; no extra allocation is required.
- Public model APIs and admin APIs use separate credentials.
- Admin login creates an HttpOnly, Secure, SameSite=Strict session; mutating requests require CSRF protection.
- The management secret, channel keys, and Cloudflare token are never returned by admin APIs or written to logs. The gateway key may be returned only by an explicit authenticated same-origin reveal action protected by CSRF, with `no-store` responses and automatic UI re-masking; it is never present in the initial HTML, public APIs, or logs. A validated upstream Base URL may be returned only to an authenticated admin for channel identification; it is never returned by public APIs or written to logs.
- The UI must show the active reservation and elapsed time, last test, passive health, and current configuration revision.

### R7. Runtime Apply and Rollback

- The public router remains available while an internal CPA/HAProxy release is validated.
- Configuration changes produce a content-addressed release and a private revision backup.
- Apply drains active requests before replacing internal processes; failed startup restores the previous release.
- Control operations such as sync, apply, rollback, and delete are serialized as jobs.

### R8. Client-Environment Fidelity

- Requests arriving from a real client use transparent native forwarding whenever the selected channel supports the same wire protocol.
- Native forwarding preserves the incoming request body and actual non-sensitive end-to-end client headers except for the selected model, upstream authentication, target host, and transport framing required for correct proxying.
- Server-generated canaries use protocol-faithful public request shapes, streaming behavior, content negotiation, and an honest gateway client identifier.
- The gateway must not synthesize a hard-coded set of private headers or claim cryptographic client authenticity; the documented CPA compatibility flag may add CPA's own standard Codex headers on adapted traffic.
- Gateway credentials, cookies, proxy headers, Cloudflare headers, hop-by-hop headers, and inbound host/authentication are stripped or replaced before forwarding.
- Channels can select a reviewed request profile such as `responses-native`, `openai-chat`, or `claude-messages`; arbitrary user-defined header injection is not part of MVP.
- Chat Completions and Claude channels that require CPA translation are labeled `adapted`; their tests verify compatibility rather than exact native client-wire behavior.
- CPA's standard Codex compatibility headers may be enabled for adapted Responses traffic when an upstream needs shallow client compatibility; identity-confusion and system-prompt substitution remain disabled. Request fidelity for native traffic still comes from actual transparent passthrough.

## Acceptance Criteria

- Two channels offering the same logical model appear as one logical public model with two candidates in the admin view.
- Two simultaneous logical requests never create two active requests on the same channel.
- If candidate A is busy and candidate B is healthy and idle, the second request uses B.
- If every candidate is busy, the request receives `429 all_candidates_busy` and no additional upstream request is created.
- A manual test cannot run while any model on that channel is active.
- A successful manual test records a redacted result without storing response text.
- Disabling a channel immediately removes it from new scheduling while allowing its active request to finish.
- A failed configuration apply leaves the previous public routing behavior active.
- `/v1/models` returns logical IDs and stable aliases; direct IDs remain optionally callable for diagnosis.
- A server-side canary records its reviewed request profile and transport without claiming that it originated from Codex or Claude Code.
- A real incoming client's native request preserves its reviewed non-sensitive request headers without persisting their values.

## Out of Scope for MVP

- Multi-tenant accounts, billing, quotas, or per-user permissions.
- Automatic fuzzy model equivalence based on names.
- Scheduled synthetic probing or high-frequency health checks.
- Automatic replay of already-dispatched generation requests.
- Automatic capability claims inferred from a model name or `/models` result.
- Replacing CPA's protocol adapters with a new implementation.
- Uploading or copying the local Codex auth/config/state directory to the gateway server.
- Static imitation of private Codex request headers beyond CPA's documented compatibility mode.
