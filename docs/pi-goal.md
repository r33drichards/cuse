# Pi Goal on the durable runtime

cuse ports Michaelliv/pi-goal v0.1.7 to its existing durable harness. The complete
upstream tree remains unchanged under `vendor/pi-goal`, with MIT license and
per-file provenance. The former custom goal/task tree, step/request/tool caps,
provider timeout wrapper, evidence ledger and approval workflow are removed.

## Use

Enable `CUSE_DURABLE_IRC=true` and `CUSE_GOALS_ENABLED=true` (both opt-in).
Use the normal IRC addressing rules, for example:

- `cuse ,goal --tokens 50k finish the migration and verify its tests`
- `cuse ,goal status`
- `cuse ,goal pause`
- `cuse ,goal resume`
- `cuse ,goal clear`
- `cuse ,goal topic off` / `cuse ,goal topic on`

An objective starts work immediately. Each channel has one goal; setting another
through IRC requires clearing the current incomplete goal first. The model has
`create_goal`, `get_goal`, and `update_goal` tools. The creation instructions
require an explicit user goal request, an evidence-checkable objective and clear
boundaries. `update_goal` accepts only completion, after the upstream completion
audit. There is no additional human-approval/task-tree engine.

A token budget is optional and uses upstream token accounting, including cached
tokens. It is a soft stopping threshold, not a spend limit or a request cap:
when reached, the current turn may finish and one wrap-up is queued. No default
8-request, 32-tool, 200-step or 72-hour goal limit is added.

## Short IRC references and mutable goal files

The bundled Pi Goal writer skill creates and updates a full goal definition in
the current channel desktop's MCPJS memory, such as
`/data/memory/goals/logging.md`. The file contains the objective, acceptance
criteria, constraints, boundaries, iteration policy, blocked condition and
progress. Its path stays stable when the user changes the goal.

After writing and reading the file back, the agent can provide a short command:

`cuse ,goal Follow /data/memory/goals/logging.md; reread every turn.`

This is a literal objective reference interpreted by the model, not a parser or
new file-based engine. The skill instructs the agent to use the existing channel
`run_js` filesystem API to read current contents every goal turn and before the
completion audit. Changes use the same skill and file, preserve requirements the
user has not changed, and cannot create new authority. File writes alone do not
start/resume/complete a goal. Existing content checks and readback reduce accidental
clobbering but are not atomic locking. Missing/conflicting files are blockers.

The effective runtime skill is locally customized; the full upstream snapshot
remains pristine with original and customized hashes in the provenance manifest.
The skill is directly included in enabled agents' context, so no host filesystem
access is added. All goal files stay on their existing isolated channel desktop.

## Durable integration

SQLite state replaces upstream module-global state. Stable tool invocation
receipts prevent replay from replacing a goal twice. A model mutation is fenced to
the goal present when that model turn was admitted, so an old response cannot
complete or replace a newer goal. Fault handling is similarly operation-scoped.
Stable turn IDs deduplicate
delivered usage events, including the response that marks a goal complete.
Accounting spans two databases: a hard crash after the harness records a response
but before its turn event reaches the goal ledger can undercount that interrupted
response. Elapsed wall time can include interruption time. The optional budget is
not crash-exact metering; restart pauses the goal before further work. The inbox
completion transaction accepts the next continuation atomically, so it cannot
lose or duplicate that continuation after a crash. User/peer/scheduled inputs
already waiting run before the next autonomous continuation.

The existing durable runner, per-channel session identities, schedules,
Host `desktop_control` and remote dispatch receipts are retained. Peer messages now use native WeeChat MCP; unfinished legacy mailbox work blocks migration.
The port does not enable host filesystem/shell tools or change provider selection.

### Explicit differences from upstream

- Startup pauses active goals and cancels pending goal continuation rows while
  retaining those rows. Interrupted operations retain their exact IDs and are
  aborted/settled before new goal work; no unattended restart or uncertain replay.
- A model/harness fault pauses continuation. Normal durable recovery rules still
  apply to an uncertain operation. A goal never renews itself after a fault. A faulted in-memory adapter is closed;
  saved state is retained. An explicit `,goal resume` can settle a channel whose
  interrupted rows are all revoked Pi Goal operations, by aborting their exact
  IDs before new work. It cannot bypass unrelated recovery-required messages.
- Pause cancels future continuation and informs later requests; it does not abort
  an already-dispatched tool/model request or undo remote effects. Clear removes
  the current goal, not the conversation or audit rows.
- IRC has no confirmation dialog. Clear explicitly before replacing an incomplete
  goal. Status appears in an owned channel-topic suffix; `,goal topic off` removes
  that suffix. Human topic text is preserved, topic length is bounded, and topic
  permission failures do not stop agent work. A topic must be observed from the
  server before the bot changes it. IRC has no conditional/atomic topic updates;
  concurrent human topic edits are subject to the protocol's last-writer behavior.
- Durable runs freeze their tool registry. All three goal tools remain visible;
  their handlers read current state, and `get_goal` requires an active goal.
- Goal state belongs to the IRC channel's durable delivery database, rather than
  classic Pi custom session entries. This is an explicit host port, not an
  assertion that classic ExtensionAPI extensions run on the durable harness.

## Deployment and old state

This branch does not migrate, delete or replay existing production state. Back up
the stopped service's complete persistent volume before any approved migration.
Keep the instance namespace, desktop mappings, durable session markers/databases,
IRC delivery database and auth storage unchanged. Never start two writers.

Unresolved rows from the removed goal engine, legacy goal inputs, or a durable
lane still configured with its old goal tools are rejected with an explicit
operator-inspection message. The port contains no old-engine fallback and never
reopens a durable session as classic. Do not remove marker files or delete goal
rows to bypass the check: an operator must first inspect any uncertain effects
and approve a separate state migration plan. Production deployment is blocked
until that plan is reviewed. Source cleanup alone does not authorize state loss.

Rollback is to the previous image with the retained secure volume backup, while
stopped. A backup restore or rollback must account for remote effects that may
already have happened; do not automatically replay queued work.

## Validation

Run `npm ci --ignore-scripts`, `npm run bootstrap`, `npm run check`, and `npm test`
on Node 24. Tests use temporary SQLite stores and synthetic providers; no live
IRC, provider credentials, desktop services or production state are needed.
The packaging suite verifies the exact vendor snapshot, unchanged pure helpers,
and unchanged completion/budget prompts. Upstream's 25 tests also run from the
vendored snapshot. The release-preparation workflow builds and smokes the Docker
image without publishing or deployment.
