# Staged migration to Pi Durable and WeeChat MCP events

Status: staged implementation and local active rehearsal for review, **not a production cutover**. The new
`cloudflare/` entry point has no direct IRC client, native WeeChat subprocess,
resource listener, or fallback connection. Incoming traffic is exclusively signed
MCP Events webhooks. The read/reply adapter uses authenticated MCP tools.
The external weechat-mcp service owns its IRC connections.

The deployed cuse service is not changed by this package. Its legacy entry point
remains available for the reviewed rollback window. A narrowly scoped fix handles
model authentication validation before session mutation, so that validation does
not propagate into native transport disposal. This fix has not been deployed.

## What is implemented

- Separate Workers build with pinned Pi Durable 1.2.0, a SQLite Durable Object per
  `(agent home channel, actual channel, migration generation)`, and actual Pi
  Durable passive conversation writes. Agent identity is never inferred from nick.
- Raw-byte Standard Webhooks HMAC verification, five-minute signature freshness,
  bounded streaming input, event/header/channel/subscription checks, signed
  verification challenge echo, and unique signing keys per route. Authentication
  happens before an object can be addressed. No public state/admin endpoint.
- Atomic bounded inbox, persistent receipts, conflicting-ID rejection and an
  immutable cutover manifest. Opaque event cursors are never sorted or substituted
  for native IRC server IDs. Out-of-order requests retain arrival order; timestamp
  order is not claimed. The producer normally serializes delivery per subscription.
- Alarm-driven bounded passive journaling with stable Pi request IDs. A crash
  between Pi commit and inbox completion safely reuses the original receipt.
  Intake/alarm work is serialized to avoid deleting a newly scheduled alarm.
- Active Pi execution behind a reviewed snapshot hash, immutable generation and
  explicitly armed live grant. Persisted request IDs/checkpoints resume the same
  submission. Model/tool budgets are reserved before calls; provider retries are
  disabled. Deadlines, durable cancellation and late-completion fencing apply.
  Unsafe tool intents surviving restart block further generation for review.
- Private legacy exporter, read-only dry run and resumable history importer.
  Raw entries remain an archive; the original vendored Pi context projector
  supplies model context. Model/thinking/instructions, exact tool names, desktop
  bindings and peer budget survive import. Unsupported capabilities block import.
- Durable desktop coordinator shared by desktop ID across conversation objects.
  Remote APIs cannot honor a fencing token, so locks never expire or transfer
  after uncertainty. Review is required before reconciliation. This excludes
  overlapping calls, not an entire multi-call browser workflow.
- Persistent outgoing intents: reserve before I/O, never retry an uncertain
  dispatch, preserve uncertain state through restart, and block later sends behind
  it. `dispatched` means local MCP acceptance, not delivery to IRC. IRC does not
  supply a verified idempotent send API; exactly-once delivery is not promised.
- The exact `events/subscribe` / `events/unsubscribe` protocol, finite TTL,
  bounded renewal controller, and fresh authenticated HTTP MCP connections with
  pinned protocol `2026-07-28`. Refresh reuses exact arguments/callback, omits the
  cursor for routine renewal, and stops on changed grant identity or truncation.
  Renewal is explicitly armed only for an already-approved grant. It is not
  created on startup; once armed, renewal shares the Worker alarm with inbox work.
  Expiry, changed grant ID or truncation stops active processing. No live grant
  has been created.
- Safe failure codes and aggregate state counts, without payloads, keys, headers,
  cursors or arbitrary exception strings in Worker logs.

Default operation remains passive. Active execution requires all of: an internal
`prepare(snapshot,fence)` call on a **fresh generation**, an approved route access
binding whose `enabledHash` matches the snapshot, approved model credentials,
verified exclusive MCP identity, and `armRenewal(grant)` for an already-approved
subscription. There are no public import/activation/admin HTTP endpoints. Internal
RPC methods are not an authorization substitute; deployment/binding changes and
these operator actions require the rollout review below. No credential,
subscription, Cloudflare resource or network change is performed by local tests.

