# Durable IRC goals

The cuse-native adapter is implemented; it is enabled only with both
CUSE_DURABLE_IRC=true and CUSE_GOALS_ENABLED=true (goals default off).
It does **not** load the upstream interactive ExtensionAPI or auditor.

## Commands

- ,goal add :: objective — creates an inert, paused goal.
- ,goal add ordered :: objective — additionally enforces child-first task order.
- ,goal list / status [ID] — inspect the channel-owned task/evidence ledger.
- ,goal start ID [steps] [duration] — direct human approval for 1–200 continuation
  steps (default 4) and an optional run duration (default 30m). Durations are
  positive whole numbers with lowercase m/h/d units, from 1m through 3d (72h).
  For example, ,goal start ID 200 3d grants at most 200 steps over 72 hours;
  ,goal start ID 2h uses the default 4 steps. Equivalent durations such as
  4320m or 72h are accepted; 4d, 73h, 0m, fractions and unitless durations are
  rejected. A new grant replaces, never adds to, the prior remaining allowance.
  Status and continuation payloads show the stored absolute deadline.
- ,goal pause ID / cancel ID — revoke queued and future work immediately.
  A dispatched remote action cannot be undone; inspect any uncertain outcome.
- ,goal approve ID — accept an agent's completion proposal after human review.

Commands follow the existing IRC mention/control-channel rules. The IRC network
is the human-control trust boundary, as for existing model/desktop commands;
these commands do not authenticate an IRC nick as a cryptographic identity.

## Runtime boundary

Goals share the exclusive-owner delivery SQLite database. Allowance consumption,
step acceptance, progress receipts, inbox completion and continuation/outbox
commit are atomic. Each grant has a future-admission deadline measured from
the new human start: 30 minutes by default, optionally 1 minute to 3 days.
Checkpoints, provider/tool admissions, pause and restart do not extend it.
Existing v1 records retain their exact stored expiresAt; there is no migration,
automatic renewal or unattended restart. Longer durations do not enlarge the
finite step/request/tool allowance or authorize new work. Grants still permit
at most 8 provider requests and 32 tool invocations per step; provider requests have
a requested maxTokens=4096 limit, a separate 5-minute AbortSignal (shorter caller deadlines are preserved), no internal
retry/deferred execution and SSE transport (no WebSocket fallback). Token limits
are provider-dependent: the vendored Codex API does not honor maxTokens, so
4096 is NOT a guaranteed output cap there. Persisted request/tool counts and
future-action deadlines remain enforced. These are **not a dollar-spend guarantee**.
Tool limits count harness invocations, not the individual nested browser/shell
operations inside a run_js call; no dispatched effect can be undone.
Normal human/peer/schedule turns retain their existing runtime behavior.

New goal steps use the existing serial durable queue and the channel's existing
desktop only. Goals cannot implicitly create a desktop, start another goal,
grant themselves more allowance, send peer messages/questions, or mutate
schedules. Peer automation is excluded so goals cannot indirectly spawn model
work outside their persisted allowance; schedule listing remains read-only. No host filesystem/shell
tools or new model/provider fallback are enabled. Tools bind the actual persisted
operation and invocation identities, not a user-controlled prompt prefix.
Admission checks run again at actual model/tool boundaries, including recovery.

Pause/cancel invalidate pending goal messages and future tool/model admission.
Restart blocks active goals rather than resuming unattended. Running/uncertain
input is retained for the existing durable recovery adapter; remote dispatch
memos still prohibit repeating unknown actions. Inspect/reconcile any uncertain
outcome before another explicit start. Missing checkpoints, exhaustion, errors
and deadlines block progression. A goal has a bounded tree (50 tasks, depth 8,
8 evidence references per task); at most 32 saved goals per channel/256 globally.

The model may create a plan once, checkpoint task state/evidence, block, or submit
for review. Done requires passing non-peer evidence references; failed, blocked
and missing evidence cannot count as completion. References are **agent-reported
claims**, not automatic verification or certification. Submission stops all goal
work and requires an explicit human approve command. The v1 adapter does not
provide automatic independent auditing, interactive widgets, or plan rewrites.
A human can obtain a separate scoped peer review using the existing mailbox.
Peer/auditor/source content never grants new authority.

## Upstream source/provenance

The complete 555-file pi-goal-x v0.32.3 tree at commit
64c5ace87f3400c0b55ef87f2d2912167f53dbaa remains unchanged in vendor/pi-goal-x,
with its MIT license, per-file Git blobs and SHA-256 manifest. It ships at
/opt/cuse-vendor/pi-goal-x outside extension discovery. The native adapter is
maintained separately in src/goal-*.ts; it is pi-goal-x-like functionality, not
an assertion of compatibility with every upstream feature.

## Verification

Native SQLite tests cover channel/run identity, inert creation, finite budgets,
idempotent receipts, pause/cancel races, restart blocking, tree validation,
ordering, evidence rejection, approval and transactional rollback. Actual durable
AgentHarness/SQLite integration tests use a faux provider (not a live paid model)
to verify request-boundary caps, prepared-tool cancellation, progress submission
and normal-turn isolation. Existing regressions, Node24 runtime/catalog smoke
and Docker CI remain required before release.

### Pause/cancel and replay fences

Human pause/cancel records revocation and, if that goal owns the currently-running generation, its exact goal ID, generation and durable operation ID atomically with its receipt. Only a newly applied command may request that exact lane operation abort; replayed (including legacy) receipts acknowledge without aborting newer work. Pausing an inert or different goal never aborts the current goal. Remote and desktop-lifecycle tools recheck revocation after awaited dispatch memos, immediately before invoking the remote function. Once a provider request or remote function has already been invoked, pause cannot undo costs/effects or guarantee that the remote server has stopped; inspect any uncertain result before starting again. Dispatched/uncertain memos remain fail-closed, even when the final admission check prevents dispatch.

### Provider deadlines and recovery acknowledgement

A provider abort/timeout while durable lane control is still running is normalized to a failed request, not misrepresented as a lane cancellation. Real caller/lane cancellation remains aborted. No automatic model retry or allowance refund is added. Goal requests still have a maximum 5-minute deadline, independent of the optional 1m–3d run window (default 30m); 8 requests/32 tools per step are unchanged. A longer run never makes a single provider request last 3 days.

On restart/fault, a revoked goal lane is cancelled by its exact stored operation ID before settlement; no provider/tool action is replayed. Interrupted inbox/lane state is preserved until settlement. The goal retains recoveryRequired even after the lane settles. A direct human who has inspected uncertain outcomes uses `,goal recover ID inspected`; this only acknowledges inspection, never starts work, renews allowances, or marks tasks done. Then a separate human `,goal start ID [steps] [duration]` can grant new work. Receipt replay cannot acknowledge a later uncertainty. Until inspection, leave the goal blocked.

Service diagnostics emit fixed codes (e.g.provider-abort-control-mismatch, harness-fault) rather than arbitrary error messages/stack/cause, tool arguments or secrets. Native/faux proofs do not certify live provider/remote effects.
