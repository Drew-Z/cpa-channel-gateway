# Model Control Plane Implementation Plan

## Current Status

Router MVP is implemented in the working tree:

- exact upstream IDs are automatically grouped into logical public models;
- logical, stable, pinned, and direct model IDs resolve through one scheduler;
- one in-memory reservation covers every model and protocol on a physical channel;
- busy candidates are skipped, and an all-busy result returns `429 all_candidates_busy` without another upstream request;
- same-protocol Responses traffic uses reviewed native passthrough, while other combinations use the internal CPA `adapted` transport;
- CPA now listens only on the internal loopback port and Node owns the single public port;
- cancellation, streaming lifetime, authentication replacement, header filtering, and no-replay behavior have integration coverage.

Persistent health state and redacted canary summaries now live in the Git-ignored `runtime/control-state.json`; stale transient health and cooldown entries are discarded on restore, while release-scoped failures are retained only for the same configuration digest. Configuration writes and model synchronization now share a low-sensitivity FIFO control-job queue, and pending channel/model changes drain new reservations without interrupting existing leases. The production start script now owns an injectable CPA/HAProxy child supervisor with readiness checks, old-release restoration, and a CSRF-protected runtime apply entrypoint; deployment rehearsal and audit history remain in later phases below.

The first admin slice is now also implemented: same-port `/admin`, in-memory HttpOnly admin sessions, CSRF/origin checks for tests, logical-model candidate status, exact-candidate poetry canaries with redacted summaries, revisioned stable-alias moves, persistent model enable/disable controls, and the serialized runtime apply path. Logical grouping edits remain later-phase work.

The authenticated connection helper exposes the current `/v1` Base URL and a masked gateway client key. Full gateway-key retrieval is a separate same-origin `POST` protected by the session CSRF token; it is never included in initial HTML and is automatically re-masked in the UI. Channel credentials remain write-only.

The private configuration slice now supports atomic, revisioned channel create/update/delete operations. New channels start disabled, deletion requires a disabled channel with no stable/pinned alias references, failed validation restores both private files, and every successful mutation reports that a restart is required.

运维导入也支持安全合并：`npm run merge:legacy -- <legacy-env>` 只更新旧格式文件中的渠道字段，保留现有密钥、Tunnel、启用状态、模型目录和别名，并将新增渠道置为禁用；写入前会创建私有 revision 备份。`npm run sync:models -- <channel-id>...` 可在不启用渠道的情况下显式同步指定模型目录，便于先目录发现、再任务型测活、最后启用。

## Phase 1: Contracts and Pure Logic

- Add versioned schemas for private providers, logical models, candidates, and redacted health state.
- Add migration from current channel environment entries to `providers.local.json` without logging secrets.
- Extract protocol-to-path and response-text handling from canary code for reuse.
- Implement and test logical model resolution, candidate filtering, deterministic ordering, and direct-route compatibility.
- Implement and test the per-channel semaphore, busy exclusion, cancellation, streaming release, and immediate `429 all_candidates_busy` behavior.

Validation:

```bash
npm test
npm run check
npm run audit:public
```

## Phase 2: Public Control Gateway

- Move CPA from the public allocation to a fixed internal listener.
- Add the Node public server for gateway authentication, `/v1/models`, request parsing, model rewrite, and response streaming.
- Add a native Responses transport that forwards same-protocol incoming client requests directly through the selected channel's HAProxy listener.
- Add a tested header policy that replaces authentication/target framing, strips sensitive and hop-by-hop headers, and preserves actual remaining client end-to-end headers.
- Add reviewed `responses-native`, `openai-chat`, and `claude-messages` request profiles with honest gateway identification for server-generated traffic.
- Forward requests requiring protocol adaptation to internal CPA and label them `adapted`.
- Keep HAProxy `maxconn 1` and no-retry configuration unchanged.
- Add passive outcome classification and circuit/cooldown state updates.
- Add integration tests with fake CPA and delayed streaming responses proving channel-wide serialization.

Critical tests:

- same channel, different models never overlap;
- same logical model, two idle channels follows ordering;
- preferred channel busy causes use of an idle alternate;
- direct model IDs cannot bypass the channel semaphore;
- a busy channel is excluded for all of its models;
- all candidates busy returns `429` without forwarding or queueing;
- aborted clients release reservations;
- streaming holds reservations until close;
- generation requests are not replayed after upstream dispatch.
- native requests preserve the actual client request envelope except for model, auth, target, and transport framing;
- adapted requests can never be reported as `native-passthrough`.

## Phase 3: Admin API and Configuration Jobs

- Add admin session, CSRF, origin checks, rate limits, and redacted error handling.
- Add channel CRUD with disable/drain/delete lifecycle.
- Add model sync jobs using the existing model-sync module.
- Add server-side API canary jobs using the fixed poetry task and non-queueing semaphore acquisition.
- Record request profile, transport, latency, status, and redacted error class without persisting generated text or header values.
- Add logical grouping, candidate priority, alias editing, validation, apply, and rollback endpoints.
- Add private revision backups and redacted audit events.
- Refactor child supervision so internal CPA/HAProxy can be replaced without restarting the public parent.

## Phase 4: WebUI

- Use Vite, React, TypeScript, the project's own compact design tokens, and `lucide-react` icons.
- Build Overview, Channels, Models, Routing, and Changes views.
- Add explicit busy, cooling, disabled, test-running, apply-running, success, and error states.
- Keep secrets write-only and response bodies absent from the UI.
- Verify desktop and mobile layout with Playwright screenshots; this is an operator tool, so favor dense tables and predictable controls over promotional cards.

## Phase 5: Protocol-Fidelity Validation

- Preserve the one-port Pterodactyl deployment and existing Cloudflare Tunnel origin.
- Add migration and rollback documentation.
- Add fixture upstreams that capture request shape in memory and assert native header/body preservation without writing sensitive values.
- Verify Responses SSE and non-SSE behavior, Chat Completions, Claude Messages, authentication replacement, and hop-by-hop header stripping.
- Run the meaningful poetry canary through each enabled request profile and confirm that adapted requests are labeled correctly.
- Keep CPA identity confusion, Claude cloaking, and system-prompt substitution disabled in generated configuration tests; the documented Codex compatibility-header switch is explicitly covered by the generated configuration test.

## Delivery Slices

1. **Router MVP**: logical models, channel semaphore, busy-aware selection, no WebUI.
2. **Operations MVP**: admin API, manual model tests, model sync, apply/rollback.
3. **WebUI MVP**: all routine operations without editing files manually.
4. **Protocol fidelity**: native client passthrough, reviewed server canary profiles, and transport-label verification.

Each slice must pass unit tests, integration tests, `npm run check`, `npm run audit:public`, and a real one-request canary before deployment.

## Rollback Points

- Router MVP can fall back to the current topology where CPA owns the public port.
- Private config migration retains the original ignored env/routes files and writes timestamped backups.
- Every apply retains the previous content-addressed internal release.
- Protocol profiles are versioned configuration; rollback restores the previous generated release and profile revision.

## Decisions Required Before Implementation

- Later decision: whether an explicitly opt-in, pre-response cross-channel retry is worth the duplicate-generation risk. It is excluded from MVP by default.