Current provider adapters use existing API-key configuration for OpenAI,
Anthropic and OpenRouter. Missing models/auth fail before import or model-setting
mutation; no fallback model is selected. OAuth/custom catalogs need a reviewed
credential/catalog adapter, including refresh-token ownership, before those agents
can migrate. Do not copy auth.json or replace an OAuth model silently.

Remote desktop tools use the existing `/<desktop-id>/mcp` endpoint and preserve
the desktop ID. Native host control tools (`desktop_control`, `schedule_prompt`,
skills and goals) are not equivalent to remote MCP tools: the exporter flags
these, active schedules/goals and custom context projectors for adapter review.
Only fixed-buffer `weechat_buffers` and guarded `weechat_msg` are currently
accepted as model-facing IRC tools. Existing broader communication tools require
explicit scoped adapters; they are never silently omitted or sent unrestricted.
Other legacy comma commands are not yet implemented. Preserved cost/goal state is
archived, not falsely described as an enforced active cost ledger. These are
remaining parity gates, so this PR is not a completed live migration.

## Private inventory and import rehearsal

Run the exporter with an existing authorized read-only shell or consistent private
snapshot. It reads channel state, JSONL history, durable session SQLite and the
delivery ledger; it does not read credential files or contact services. Output
must be outside the repository, is created mode 0600 and never overwrites a file.
A double-read digest detects changes but does not prove a quiescent handoff.

```sh
npm run bootstrap
node cloudflare/scripts/inventory.mjs --state /private/channels.json \
  --session-dir /private/sessions --delivery-db /private/irc-delivery.sqlite \
  --out /private/inventory.json --config /private/reviewed-mappings.json
node cloudflare/scripts/import.mjs /private/snapshot.json
node cloudflare/scripts/import.mjs /private/snapshot.json /private/rehearsal.sqlite /private/fence.json
```

The optional reviewed mapping is keyed by the existing `sessionKey(agent,channel)`
and supplies the exact route, preserved instructions, tool schemas/targets and
execution policy. The inventory contains `snapshots`; select one into the private
snapshot file. Review counts, blockers and source equality before import. A fence
contains `snapshotHash`, `generation`, `after`, `legacyOwnerReleased:true` and
`identityVerified:true`. Those assertions require evidence; a synthetic rehearsal
may use synthetic owners only. A changed snapshot cannot overwrite an import.
Raw history imports in atomic 50-entry batches, advancing a receipt in the same
transaction. Rehearsal never starts the model scheduler or uploads data.

Live per-agent inventory is still blocked in the current cloud task: the connected
Railway tools expose redacted variables and service metadata, but no production
shell/volume reader; the execution environment has neither a mounted state volume
nor existing CLI authentication. No replacement credentials were created. The
private operator report is kept outside this public repository.

## Verified upstream contract

Source inspected: weechat-mcp commit
`e54ead2234d39d0aaa2e1efb8ffa67290c4154ae`.

