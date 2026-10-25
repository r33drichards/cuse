# Staged migration to Pi Durable and WeeChat MCP events

Status: stage 1 implementation for review, **not a production cutover**. The new
`cloudflare/` entry point has no direct IRC client, native WeeChat subprocess,
resource listener, or fallback connection. Incoming traffic is exclusively signed
MCP Events webhooks. The prepared read/reply adapter uses authenticated MCP tools.
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
- A separately tested execution coordinator with persisted checkpoints, explicit
  pre-effect retry classification (three attempts maximum), deadlines, persistent
  cancellation and late-completion fencing. Interrupted arbitrary model/tool work
  blocks for reconciliation. It is not enabled by the Worker.
- Persistent outgoing intents: reserve before I/O, never retry an uncertain
  dispatch, preserve uncertain state through restart, and block later sends behind
  it. `dispatched` means local MCP acceptance, not delivery to IRC. IRC does not
  supply a verified idempotent send API; exactly-once delivery is not promised.
- The exact `events/subscribe` / `events/unsubscribe` protocol, finite TTL,
  bounded renewal controller, and fresh authenticated HTTP MCP connections with
  pinned protocol `2026-07-28`. Refresh reuses exact arguments/callback, omits the
  cursor for routine renewal, and stops on changed grant identity or truncation.
  Renewal is explicitly armed only for an already-approved grant. It is not
  auto-wired into Worker startup and no live grant has been created.
- Safe failure codes and aggregate state counts, without payloads, keys, headers,
  cursors or arbitrary exception strings in Worker logs.

The package is intentionally **passive-only**. There is no environment flag that
turns it into an active agent. Connecting model/tool execution requires the parity
work below and a reviewed code change. No model provider, secret, subscription,
Cloudflare account, paid resource, or network setting is created by the code/tests.

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
   state is not assumed schema-compatible with Pi Durable 1.2.0. Build/test the
   explicit importer against a sanitized export. Shadow conversations are not an
   import or a substitute for those histories. Keep originals intact.
3. Preserve the existing prompt framing, mention/control-channel rules, peer
   distrust and loop budgets. Upstream excludes its own nick, which may differ
   from the intended agent nick until identity mapping is complete.
4. Keep browser/computer sessions and arbitrary native filesystem/process tools in
   their existing authorized remote runtimes. Workers must not mount local auth
   files or spawn WeeChat, Python, shells or browsers. Reconnect the same desktop
   IDs rather than creating replacements. A durable shared-resource coordinator
   with fencing is required before two conversation objects can share a desktop;
   existing process-local locks cannot provide cross-object exclusion. This
   coordinator and active remote tool integration are not yet implemented.
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
   using the same exact callback and arguments after the test. Current build has
   no active outputs even if a passive callback is configured.
3. **Parity rehearsal:** complete the private inventory/import and distributed
   resource coordination above; test synthetic models/tools, restart at each
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
npm --prefix cloudflare test
npm --prefix cloudflare run test:worker
WRANGLER_SEND_METRICS=false npm --prefix cloudflare run dry-run
npm run bootstrap
npm run check
npm test
```

Tests use fixed synthetic signing material and fake model/tool responses. The
workerd integration starts only a local Worker, uses a temporary persisted store,
waits for the actual DO alarm to commit a Pi journal entry, restarts workerd and
verifies durable duplicate rejection. No Cloudflare account is required. Logs
contain aggregate state counts only. Keep `.dev.vars*` and `.wrangler/` out of git.
