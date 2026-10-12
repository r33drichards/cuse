# Scoped state/error corrections (local; publication held)

Base HEAD01acb94ee15df23aab06a4894e4579c6d7fb1893 was verified clean before edits. Parent publication HOLD received during final test; NO push/visibility action in this continuation. Local commit permitted; exact commit ID is returned in task report. Previous PR remote HEAD remains01acb94 pending parent history/disclosure audit and explicit release. No replacement writer/delegation.

## State commit

ChannelSessionStore.set creates a candidate map, executes synchronous secure mode0600 temp write, fsync+close, atomic rename, then publishes candidate memory. Failures before rename preserve original memory/file and cleanup temp; later and concurrently queued successful sets survive a failing update without phantom record/rollback loss. Narrow constructor write/rename test hooks only; normal API remains synchronous, one process/replica required. Strict loaded metadata and404/no-replacement regressions unchanged. This is file-flushed atomic rename, NOT a directory-fsync/power-loss or multi-process durability claim.

## Controlled error boundary

New owned PublicError codes map to constants; no arbitrary message/stack/cause/string/rawURL is used as public guidance. Stable owned type brand permits byte-identical maintained/staged copies in existing regression fixtures; dictionary own-key check prevents prototype names being treated as guidance. Unknown errors, raw thrown objects and mutated messages get generic text; known model/Codex reauth, joined-only, quota, join-limit and unsupported-fork guidance remains safe/useful. Bot command/prompt/model-list/reload/lifecycle/fork/join/send/extension/runtime/main catch paths and logs use controlled mapping. Failed assistant/tool SDK events withhold raw content. Synchronous JOIN transport throw now settles pending waiter instead of leaving a later orphan rejection.

Risk was source propagation of arbitrary errors; actual token leak was NOT proven. No custom OAuth, API-key fallback, upstream patch or guessed fork adapter. Standard AuthStorage/ModelRuntime remains pinned/unchanged. Normal trusted host resource/extensions are not a sandbox; model/guest/user successful content is still intentionally relayed, and trusted extension direct I/O/stdout is outside this controlled-catch boundary.

## Tests, commands and hashes

Actual existing verified Node24.14.0 with scratch npm/loader wrappers, common approved flock /data/chrome/home/.cuse-coordination/heavy-build.lock (owned uid1000 directoryaccess0700 plus allowed inheritedSGID, nofollowfile0600,bounded180s wait).

Final command execution6b77de2e-7480-46c9-b561-3da04733c53a completed:0: node --version24.14.0; python3 scripts/prepare.py; npm run check; npm test. Actual full overlay coding-agent typecheck/build passed; all63tests passed0failed0skipped (10+29+2+1+21), preserving original35 and synthetic standard AuthStorage refresh/reopen/channel-isolation. New4state rollback/concurrent tests and21boundary tests; existing full-session test now also drives real SDK fanout and registered extension error callback with synthetic secret canaries, no model prompt/network.

state-error-build.txt and state-error-tests.txt are final raw logs. state-error-inputs.json captures36 source/test/build inputs, all15 maintained/staged overlay files byte-identical, deterministic inputDigestf532c0ae9c5bf1efdbf200566590393aa00cea27668ee3c09060f23153e5d5c8. Hash capture execution4b1a217f-7d90-49de-a49d-fff9cf406582 completed:0. No source/test/build changes after capture; doc/result files excluded to avoid recursive evidence hashes.

Initial runs exposed normal correction issues: root/staged owned error class identity, JOIN throw orphan waiter, and a generated source-wiring regex escaping typo. Fixed without weakening fixtures; exact final tests passed. Earlier executions0cd17cf9 and b7d6c0ab failed; 2b02e41e passed63 before final actual extension callback assertion; 3d4a6e7f confirmed all63 with callback assertion; final6b77de2e confirms all63 after safe join-detail helper regression. No new policy/transport failure, alternate tool mode or retry loop occurred.

## Inherited auth and release gates

Pinned pi AuthStorage locked refresh writes are NOT crash-atomic. Protect PRIVATE encrypted host backups while bot stopped; old backup of a rotated refresh token may be invalid, so restore is not guaranteed and private admin reauthentication may be required. No crashproof OAuth claim or API-key billing fallback; host auth never copied to guest/snapshot.

Container unbuilt here (no Docker/Nix); GitHub private CI run37179062680/job111367722132 never started steps=[] due account payment/spending gate, NOT code-test failure. No billing/runner/visibility changes, manual CI reruns, provision/merge/deploy. User newly authorized public repo, but parent separately HOLDS all publication until history/credential/disclosure audit+explicit release. Dedicated cuse token/private admin Codex login, approved live E2E, full fresh source review and independently reviewed REAL backend fork contract remain pending. UnsupportedDesktopForkError preserved. Operator app works/signed-in on own machine; remote origin timeouts are distinct connectivity issue, not universal outage. No new network/auth probes or real credential/model calls in this continuation.
