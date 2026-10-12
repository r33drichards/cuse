# Durable IRC goals

The cuse-native adapter is implemented; it is enabled only with both
CUSE_DURABLE_IRC=true and CUSE_GOALS_ENABLED=true (goals default off).
It does **not** load the upstream interactive ExtensionAPI or auditor.

## Commands

- ,goal add :: objective — creates an inert, paused goal.
- ,goal add ordered :: objective — additionally enforces child-first task order.
- ,goal list / status [ID] — inspect the channel-owned task/evidence ledger.
- ,goal start ID [steps] — direct human approval for 1–20 continuation steps;
  default 4. A new grant replaces, never adds to, the prior remaining allowance.
- ,goal pause ID / cancel ID — revoke queued and future work immediately.
  A dispatched remote action cannot be undone; inspect any uncertain outcome.
- ,goal approve ID — accept an agent's completion proposal after human review.

Commands follow the existing IRC mention/control-channel rules. The IRC network
is the human-control trust boundary, as for existing model/desktop commands;
these commands do not authenticate an IRC nick as a cryptographic identity.

## Runtime boundary

Goals share the exclusive-owner delivery SQLite database. Allowance consumption,
step acceptance, progress receipts, inbox completion and continuation/outbox
commit are atomic. Each grant expires after 30 minutes and permits at most
8 provider requests and 32 tool invocations per step; provider requests have
a requested maxTokens=4096 limit, a separate 60-second AbortSignal, no internal
retry/deferred execution and SSE transport (no WebSocket fallback). Token limits
are provider-dependent: the vendored Codex API does not honor maxTokens, so
4096 is NOT a guaranteed output cap there. Persisted request/tool counts and
future-action deadlines remain enforced. These are **not a dollar-spend guarantee**.
Tool limits count harness invocations, not the individual nested browser/shell
operations inside a run_js call; no dispatched effect can be undone.
Normal human/peer/schedule turns retain their existing runtime behavior.

New goal steps use the existing serial durable queue and the channel's existing
desktop only. Goals cannot implicitly create a desktop, start another goal,
grant themselves more allowance, or create schedules. No host filesystem/shell
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
