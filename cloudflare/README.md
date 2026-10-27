# Cuse durable webhook stage

Pi Durable / Cloudflare runtime with authenticated MCP event intake, private
history import, gated active model/tools, renewal and shared desktop coordination.
It has no direct IRC connection. Default operation is passive; live migration
remains blocked on inventory, identity and capability parity.

See the [migration plan](../docs/durable-webhook-migration.md) for exact contracts,
private rehearsal commands, activation gates, remaining gaps and rollback.

With Node 24, run `npm run bootstrap` at repository root for the original history
projector, then here: `npm ci --ignore-scripts`, `npm run check`, `npm test`,
`npm run test:worker`, and `WRANGLER_SEND_METRICS=false npm run dry-run`.
Tests use synthetic credentials/model/tool responses and local workerd only.
Main-branch Worker deployment uses the reviewed workflow below. Secret and
subscription configuration and live cutover still require separate review.

## Partial-output checkpoint interval

`CUSE_PARTIAL_SAVE_INTERVAL_MS` is an optional non-secret Worker variable. It
sets Pi Durable's `progress.partialIntervalMs` when an active session opens.
The default is **1000 ms** (previously Pi's 100 ms default). Set it in Worker
variables or local `.dev.vars`, for example `CUSE_PARTIAL_SAVE_INTERVAL_MS=2000`.
Only decimal integers from **1 to 60000** are accepted; empty, fractional,
non-finite and out-of-range values fail session opening with a clear error.
Changing it requires the Worker/session to reopen; it does not mutate history.

This coalesces streamed partial-output snapshots, not every storage write.
Final responses, cancellation/error handling and tool intent/result durability
continue through Pi's existing paths without waiting for the interval. Pending
partial text is not force-flushed on cancellation; Pi retains its existing
terminal-state and recovery behavior. Abrupt
process loss can lose the latest uncheckpointed partial text (a larger interval
increases that window); this is not a guarantee of a periodic write when idle,
nor a change to tool replay policy. Actual total write savings depend on load.

## Automatic subscription recovery (explicit option)

`CUSE_SUBSCRIPTION_RECOVERY=automatic` enables persisted, rate-bounded recovery
only for explicitly selected existing sessions. **`CUSE_RECOVERY_SESSION_IDS` is
required:** a JSON array of 1–64 unique full lowercase 64-hex Durable Object IDs.
There is no implicit all-session mode, wildcard, prefix or agent-name matching.
Resolve each ID from the reviewed `SESSIONS` namespace and exact immutable route
(`objectKey(route)` includes agent, channel and generation), then independently
verify that it belongs to the intended agent/session before enabling it.
Non-listed sessions retain manual behavior, even when the Worker-wide mode is
automatic; selection occurs before stopped-grant migration. Missing or malformed
allowlists fail closed. The default `manual` preserves
fail-closed behavior. Automatic mode never creates a new channel, resets a
conversation, changes authentication, or retries an uncertain remote action.

Recovery uses the exact existing subscription identity and the saved
**producer-acknowledged** cursor, never a last-arriving webhook cursor. It needs
compatible producer coverage provenance to distinguish a surviving subscription
from a deleted/recreated subscription with the same deterministic ID. Initial
legacy enrollment requires the exact retained acknowledged producer receipt;
a zero/pruned cursor or numeric cursor range alone is not continuity proof.
Unknown or conflicting provenance remains held unless the explicit resume
policy produces an audited acknowledgment of loss.

- `CUSE_RECOVERY_MIN_DELAY_MS`: integer 1000–3600000, default **30000**.
- `CUSE_RECOVERY_MAX_DELAY_MS`: same bounds, default **900000**, at least minimum.
- Retry reservations and the next eligible time are persisted before network I/O;
  repeated failures use capped exponential cooldown, including across restarts.
  Automatic attempts remain rate-bounded while the subscription is unavailable.
- `CUSE_RECOVERY_GAP_POLICY=hold` (default) allows only proven continuity repair.
- `CUSE_RECOVERY_GAP_POLICY=resume` explicitly accepts that unavailable older
  messages may never be processed. The producer records a gap generation and
  acknowledged-loss boundary; Cuse durably records and queues a gap warning.
  This is **degraded continuity**, not a claim that missing history was recovered.
  Every newly detected gap is reconciled and recorded separately. Producer proof
  is bounded (20 native pages, 4 MiB, 15 seconds); a gap not provable within that
  budget is not evidence of complete history. Budget exhaustion or paging errors
  remain held for another bounded attempt, even in resume mode.

Session allowlists and delay/gap-policy overrides require automatic mode. Invalid values fail clearly.
Roll out the compatible producer first, then Cuse, and only then enable the
option for the reviewed session IDs. An older producer cannot supply the
incarnation/gap proof; do not enable the option and assume a legacy clean
boolean proves recovery. No secret rotation or subscription deletion is needed.

Removing a session ID from the allowlist stops its Cuse recovery attempts.
To disable automatic mode entirely, also remove its allowlist/delay/gap settings. The producer receives the
opt-out on the next successful ordinary renewal (or stops recovery when its
lease expires). For an immediate producer opt-out, renew the same approved
subscription without the recovery option; do not unsubscribe or recreate it.
Previously acknowledged loss remains in the audit and is not erased by opt-out.

Existing queued jobs and producer outbox rows are preserved. Normal event-ID
receipts deduplicate replay; uncertain delivery/tool effects keep their existing
fences and are never automatically repeated by subscription recovery. Callback
failures and expired leases can recover without an operator, but this does not
repair missing credentials, corrupt storage, or unknown external side effects.

## Reviewed restricted-IRC repair (default off)

`CUSE_RESTRICTED_IRC_SESSION_IDS` is a JSON array of 1–64 unique lowercase
64-hex Durable Object IDs, each already in `CUSE_RECOVERY_SESSION_IDS` with
`CUSE_SUBSCRIPTION_RECOVERY=automatic`. Only those sessions derive
`fullControl=false` and `exclusiveProfile=false` at runtime. No encrypted binding,
credential, reviewed snapshot/hash, archived conversation or retained history is
rewritten. The runtime catalog is a subset: only already-present
`weechat_buffers` / `weechat_msg` IRC tools remain, constrained to the configured
buffer. Dynamic IRC commands, `irc_send`, `agent_ask` and automatic peer-envelope
answers are denied; unrelated existing tools and read-only peer status remain.
A missing message tool is not added to the model catalog; ordinary final replies
still use the existing host outbox and restricted message adapter.

An operator may separately acknowledge **one reviewed uncertain recovery-gap
warning**, accepting that its delivery remains unknown and it may never appear
in IRC. This is not automatic uncertainty reconciliation. Set the non-secret
`CUSE_RECOVERY_GAP_ACK_REQUEST` to an exact JSON object with `id` (32 lowercase
hex), `sessionId` (64 lowercase hex), `expiresAt` (Unix milliseconds, at most
30 minutes ahead), `incarnation` (32 lowercase hex), and positive integer
`generation`. The exact session must also have restricted IRC enabled and a
valid subscription. The warning must match the audited generation, exact
route-derived effect ID/event and canonical warning payload, and have state
`uncertain` with error `send_uncertain` or `interrupted`. No ordinary reply or
other uncertain action qualifies.

The synchronous transaction records `cuse_gap_notice_ack` with the previous
state/error and outcome `unknown_delivery_accepted_without_replay`, then marks
only that warning `acknowledged_uncertain`. Its original payload/error remain;
it is never marked sent or replayed. Identical requests are idempotent, conflicting
requests fail closed, and every other uncertain action retains its fence.
Queued jobs are neither deleted nor reset. Future gap generations require their
own warning and cannot reuse this acknowledgment.

Deploy code first; activate the exact-session restriction, verify the effective
adapter with the bounded read-only diagnostic, and only then install the reviewed
acknowledgment. Remove the expiring request after its audit row is confirmed;
keep the restriction while the producer remains restricted. Preserve all existing
bindings/secrets using supported inheritance. Do not remove the restriction as
an ordinary rollback: doing so restores the historical adapter configuration.
Older code does not understand the terminal acknowledgment and may hold the
outbox rather than send it; rollback therefore requires review, not a state
rewrite or replay. These options do not enable producer full-control mode.

## Optional one-shot recovery diagnostic

`CUSE_RECOVERY_DIAGNOSTIC_REQUEST` is disabled when absent. An operator may supply
JSON `{ "id": "<32 lowercase hex>", "sessionId": "<full 64-hex DO ID>",
"expiresAt": <epoch milliseconds> }` with a lifetime of at most 30 minutes.
It runs only for that exact already-recovery-allowlisted session. Remove the
variable after observing the result; reusing the same request ID never reruns it.

The diagnostic reserves its attempt before I/O, then performs only a bounded
MCP tool-list and one-line buffer identity read (10-second per-request limits).
It never invokes a message, command, model or tool effect. The separate
`cuse_recovery_diagnostic` table contains only timestamps, booleans for configured
adapter/identity/required-tool presence, listing completeness, and fixed failure
categories. No credentials, endpoints, chat text, tool payloads or exception
strings are stored or logged. A paginated listing cannot prove a tool absent.
A crash leaves a reservation, not an automatic retry. Existing uncertain effects,
queued work and history-gap audits are unchanged. This is current preflight
evidence, **not proof of whether an earlier uncertain send reached IRC**.

## GitHub Actions deployment on main

`.github/workflows/deploy-cloudflare.yml` runs on pushes to `main` (including
merges), not PRs or `workflow_run`. It calls both existing validation workflows:
release/native Docker checks and Worker type checks, unit/integration tests and
Wrangler dry-run. Deployment requires both to pass for that same event commit.
The deploy job checks out the exact `github.sha` and rebuilds from committed
lockfiles using Node 24 and Wrangler **4.150.0**, not an unpinned `npx` download.
PR and other branch validation remain credential-free. The entire main pipeline
is serialized with cancellation disabled for running deployments; GitHub may
replace a pending run with a newer push and does not guarantee queue order.
Before accessing Cloudflare credentials, a read-only GitHub API check skips a
superseded SHA and fails closed if current `main` cannot be verified. Re-running
an old workflow therefore cannot deploy its old SHA unless that is current main.

### One-time prerequisites (not provisioned by this repository)

1. Verify the intended Cloudflare account and `cuse-durable-shadow` Worker.
   The checked-in configuration keeps four SQLite Durable Object classes:
   `AgentSession`, `DesktopCoordinator`, `ModelAuthority`, and `ChannelRegistry`.
   First deployment applies its `v1` migration if not already present. Review
   existing migrations/bindings before targeting an existing Worker.
2. Create the GitHub environment **`cloudflare-shadow`**; restrict deployment
   branches to `main` and configure any required reviewers before enabling it.
3. Set environment variable **`CLOUDFLARE_ACCOUNT_ID`** to the verified account ID
   and environment secret **`CLOUDFLARE_API_TOKEN`** to an approved scoped token.
   Both are mandatory; missing values cause a clear failure before deployment.
   Use the least privilege supported for the intended operation: the documented
   Workers **Editor** role scoped to this existing Worker includes its Durable
   Objects. Creating a Worker for the first time requires separate provisioning
   authority (Workers **Creator** at account-product scope), rather than leaving
   broad creation permissions on the steady-state deploy credential. Verify the
   token's available permission/resource scope with your account administrator.
   Never commit credentials or use a Global API Key.
4. Provision/approve runtime secret bindings separately using the migration plan.
   This workflow does not create, rotate, upload or delete Worker secrets, import
   history, register MCP subscriptions, or switch sessions into active mode.
   Wrangler preserves existing secrets; `--keep-vars` also preserves configured
   dashboard variables. Existing active state is not reset to passive by deploy.
   A first deployment without runtime bindings is **not** a live-service cutover.

Cloudflare's [GitHub Actions guide](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
uses an API token plus account ID. No native GitHub OIDC-to-Workers deployment
credential exchange is assumed here; the workflow does not request `id-token`
or introduce an identity broker. See also the [Workers roles and scope reference](https://developers.cloudflare.com/workers/authorization/workers/).

After a merge, inspect both validation jobs and the deployment result for the
expected SHA. The workflow deploys only the Worker, **not** the native Docker
service. Do not configure secrets/subscriptions or change runtime activation as
part of a retry. Code rollback needs a separately reviewed known-good revision;
Durable Object data/schema migration rollback is not implied by a code rollback.

## Explicit private activation

The separate `operate-cloudflare.yml` workflow accepts manual `stage`, `activate`
and `cleanup` actions on current `main` only, after a successful deployment of
that same commit. It uses the protected `cloudflare-shadow` environment and the
same concurrency group as deployment. A code deployment never starts this flow.

Prepare a private package outside the checkout with `worker`, `approvedUntil`
(at most two hours ahead), and `runtime`. The runtime contains exactly three
JSON strings: `MODEL_SECRETS`, `MODEL_CONFIG`, and `WEBHOOK_ROUTES`. Each must fit
Cloudflare's 5 KB binding limit. Every route must have `activationPending: true`.
Gzip and base64 encode the package; store at most 48,000 characters in environment
secret `CUSE_OPERATOR_PACKAGE` and the remaining at most 48,000 characters in
`CUSE_OPERATOR_PACKAGE_2`. Never commit packages, credentials, archives or live
session inventories. Delete these temporary GitHub secrets after the operation.

`stage` installs runtime bindings with normal event delivery held at HTTP 503;
signed callback verification challenges still work. It creates no subscription
and starts no conversation. It enables an inert cron and waits for a log carrying
a fresh warmup nonce before succeeding. Keep the legacy owner active during
this wait: cron changes can take up to 15 minutes to propagate, longer than the
producer's bounded retry window. Activation preserves that warmed schedule.
Before `activate`, fence the legacy owner, verify
that the dedicated MCP profile owns the exact nick and buffer, and obtain the
reviewed existing subscription grant. Include `operator` in the package with
version 1, a fresh 32-character hexadecimal `id`, `routeKey`, complete `snapshot`,
matching `fence`, and `grant`. The workflow supplies a thirty-minute request lease (allowing cron propagation).
The fence must attest ownership release and identity verification, and the exact
snapshot hash must match the enabled route. Use empty archive/context arrays for
an approved fresh conversation; keep the original history and paused goal on the
retained rollback volume, referenced by private retained-state metadata.

The operator request is gzip encoded into at most 32 encrypted Worker secret
bindings of at most 4,800 characters each. A temporary minute cron invokes a
private Durable Object method; there is no public administrative HTTP endpoint.
Initialization validates the model and exact tools, imports the reviewed context,
and arms the existing grant. Repeated execution of the same request is idempotent
and does not reset renewal deadlines. Only a structured completion log matching
the request ID releases the delivery hold. No model prompt runs during setup.

The workflow removes the cron and request secrets after activation, including on
failure. Successful staging leaves its inert cron ready for handoff; run
`cleanup` if abandoning the cutover. A forced cancellation may interrupt cleanup: run `cleanup` explicitly;
the expired request also fails closed. Existing unrelated cron schedules cause a
failure before writes. On any failure, retain the legacy ownership fence, inspect
aggregate state, and do not replay uncertain effects. Rollback requires first
fencing the new owner before restoring the legacy service and its retained data.

### Adding another agent

Keep the original runtime secrets in place. Each additional agent uses a separate encrypted `CUSE_AGENT_<NAME>` binding (uppercase letters, digits and underscores; at most 48 characters). Its lowercase name is the webhook route key, such as `CUSE_AGENT_CUSE2` for `/events/cuse2`. The JSON value contains `binding`, `modelConfig`, and `modelSecrets`. Model configuration and authentication are selected only for that exact agent generation; each agent requires a separate native MCP profile and signing key.

The private operator package may contain exactly one such binding instead of the original three runtime secrets. Staging refuses an already installed binding name, leaves existing live agents unchanged, and holds only the new route. Activation initializes the reviewed generation and opens only that binding. The temporary cron and operator request are removed afterwards. Never use an original-agent package to add an agent or overwrite live route secrets.

### Single owner, channel sessions, and ChatGPT sign-in

The deployment has one owner (`CUSE_OWNER_NICK` on the trusted IRC network) and one encrypted credential authority (`CUSE_OWNER_PROFILE`). `CUSE_PUBLIC_URL` is its HTTPS origin. Each IRC channel retains its own AgentSession Durable Object, conversation, desktop, goal, schedules, model choice, and recovery records. The separate WeeChat MCP profiles and webhook signing keys identify channel transports; they are not separate user accounts. Non-owner human messages are ignored. Explicitly configured peer agents retain their existing limited peer behavior and cannot run owner commands.

In either channel:

1. Send `,login` or `,login openai`.
2. Open the expiring browser link and choose **Continue with ChatGPT**.
3. After authorization, copy the final `http://127.0.0.1:1455/auth/callback?...` URL from the browser address bar into the private form on the Cuse sign-in page. Never send that URL in IRC. The browser may show a failed loopback connection; this is Pi's manual remote-login fallback, because a Worker cannot listen on the user's computer.
4. Send the short `,login confirm <code>` shown by the browser in either channel. This installs the owner credential shared by both sessions.
5. In each channel, use `,model openai/gpt-6.1-sol`. Model selection stays local to that channel.

`,login status` reports connection metadata; `,login cancel` discards a pending flow without deleting installed credentials. These are host commands, so login does not require a functioning model token and can bypass an older blocked model turn. Uncertain IRC sends still require reconciliation and are never repeated automatically.

The fetch-only Worker adapter follows pinned Pi AI 1.2.0's `openai` Sign in with ChatGPT protocol: dynamic public-client registration, a stable installation ID, PKCE S256, state, nonce, direct-token scope, the issued client ID, the public `api.openai.com/v1/responses` endpoint, and refresh with the same resource/client ID. There is no client secret. The pending verifier and credentials are AES-GCM encrypted. Browser forms are origin checked, non-cacheable and framed out, with a same-origin referrer policy that suppresses cross-origin referrers while preserving the Origin header on browser form submissions. Callback exchange is reserved before dispatch and never retried after uncertainty. A browser authorization must be confirmed by the configured IRC owner before installation, because an IRC link can be seen by other channel participants.

The shared `CredentialVault` implements Pi's credential-store contract. Expired tokens refresh once under a serialized lease, persisting the rotated token encrypted. Interrupted refreshes remain held for reconciliation or an explicit new login. Credential installation and its receipt commit atomically; a retried confirmation cannot replace a newer rotated token. No login cron, temporary deployment token, auth package, or operator request is needed.

The former protected `authenticate-cloudflare.yml` operator workflow and `openai-codex` provider remain available for rollback. `openai-codex` is Pi's legacy provider; its tokens are not treated as native `openai` credentials. The native owner resolver requires the issued client ID and direct-token scope and never falls back to an API key. Transport selection follows the provider API: only `openai-codex-responses` uses the strict legacy encoder; native `openai-responses` uses normal JSON fetch with redirects disabled. A real-workerd test drives the actual Pi Responses SDK through a tool call, tool-result request, and final reply using this production wiring. Legacy compression below applies only to that legacy endpoint.

Codex SSE requests use the pinned SDK's usual zstd encoding. Workers' native zstd API throws on the full tool-catalog request, so a pinned, precompiled WASM encoder handles the SDK's uncompressed fallback at the same compression level. It requires no runtime WASM compilation, filesystem access, or network download. The adapter bounds input at 2 MiB, preserves authentication and session headers, rejects redirects, and sends each request once. It changes neither the model endpoint nor the credential owner.


### Turn continuation and native recovery behavior

The Worker retains pi-durable and shares the native desktop MCP client, viewer formatting, and ambiguous-dispatch guidance. An uncertain remote action keeps its intent and desktop fence; it cannot be dispatched again. The model can still explain the failure and answer later prompts. Read-only desktop status remains available.

Ordinary Worker turns allow 64 model requests and 256 tool calls, replacing the cutover snapshot's eight-request allowance. Goal token budgets and delegation restrictions remain enforced. Reaching the model limit produces a retained IRC notice rather than silently holding later messages.

Native `beforeRequest` and pre-intent `beforeTool` hooks divide execution into conservative slices (30 request-cost units, 150 seconds between dispatch boundaries). At a yield, the host closes the harness before dispatch, retains the engine checkpoint, and defers the same inbox item to another alarm. It submits the same request ID after reopening; it does not inject a new user prompt or replay completed tools. A model request reserves two units and a tool reserves six; this leaves room for MCP initialization and control traffic. This reservation is a scheduling allowance, not a measurement of arbitrary downstream retries. A single slow or failing remote call can still time out and require reconciliation.

Restart recovery resumes only inbox records explicitly marked `engine: pi-durable` with their matching request ID. Legacy/unmarked interrupted records and uncertain outgoing IRC sends stay held. The original archived conversations, paused goals, and interrupted operations are never implicitly resumed.


Codex HTTP diagnostics are retained in the existing `cuse.model-failure` document for the input. The SDK response hook records only status, a validated Cloudflare Ray ID, media type, and timestamp. The original provider callback still runs, and a diagnostic persistence failure only reports a bounded code. Request bodies, authorization headers, cookies, and response bodies are excluded from this metadata. Ordinary requests continue using the same endpoint, encoding, credentials, and zero-retry policy.

### Reviewed browser-read recovery

The configured owner can issue `,recover read <task-id>` after inspecting a held tool. The host verifies the task belongs to this conversation, is terminal, is a `run_js` call matching the strictly bounded legacy URL/body read grammar, and is the only pending recovery intent. It releases only that exact desktop operation and records an idempotent harness receipt. It never repeats the tool or resumes a stopped task. Arbitrary JavaScript, navigation, clicks, writes, lifecycle actions and other uncertain operations are refused. A repeated recovery cannot release a newer desktop lock. This host control works while an older inbox turn is blocked; it does not cancel that turn.

A tool refused by an existing recovery guard now explicitly reports that it was never dispatched. This prevents the agent from mistaking a held browser read for a new failure to start the desktop.

Typed `weechat_buffers` and skill resource reads are safely repeatable and do not create action-recovery fences. An exclusive full-control IRC profile may inspect another channel on its own server after both control and target identities are validated. Writes remain bound to the control buffer. Owner `,recover read <task-id>` also recognizes legacy held `weechat_buffers` reads; it clears only the exact matching guard and never repeats a join or other action.
