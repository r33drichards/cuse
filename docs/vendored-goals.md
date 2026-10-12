# Vendored goals: integration boundary

Status: source vendored and verified; runtime integration NOT implemented.

## Upstream snapshot

pi-goal-x v0.32.3, commit 64c5ace87f3400c0b55ef87f2d2912167f53dbaa.
The complete 555-file source tree, tests, documentation and MIT license live in
vendor/pi-goal-x. The immutable import manifest records every Git blob and
SHA-256. Adaptations belong outside this directory. No build-time source fetch.

## Why not auto-load the extension?

The active DurableChannelSession explicitly rejects extensions. Upstream uses
ExtensionAPI, interactive confirmation/widgets and a separate auditor session.
Loading it wholesale would bypass the durable command/scheduling integration
and requires auditing its host-file access and auditor tool selection. Vendoring
alone must not alter startup, enable host tools, spend model tokens or resume work.

## Proposed cuse-native integration

- Add goal commands beside existing schedule/session commands; retain the same
  channel, session and desktop ownership boundary.
- Persist goals, task trees, completion requirements and evidence references in
  the existing durable store, with schema validation and atomic transitions.
- Regular goals adapt their task plan; ordered goals advance strictly in order.
- Human confirmation starts execution. Resume specifies a finite run allowance;
  automatic continuation uses the durable delivery queue, never private timers
  or direct extension sendMessage calls. Pause/cancel invalidate queued work.
- Persist allowance consumption before dispatch. On restart, unknown remote
  outcomes require inspection; neither goal retries nor audits can replay them.
- Errors, exhausted allowance, missing decisions and failed desktops block the
  goal. Evidence marked missing/blocked cannot count as completion.
- Source, peer replies and auditor feedback are data, not new human permission.
  Starting a goal does not grant deployment, credential disclosure or new-channel
  authority. No additional host tools or automatic desktop provisioning.
- Optional reviewer examines scoped evidence independently; no unrestricted
  host read/bash tools, shared mutable completion state, automatic model/provider
  fallback or inherited write-capable desktop tools. Final approval remains an
  explicit recorded result, not an agent's unsupported success claim.

## Acceptance before enabling

Test per-channel isolation, confirmation, task ordering, finite budgets, pause
and cancel races, restart/unknown-outcome recovery, atomic progress updates,
audit rejection, untrusted feedback, packaging and offline source availability.
Run existing cuse regressions and exact-HEAD container checks. No live deployment
or model invocation is required to validate the source import.
