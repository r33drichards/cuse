# Agent identities and channel sessions

Status: **desired design with the core per-agent/per-room session boundary implemented; remaining gaps are explicit below**.

This document records the intended Cuse model and compares it with `main` at
[`680e79d6`](https://github.com/r33drichards/cuse/commit/680e79d6f04dafefc2aba39aacf9dc83bf6ec826),
inspected on 2026-10-17. It is a Cuse design decision, not a claim of exact
OpenClaw compatibility. The [WeeChat transport document](weechat-transport.md)
describes the native transport and its stable home-backed identities.

## The model

**Nickname = agent. Channel = shared conversation. Session = (agent, channel).**

An agent participating in two channels has two persistent conversation contexts
and two serialized execution queues. Two agents in one channel see a shared
conversation but retain separate contexts and queues.

| Participation | Context and execution |
| --- | --- |
| `dip` in `#wchat` | Session `(dip, #wchat)` |
| `dip` in `#research` | A different session `(dip, #research)` |
| `gar` in `#wchat` | Another session `(gar, #wchat)`, independent of dip |

Seeing the same room does not mean sharing hidden model context. Sharing one
agent's persona or workspace does not mean merging that agent's conversations.

### Separate concepts

- **AgentId**: stable identity whose visible IRC address is a nickname. Store
  nickname bindings separately so reconnects, collision fallback, or an approved
  rename do not silently fork or merge identity.
- **ChannelId**: the actual conversation, namespaced by IRC network and canonical
  channel name. A home channel may remain an administrative/default room, but
  must not stand in for every room an agent joins.
- **SessionKey**: the pair `(AgentId, ChannelId)`. Use it for context lookup,
  admission, execution serialization, recovery, and session-owned schedules/goals.
- **ReplyAddress**: explicit transport identity and destination for an output.
  It is routing metadata, not a substitute for the session key.
- **Agent resources**: persona/configuration and, optionally, workspace/desktop
  resources shared by that agent's sessions. Session-local state stays separate.

### Required invariants

1. Persist and reopen context by SessionKey. A message to dip in one room must
   not implicitly inherit dip's private context from another room.
2. Serialize accepted turns within one SessionKey. Different keys are independently
   schedulable; a busy dip in one room must not itself block dip in another room.
   Shared desktop/file resources may need separate resource locks.
3. Preserve room history for participating agents independently of the policy
   that wakes them. A mention can trigger a turn without being the only message
   the agent can observe. Specify ordering, bounded history, restart catch-up and
   history-gap handling; do not imply every message must trigger every agent.
4. Send results through the correct agent identity to the explicit source/destination.
   Cross-session or cross-agent communication must be intentional and routed.
   A shared workspace is not an implicit message bus or permission transfer.
5. Keep accepted, started, completed and delivered distinguishable. Acceptance
   means durable admission, not execution; completion does not prove delivery.
   Delivery must state its evidence level, and cannot mean a person read it.
6. Preserve receipt deduplication and safe recovery. Do not replay uncertain
   side effects or turn peer messages into human authorization.

## Implementation in this change

The core isolation gap from the baseline audit is addressed:

- A stable agent identifier remains its original home-channel key, preserving
  existing WeeChat profiles, nicknames and desktop bindings. Nicknames are the
  visible agent address; display-name changes do not rekey its history.
- The home session retains its old key. Other rooms use an internal versioned
  pair key, `session:v1:#agent-home:#actual-room`. Only decoded agent/channel
  addresses reach WeeChat; these internal keys are never IRC channel names.
- Session transcripts, opening maps, durable FIFO lanes, peer budgets, schedules
  and goal ledgers are pair-local. Two sessions may execute model turns independently.
- State format 2 stores shared-room session bindings under their owning agent.
  Version 1 is read without copying or moving its home transcript. The first
  successful state write upgrades the file atomically. Older runtimes reject
  version 2 rather than silently discarding shared-session bindings.
- Existing accepted home-lane work and receipts retain their original IDs and
  ownership, including previously accepted shared-room prompts and reply targets.
  New shared-room work gets a fresh isolated session. Mixed legacy home history
  remains home history; it is not copied into other rooms or automatically split.
- Restart resumes all persisted lanes of a connected agent. Replies decode to
  that agent's existing native identity and the original room. Parallel completed
  turns explicitly re-kick output draining so one result cannot be stranded by
  an overlapping drain finishing.
- Workspace and desktop remain agent-shared. One desktop MCP client serializes
  individual desktop calls, while session queues remain independent. Desktop
  pause/start/delete/recreate and snapshot checks cover all owned lanes.
- Model-originated schedules/goals inherit the caller's pair. Shared-room goal
  topic mirroring is disabled because several agents must not overwrite the same
  room topic. Home-room command behavior remains unchanged.

### Deliberate remaining limits

This is not full implementation of every desired invariant. Shared intake still
uses mentions; native WeeChat history tools provide explicit access to other room
messages, but automatic shared-history observation independent of wakeups is not
added. Home channels remain the backing agent IDs; a standalone agent registry,
network-migration policy and rename administration are future work. A configured
runtime/state directory still belongs to one IRC network; do not reuse it for a
new endpoint without an explicit migration.

Shared resource serialization covers individual desktop calls, not entire browser
or file workflows. Multi-call workflows can interleave and require explicit
coordination. Shared files can intentionally expose information across an agent's
sessions: transcript isolation is not a filesystem security sandbox. Shared global
provider configuration is retained, not converted to distinct per-agent personas.

Host control commands remain home-channel only; shared-room text never acquires
host-command authority. Session tools scope schedules/goals to the current pair,
but dedicated shared-session administration and richer user-visible lifecycle
status are future work. Existing inbox/outbox states retain accepted/started/
completed/sent distinctions and uncertain delivery; “sent” is transport dispatch
success, not proof of recipient reading or execution. Native explicit communication
remains the cross-session mechanism, without an in-process mailbox.

### Rollout and rollback

Back up the state directory before deploying. Do not deploy a prior runtime on a
format-2 volume or attempt to downgrade the version field: that would lose the
new bindings. A rollback requires an operator-reviewed state backup and careful
handling of messages/actions accepted since that backup. This PR neither deploys
nor changes a live volume. Existing home work is not reset or replayed to create
new sessions.

### Verification

Regression coverage in `test/agent-channel-sessions.test.ts` checks independent
room FIFO/context, two agents in one room, shared identity/desktop ownership,
restart transcript selection, replay deduplication, pending-pair startup, scoped
schedules, agent-wide lifecycle gates and preserved version-1 pending work.
`test/session-key-state.test.ts` covers key validation, version-1 preservation,
format-2 persistence and state boundaries. Existing transport tests intentionally
continue to assert home *transport identity*; bot routing now converts that
identity plus actual source room into a session pair.

## Baseline audit: before this implementation

**At the audited base revision, partially aligned: the durability and transport building blocks are substantial,
but the central session boundary is still wrong for this model.** At that revision a home
channel bundles an agent identity, desktop, workspace, persistent context and
execution queue. Shared rooms are additional entry/reply routes into that bundle.

The decisive case is one agent in two shared rooms: both rooms entered
the same home session and queue. Changing only where replies are sent does not
provide conversation isolation.

The following is static source/test inspection at the pinned revision. Existing
tests describe intended current behavior; they are not evidence that this target
design has been implemented, and were not executed for this documentation audit.

| Area | Current behavior and evidence | Fit to target |
| --- | --- | --- |
| Agent identity | Nickname candidates and profile directory derive from home channel; transport identities are indexed by home. [weechat.ts:133–148](https://github.com/r33drichards/cuse/blob/680e79d6f04dafefc2aba39aacf9dc83bf6ec826/src/weechat.ts#L133-L148), [387–420](https://github.com/r33drichards/cuse/blob/680e79d6f04dafefc2aba39aacf9dc83bf6ec826/src/weechat.ts#L387-L420) | Partial: real independent IRC identities, but no independent AgentId layer. |
| Persistent context | Session/opening maps and remembered session file lookup use lowercased home channel. Durable runtime reopens its stored session ID. [bot.ts:361–394](https://github.com/r33drichards/cuse/blob/680e79d6f04dafefc2aba39aacf9dc83bf6ec826/src/bot.ts#L361-L394), [state.ts:19–67](https://github.com/r33drichards/cuse/blob/680e79d6f04dafefc2aba39aacf9dc83bf6ec826/src/state.ts#L19-L67), [durable-session.ts:217–265](https://github.com/r33drichards/cuse/blob/680e79d6f04dafefc2aba39aacf9dc83bf6ec826/src/durable-session.ts#L217-L265) | Persistence exists; lookup is not the agent/actual-room pair. |
| Same agent, multiple rooms | Shared intake emits `target = home`, `source = actual room`; bot enqueues under home and records `replyTarget`. [weechat.ts:552–578](https://github.com/r33drichards/cuse/blob/680e79d6f04dafefc2aba39aacf9dc83bf6ec826/src/weechat.ts#L552-L578), [bot.ts:411–423](https://github.com/r33drichards/cuse/blob/680e79d6f04dafefc2aba39aacf9dc83bf6ec826/src/bot.ts#L411-L423) | Missing: rooms share the home context and queue. |
| Multiple agents, one room | Each home identity gets a distinct receipt ID and home target for the same shared message. [weechat-transport.test.ts:843–862](https://github.com/r33drichards/cuse/blob/680e79d6f04dafefc2aba39aacf9dc83bf6ec826/test/weechat-transport.test.ts#L843-L862) | Substantially aligned for agents represented by different homes; their contexts/queues remain separate. |
| Shared conversation visibility | Automatic shared intake requires an exact nickname mention; ordinary traffic/self echoes do not enter that prompt path. Native tools can read room history. [weechat.ts:552–578](https://github.com/r33drichards/cuse/blob/680e79d6f04dafefc2aba39aacf9dc83bf6ec826/src/weechat.ts#L552-L578), [639–654](https://github.com/r33drichards/cuse/blob/680e79d6f04dafefc2aba39aacf9dc83bf6ec826/src/weechat.ts#L639-L654) | Partial: room access exists; automatic room-context observation independent of wakeups is not established. |
| Execution queue | Durable workers and active sessions are keyed by `message.channel`, currently home; each lane claims work serially. [durable-delivery.ts:22–30](https://github.com/r33drichards/cuse/blob/680e79d6f04dafefc2aba39aacf9dc83bf6ec826/src/durable-delivery.ts#L22-L30), [130–200](https://github.com/r33drichards/cuse/blob/680e79d6f04dafefc2aba39aacf9dc83bf6ec826/src/durable-delivery.ts#L130-L200) | Serial durable queues exist, with the wrong key for multi-room agents. |
| Workspace and configuration | Workspace path derives from home; dependency construction passes the same configured `agentDir` to sessions while giving them home-local cwd/desktop. [bot.ts:83–90](https://github.com/r33drichards/cuse/blob/680e79d6f04dafefc2aba39aacf9dc83bf6ec826/src/bot.ts#L83-L90), [210–231](https://github.com/r33drichards/cuse/blob/680e79d6f04dafefc2aba39aacf9dc83bf6ec826/src/bot.ts#L210-L231), [run.ts:117–129](https://github.com/r33drichards/cuse/blob/680e79d6f04dafefc2aba39aacf9dc83bf6ec826/src/run.ts#L117-L129) | Mixed scopes, not an explicit agent-resources/session-state model. A common config directory does not establish per-agent personas. |
| Reply routing | Source-room destination persists through inbox/outbox and reopen; transport uses the owner's identity and explicit target buffer. [durable-delivery.test.ts:328–360](https://github.com/r33drichards/cuse/blob/680e79d6f04dafefc2aba39aacf9dc83bf6ec826/test/durable-delivery.test.ts#L328-L360), [weechat.ts:657–697](https://github.com/r33drichards/cuse/blob/680e79d6f04dafefc2aba39aacf9dc83bf6ec826/src/weechat.ts#L657-L697) | Good foundation: destination is already separate from owner, although owner is home-keyed. |
| Cross-agent/session communication | Native WeeChat tools explicitly send/read messages; the old in-process peer mailbox is removed and unresolved legacy mailbox work blocks startup. [weechat.ts:639–654](https://github.com/r33drichards/cuse/blob/680e79d6f04dafefc2aba39aacf9dc83bf6ec826/src/weechat.ts#L639-L654), [agent-messaging.test.ts:39–98](https://github.com/r33drichards/cuse/blob/680e79d6f04dafefc2aba39aacf9dc83bf6ec826/test/agent-messaging.test.ts#L39-L98) | Explicit transport is aligned; there is no general pair-addressed session routing abstraction. |
| Operation lifecycle | Inbox states distinguish pending/running/completed/recovery-required; outbox distinguishes pending/sending/sent and records uncertain delivery. Completion and output creation commit together. [durable-store.ts:159–191](https://github.com/r33drichards/cuse/blob/680e79d6f04dafefc2aba39aacf9dc83bf6ec826/src/durable-store.ts#L159-L191), [329–430](https://github.com/r33drichards/cuse/blob/680e79d6f04dafefc2aba39aacf9dc83bf6ec826/src/durable-store.ts#L329-L430) | Strong foundation. Surface these as separate statuses, preserve uncertainty, and rekey them consistently. Transport success is not recipient execution or read acknowledgement. |

The active native startup requires durable mode
([run.ts:135–139](https://github.com/r33drichards/cuse/blob/680e79d6f04dafefc2aba39aacf9dc83bf6ec826/src/run.ts#L135-L139)).
The retained classic `ChannelSession` steers mid-turn prompts
([channel-session.ts:254–283](https://github.com/r33drichards/cuse/blob/680e79d6f04dafefc2aba39aacf9dc83bf6ec826/src/channel-session.ts#L254-L283));
that should not be confused with the native runtime's durable serial inbox.

## Original implementation priorities (baseline)

### P0: Make identity and session ownership explicit

Introduce distinct AgentId, ChannelId, SessionKey and ReplyAddress types. Separate
agent transport membership from session creation. Resolve a shared-room message
to `(receiving agent, actual source room)` before durable admission.

Carry the pair through session/opening maps, session-file mappings, inbox/outbox
ownership, execution workers, admission receipts, recovery and session-scoped
commands. Include the receiving agent in deduplication so one shared IRC message
can legitimately be observed by two agents. Do not use mutable display nicknames
alone as database identity.

### P0: Design a safe state migration

Version the schema and explicitly map each legacy home bundle to an agent and
its home-room session. Retain session files, durable operation IDs, receipt history,
pending outputs and uncertain-operation states. Existing shared-room turns may
already be mixed into home transcripts: do not pretend they can be automatically
split into faithful isolated histories. Choose an operator-reviewed policy for
legacy mixed context and pending shared work before enabling new room sessions.

Migrate schedules, goal ledgers, peer budgets, desktop lifecycle and reply routing
under documented ownership rules. Unresolved work must block ambiguous migration,
not be silently re-keyed or replayed.

### P1: Separate observation, wake policy and resource ownership

Specify how each room's shared history becomes available to every participating
session, while mention/admission policy controls which session runs. Add bounded
history/cursors and explicit gap/restart behavior without copying private context.

Move persona and intentionally shared files to agent scope; keep conversation
history, schedules and extension/session state at session scope. Decide whether
desktops are agent-owned or session-owned. If shared, serialize conflicting desktop
operations with a resource lock without collapsing all session queues into one.

### P1: Expose routing and lifecycle clearly

Provide inspectable operation/session IDs and separate accepted, started,
completed, delivery-pending, delivered and uncertain/recovery-required outcomes.
Keep native IRC communication explicit and retain peer-loop limits. A future
cross-session tool must name the destination pair and preserve origin and
authorization boundaries; it must not silently share another session's context.

## Acceptance tests for the target

1. **One agent, two rooms:** distinct persistent session IDs and histories;
   blocked work in one room does not block independent execution in the other.
   Reopen both after restart and verify isolation.
2. **Two agents, one room:** both can observe the same shared message, with
   separate receipts, context, queues and nicknames on reply. One busy agent
   does not block the other.
3. **Observation versus wakeup:** unaddressed room history can be observed under
   the chosen policy without generating unwanted turns; an addressed turn sees
   the intended room context and no other room's private context.
4. **Routing/recovery:** queued and completed-but-unsent work survives restart;
   replies keep the correct agent and source room. Duplicate intake does not
   repeat execution; uncertain sends retain their uncertainty.
5. **Lifecycle:** demonstrate accepted-before-start, completed-before-delivery,
   failed delivery/retry and uncertain execution without conflating the states.
6. **Resources:** an agent's intentionally shared persona/files are available
   across its sessions, session state remains isolated, and concurrent desktop
   use follows the chosen resource-lock policy.
7. **Migration:** preserve old receipts and terminal history, explicitly handle
   mixed home histories, refuse ambiguous unresolved work and preserve pending
   reply destinations. No unreviewed side-effect replay.
8. **Explicit communication:** cross-agent or cross-session messages reach only
   their addressed destinations and never grant new authority or silently merge
   private context.

When evolving the transport contract, distinguish tests that assert home transport
ownership from actual session ownership, especially
`shared mentions retain home ownership and independent native positions` and
`shared reply destination persists independently of home session and deduplicates`.
Retain their deduplication and destination-persistence guarantees; exercise pair
ownership at the bot boundary.

The baseline evidence is pinned to the pre-change commit so it remains useful after
implementation. This change includes runtime code and tests, but no deployment or
live-data mutation. The state migration occurs only when the new runtime is run.