- [`MCP_EVENTS.md`](https://github.com/r33drichards/weechat-mcp/blob/e54ead2234d39d0aaa2e1efb8ffa67290c4154ae/MCP_EVENTS.md)
- [`event_protocol.py`](https://github.com/r33drichards/weechat-mcp/blob/e54ead2234d39d0aaa2e1efb8ffa67290c4154ae/event_protocol.py)
- [`mcp_events.py`](https://github.com/r33drichards/weechat-mcp/blob/e54ead2234d39d0aaa2e1efb8ffa67290c4154ae/mcp_events.py)
- [`event_webhooks.py`](https://github.com/r33drichards/weechat-mcp/blob/e54ead2234d39d0aaa2e1efb8ffa67290c4154ae/event_webhooks.py)

The event is `{eventId,name:"message.created",timestamp,cursor,data:{channel_id,
message_id,nick,text}}`. Subscription arguments require `channel_id` and `trigger`
(`message` or `mention`, with `nick` for mentions). Subscription results are
`{id,refreshBefore,cursor,truncated}`. No invented `expiresAt`, webhook payload
`subscriptionId`, per-event server-msgid, or sender identity token is used.

The signed input is `webhook-id + "." + webhook-timestamp + "." + raw body` using
the decoded `whsec_` secret; signatures are space-separated `v1,<base64>` values.
`X-MCP-Subscription-Id` is not inside that signature, hence unique route secrets
and an explicit expected subscription binding are necessary. Challenges are
signed `{type:"verification",challenge}` payloads and receive `{challenge}`.

Replay is bounded (24 hours / 10,000 settled events, bounded native history).
Default subscription TTL is one hour, maximum 24 hours. `truncated:true`, expiry,
queue overflow, interrupted native buffer lifetime, or a suspended producer grant
requires operator review. Never claim lossless history or silently re-subscribe
at the current tip. No optional Jev filter is requested by this migration.

Architecture references:
[article](https://earendil.com/posts/pi-durable-on-cloudflare/) and
[sample source](https://github.com/earendil-works/pi-durable-cloudflare/blob/dcb56ce2d174babb3f00112ac5b8cd597e58ab45/src/session.ts).
The sample's unauthenticated demo endpoints were not adopted.

## Inventory required before cutover

Keep live service IDs, deployment state, volume locations, private buffer names,
nicknames and per-agent settings in a private operator report, outside the public
repository. Read-only inventory is not yet complete. Every existing agent must be
resolved to its actual state, history, model, desktop and external MCP connection
before active migration. A service list alone does not inventory agents stored
inside a service's persistent state.

**Identity capability gap:** the current MCP server executes commands in an exact
WeeChat buffer and uses that buffer's server connection nickname. It exposes no
per-call `agentId`, independent nick selector, profile selector or atomic
identity-bound send. A single shared connection cannot preserve several distinct agent nicks. The prepared adapter verifies buffer/nick metadata before
dispatch but that read cannot reserve identity atomically. Do not switch the nick
before each send: it changes a shared network identity and races other work.

The upstream `container_entrypoint.py` configures one `WEECHAT_HOME`, one server
named `docker`, one `IRC_NICK` and its channels. HTTP MCP clients connect to that
same WeeChat process; separate HTTP connections do not create profiles. Minimal
configuration-only solution: one independently owned external service/home and
stable MCP principal/event database per agent identity, using exact buffer names.
An alternative upstream change is an explicit named-server configuration list,
per-principal buffer restrictions, and startup connection of each configured
server. It needs tests for cross-profile reads/sends/subscriptions and atomic
ownership; merely adding a request `profile` field would not provide isolation.
Neither alternative has been provisioned or changed in this PR.

Before active execution, either verify existing external WeeChat connections for
each preserved identity and scope credentials/buffers to them, or review an
upstream identity-routing capability. Creating/configuring such connections,
credentials, network policy or paid services requires separate approval. Do not
reintroduce a cuse-owned bridge/subprocess as a workaround. No upstream code change
is needed for the verified webhook contract and none is proposed here.

## Parity requirements before active migration

1. Read-only inventory every agent including persisted agents: stable home key, actual-channel
   session keys, nick, remote connection mapping, provider/model/thinking settings,
   histories, active/queued work, schedules, receipts, pending/uncertain outputs,
   peer budgets, goals, desktop bindings, tool permissions and cost/turn caps.
2. Make a consistent private backup/export with hashes/counts. Never include
   credentials or private conversations in a PR/log. Current vendored Pi 0.85.1
   state is not assumed schema-compatible with Pi Durable 1.2.0. Rehearse the
   implemented importer against a sanitized export. Shadow conversations are not an
   import or a substitute for those histories. Keep originals intact.
3. Preserve the existing prompt framing, mention/control-channel rules, peer
   distrust and loop budgets. Upstream excludes its own nick, which may differ
   from the intended agent nick until identity mapping is complete.
4. Keep browser/computer sessions and arbitrary native filesystem/process tools in
   their existing authorized remote runtimes. Workers must not mount local auth
   files or spawn WeeChat, Python, shells or browsers. Reconnect the same desktop
   IDs rather than creating replacements. A durable shared-resource coordinator
   with fencing is required before two conversation objects can share a desktop;
   existing process-local locks cannot provide cross-object exclusion. The
   coordinator and remote tool adapter are implemented and tested locally; actual
   agent mappings and any multi-call workflow locks still require review.
5. Test model/provider credential validation before changing committed settings;
   no silent provider fallback. Test durable budget accounting around failed and
   repeated model/tool calls. Do not mark arbitrary remote tools replay-safe.
6. Wire the approved subscription renewal controller into the same alarm deadline
   calculation as active Pi tasks; alarm first, scheduler second. Use stable
   server-side owner authentication and existing private persistent MCP_EVENTS_DB.
   Do not renew expired/suspended grants as a new future-only grant silently.

## Reviewable rollout gates

1. **Local stage (this PR):** run synthetic tests, build/dry-run and review the
   implementation. No live callback, credentials, new subscriptions or traffic.
2. **Approved passive staging:** separately approve exact Cloudflare resources,
   route/secret bindings, webhook URL, existing MCP principal, subscription args,
   TTL and expected data disclosure. Create one test-channel grant explicitly;
   retain the returned ID/refresh deadline and arm renewal. Reconcile observed
   signature/challenge behavior and isolate route failures. Disable/unsubscribe
   using the same exact callback and arguments after the test. A passive callback without a prepared snapshot
   has no active outputs. Never prepare/enable that generation during passive tests.
3. **Parity rehearsal:** complete the private inventory/import and distributed
   capability parity above; test synthetic models/tools, restart at each
   commit boundary, bad-model selection, cancellation and uncertain sends. Review
   actual per-agent impact, with exact model/tool budgets retained.
4. **Explicit active cutover:** quiesce one legacy agent after approval; reconcile
   all in-flight commands/sends and freeze its final state. Review a new generation
   and future-only boundary, ensure exactly one active owner, then start its new
   MCP-only runtime. No dual active consumers. Native server-msgid receipts and
   webhook epoch/line IDs are NOT interchangeable. This implementation's timestamp
   fence alone is not proof of a lossless boundary: coordinate producer creation,
   old intake stop and a reviewed handoff window. Report any gap/overlap.
5. Expand only after verifying identity, history, model, tools, limits, renewal,
   alerts and rollback for the first agent. Do not stop old services just to
   remove the old source files. Remove the legacy runtime after the rollback
   window under a separate reviewed change.

## Rollback

Before active cutover, disable the new callback and explicitly unsubscribe the
exact test grant after approval; retain the private DO data for reconciliation.
The existing Railway runtime remains authoritative and needs no restart.

After a future active cutover, first fence/cancel new execution and stop its grant.
Drain or mark all in-flight side effects uncertain; do not blindly replay them on
the old runtime. Export/reconcile new conversations, settings, budgets and receipt
boundaries into a reviewed compatible snapshot. Resume the old identity only when
it is the sole active owner and the boundary is verified. Restoring an old volume
without reconciling new work loses history and can duplicate replies. Never roll
back by starting two IRC/MCP owners at once.

## Local validation

From repository root, with Node 24:

```sh
npm --prefix cloudflare ci --ignore-scripts
npm --prefix cloudflare run check
npm run bootstrap
npm --prefix cloudflare test
npm --prefix cloudflare run test:worker
WRANGLER_SEND_METRICS=false npm --prefix cloudflare run dry-run
npm run check
npm test
```

Tests use fixed synthetic signing material and fake model/tool responses. The
workerd integration starts only a local Worker, uses a temporary persisted store,
waits for actual DO alarms, verifies passive and active imports, model/tool calls,
three-part outbox drain, renewal and durable duplicate rejection after restart.
It also terminates workerd during an unresolved tool call and verifies that neither
the tool nor subsequent model/output work repeats. No Cloudflare account is required. Logs
contain aggregate state counts only. Keep `.dev.vars*` and `.wrangler/` out of git.
