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

The staged parity adapters now include replay-safe comma-command handlers,
durable schedules sharing the subscription/inbox alarm, and the maintained goal
ledger (including token accounting and cancellation). Ordinary object eviction
keeps goals active; explicit stop/failure pauses them. Host goal/schedule tools
retain the human-origin creation boundary. Desktop lifecycle commands use shared
ownership and durable intent receipts, including uncertainty after interruption.

Model adapters include OpenAI, Anthropic, OpenRouter and OpenAI Codex, plus reviewed
custom models using the supported completions/responses/Anthropic APIs. A shared
credential-authority object encrypts OAuth credentials at rest and serializes
refresh; interrupted rotating refreshes require reconciliation. Only explicit
internal seeding is supported; no login, grant creation or credential copying runs
at startup. This has been tested with synthetic credentials, not live accounts.

Remote desktop skills use the existing verified MCP skill reader. Broader IRC
catalog tools require a reviewed exclusive profile; fixed-buffer read/reply guards
remain in place. Join/part address existing routes or an exact, hash-approved channel plan.
A plan must explicitly cover each new subscription and any desktop creation;
no plan or signing key is generated by a command. External IRC identities must
already exist, and no nick-switching/profile-creation API is invented.

The continuation adds durable goal-topic presentation, a reviewed dynamic-channel
provisioning state machine, the legacy desktop client's stable naming/quota/profile
rules under a namespace-wide durable lock, and `models.json` definitions/overrides,
headers, sampling parameters, nested compatibility settings and tiered costs.
Radius refresh-only OAuth is supported alongside the existing providers. CLI login
and executable credential helpers remain external: command-valued configuration
must map explicitly to a secret maintained by that external runtime. Unsupported
API implementations fail closed rather than substituting models.

Workerd coverage exercises shared encrypted OAuth refresh across restart, verified
MCP skill loading and tamper rejection, and signed-event routing to a dynamically
prepared channel. Unit tests cover uncertain provisioning, goal-topic sends,
legacy desktop policy rejection before mutation and custom catalog compatibility.

Live parity still requires the exact private provider/model/catalog, tool schemas,
permissions, budgets, desktop bindings and external identity mappings. This is an
implementation ready for configuration rehearsal, not proof that an uninspected
live configuration is compatible. The exporter deliberately retains blockers for
active old schedules/goals and unsupported context projectors; fresh-start approval
does not imply they were imported. Archived cost state is not an active cost cap.

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

Private read-only inventory was obtained separately through the authorized
operator browser. Live inventory and credentials are not included here. Actual
conversation history can reside in SQLite while JSONL contains only headers;
a history-preserving export must be transaction-consistent and WAL-aware.

History import is optional for the approved fresh-start path. Keep the original
Railway volume intact for rollback even when history is intentionally skipped.
This does not waive model, identity, tools, command, schedule or goal parity.

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
2. Preserve the original volume. If retaining history, make a consistent private backup/export with hashes/counts. Never include
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
3. **Parity rehearsal:** complete the private configuration inventory and optional history import, and distributed
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

## Pending deployment actions (no action performed)

Each action needs its exact target reviewed before execution:

1. Confirm Cloudflare account access, then approve the Worker and SQLite namespaces
   for sessions, shared desktop coordination, model credential authority and the channel registry.
2. Review per-agent route, immutable generation, fresh snapshot hash, model/tool
   configuration and external MCP identity. Provisioning distinct external IRC
   connections requires its own approval; shared nick switching is prohibited.
3. Approve secret bindings: existing MCP/desktop access, model keys or explicit
   OAuth transfer to a single refresh owner, encryption key and per-route signing
   keys. Do not place values in the PR or deployment logs. Coordinate the old OAuth
   owner before transfer; two refresh owners may invalidate each other's tokens.
4. Approve each actual `events/subscribe` call with callback, stable principal,
   exact arguments, signing key and TTL. Verify the signed challenge, retain the
   returned grant, then explicitly arm renewal. A local fixture is not this check.
5. After parity verification, review one-agent cutover: quiesce the old owner,
   reconcile uncertain effects, fix the generation boundary, enable the new
   snapshot and verify its actual nick, replies, model, tools and renewal.
   Preserve the Railway volume and use the rollback procedure above.

Browser sign-in alone authorizes none of these actions. No production stop,
restart, resource creation, credential installation or subscription is part of
local validation.

## Dynamic channels and topic presentation

`CHANNEL_PLANS` is an explicitly approved secret binding, not a wildcard policy.
Each plan pins the controlling session key, a pre-existing bootstrap buffer and
identity, target route/generation/fence, callback/signing key, subscription arguments
and TTL, fresh snapshot, optional desktop policy and `approvedHash`. The hash is
computed by `channelPlanHash` excluding only the approval field. Changing any
plan input requires a new review. Neither this PR nor tests install live plans.

The registry reserves the challenge route before subscribing, but rejects events
until preparation is complete. JOIN, desktop creation and subscribe each persist
an intent before external I/O. An interrupted intent is held for reconciliation;
only idempotent local installation resumes. A returned grant ID replaces the
placeholder before computing the final snapshot hash. All dynamic identities are
checked against both static and reserved routes. No two agents share a profile.

JOIN verification reads actual native buffer status lines and requires recent
self-JOIN evidence. Local dispatch or buffer existence is insufficient. Missing
or evicted evidence leaves provisioning pending; it never repeats JOIN to invent
confirmation. Subscription creation remains separate from joining.

Topic updates read the actual buffer title and preserve its human-owned portion.
They use the discovered native command revision, with the documented
[`/topic <channel> -delete`](https://weechat.org/files/doc/stable/weechat_user.en.html#command_irc_topic)
form to clear an empty owned title. Reads are repeated before mutation; uncertainty
blocks another topic send but never faults a goal. The upstream API has no atomic
topic compare-and-set, so this narrows but cannot eliminate a simultaneous human
edit race. No long-lived polling connection was introduced.

## Saved mailbox and task-tree tool compatibility

Saved `irc_send`, `agent_list`, `agent_ask`, `goal_status` and `goal_update`
selections have explicit host adapters and fixed legacy argument schemas. These
names alone grant no permissions. A reviewed snapshot must set
`compatibility.legacyGoals` for the task-tree engine and `compatibility.peers`
for peer messaging. The latter is an exact list of `{channel,nick,buffer}` where
`buffer` belongs to the **sending** external profile in that peer's channel.
Every nick must also be in `policy.peerNicks`; every peer must have a unique,
configured home route. Empty peer lists permit no outgoing peer messages.
Neither code nor configuration joins a profile to another channel implicitly.

The old goal tools are not aliases for Pi Goal. Their separate ledger retains
ordered tasks, evidence requirements, human review/approval, explicit bounded
start, per-step request/tool allowances, deadlines and recovery holds. Model
requests retain the legacy 4096-output-token cap with no retries. Imported old
work is not automatically resumed. Old task/allowance state must be inspected
and migrated privately, or its reset explicitly approved; permission to discard
chat history does not authorize discarding goals or schedules. With this mode,
`,goal` uses the legacy add/start/status/list/pause/cancel/approve/recover grammar.
It cannot silently reinterpret old tasks as a token-budget Pi Goal.

Peer mailbox requests use an application framing protocol (`cuse-peer-v1`), **not
an invented MCP API**. All network output uses existing authenticated WeeChat
MCP message commands. All incoming fragments use the signed `message.created`
webhook route. Fragments are bounded, hashed, assembled durably out of order,
and correlated against approved sender nick/channel and stored requests.
Peer responses remain untrusted data. The receiver automatically sends the
answer back through its own approved external profile. Both directions require
explicit existing channel membership and separate agent identities; deployments
with only one shared external nick cannot enable this adapter.

`agent_list` checks source-profile buffer membership and reads the configured
peer session's busy state; it does not expose desktop credentials. `agent_ask`
returns queued immediately, enforces a four-agent ancestry bound, and receives
answers in later webhook turns. Answer turns cannot delegate further; this is a
conservative restriction on the old mailbox. `irc_send` requires a human turn,
uses only configured channels, and cannot forge reserved peer frames. Goal and
scheduled turns cannot delegate. These restrictions must be reviewed with the
permission mapping, rather than hidden behind compatibility claims.

Each outgoing fragment has a durable intent and receipt. A crash or ambiguous
MCP dispatch holds the effect for reconciliation; it never blindly resends.
Confirmed fragments deduplicate across reopen. IRC nick checks rely on the
reviewed external server/profile ownership; webhook signatures authenticate the
bridge, not an independent end-to-end cryptographic peer identity. Framing adds
visible protocol lines to IRC, which is a migration impact to review before
activation. Existing unframed mailbox work is not automatically replayed.

A reviewed snapshot may carry `retainedState.delivery.goals` and `.schedules`
from the private exporter. Control import is transactional and keyed by snapshot
hash. It retains schedule timing, pause/missed-run policy and prompt, and legacy
goal tasks/evidence/remaining allowances. Nonterminal legacy goals are held for
human outcome reconciliation; old goal-run inputs are never imported as runnable
work. A missing control-state export remains an inventory gap, not proof that
there are no schedules or goals. Do not enable a fresh empty ledger as a silent
replacement for known live control state.
