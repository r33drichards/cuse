# Real Node24 host validation; NOT a container result

Tested source HEAD: 86374461a97b48404f4fd3f26ea43ac0e20ebc37.
37 tracked input files are SHA256 listed in node24-inputs.json. Deterministic tree digest: e6da227687d3b44760456ea958150d24240367e064131aeded59c6d81c2cfdf7. Upstream pinnedpi d3e3b4ea7bd00e1e3784ac276a7c86fd1a5f1087, lockfileSHA256 f8e6d279e4606c607b67026cb10f0e6ab12506c57a00d0bac71a841d0f20de34. Maintained runtime/test/build scripts were unchanged; followup changes are documentation, scratch exclusion and explicit CI Node24-major gate.

## Verified tooling

Downloaded npm node-linux-x64@24.14.0 with npm pack --ignore-scripts, in cuse/.tools only. Registry URL https://registry.npmjs.org/node-linux-x64/-/node-linux-x64-24.14.0.tgz.
- SHA512 integrity verified against registry metadata: sha512-BW+LjMox8A7Dh632x6aMw793/davUra1+JatUmW9abd62tlpzpTQGVL2ZqTRC2WNjnGyh91eWxZOpZOy4AK7KA==
- SHA1 metadata verified: ba411e7891e999d93e0f841c0ba6c393a85daad5
- ArchiveSHA256 ac20436abe5707b64394a3617ce3b2ac8cfe6d27a369304fc00745fbe3a2b1fa
- Original extracted node binarySHA256 e237a2839d0cbdc9a9a2adda1a184afc0f5b20306ffbe923af5686550472d8a8
- Scratch PT_INTERP-patched binarySHA256 42e0e5ed1c5f765a1ec6f13b77b2260adddcb647e3deaaa95f48c6ff22f62863

Package version assertion and archive byte integrity are verified; npm provenance signatures/attestations are NOT independently cryptographically verified. The binary's missing /lib64 interpreter was fixed ONLY in scratch by relocating ELF64 PT_INTERP to existing /nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/ld-linux-x86-64.so.2. Existing GCC libraries: /nix/store/604gsr59rj7dzd0nrhp143rpvf7gyiaz-gcc-15.3.0-lib/lib. No production image/tooling source was changed. Child process.execPath invocation also reports v24.14.0. Existing npm10.9.9 CLI was executed explicitly by this Node24, not its installed Node22 shebang. Scratch wrappers preserve necessary library selection even when the packaging test intentionally sanitizes child environment. No fixture/assertion weakened.

## Shared resource coordination

Python fcntl.flock on /data/chrome/home/.cuse-coordination/heavy-build.lock, approved by parent after /data/memory was confirmed nonexistent/unwritable in EXEC namespace. No privilege elevation or alternate unauthorized lock. Directory verified owneduid1000, not symlink, permissions0700 (inherited setgid present); lock0600 and no-follow. Wait bounded180s, lock held by command supervisor process throughout download/build/tests, released on process exit. No other roots/caches deleted or unrelated processes stopped. Only own initial misconfigured build run was cancelled; no persistent heavy background jobs remain.

## Commands/results

Under common lock and scratch wrappers, actual node --version=v24.14.0, npm10.9.9:
- npm run bootstrap: pinned upstream npm ci --ignore-scripts, immutable model hash check/model-data validation and build:offline BEFORE overlay: passed. Actual overlay then built/typechecked: passed.
- npm run check: actual overlay build/typecheck: passed.
- npm test: latest run passed38,0failed,0skipped (6+29=35 originals,2packaging,1full ChannelSession/standardOAuthrefresh/reopen/isolation).

Evidence: node24-build-and-first-test.txt includes passed builds plus FIRST packaging test failure because sanitized subprocess lacked host librarypath. This was a scratch tooling configuration issue, not an application defect. node24-tests.txt is final FULL suite after wrapper fix and completed:0. Full-session test does no real login/model prompt; all fetch intercepted. No fork support added.

Remote execution IDs: full actualNode24 build/check79201669-d34d-4e28-bea4-f27608ddeaa5; final full test8af579c1-3c19-4536-91de-2e885c7427cf; inputhashcaptureff37e83e-31bb-460c-9aaa-d80f16cfb859.

## Container/CI billing gate

Docker/Nix executables absent; actual Node24-bookworm container build NOT validated. Parent independently inspected Actions run37179062680/job111367722132: steps=[]; annotation states account payment failed or spending limit needs increase. It never started code/tests. This is a GitHub account billing infrastructure block, NOT a code-test failure. https://github.com/r33drichards/cuse/actions/runs/37179062680/job/111367722132

No manual CI rerun, billing/payment/limit change, visibility change, shared/selfhosted runner installation or workflow move attempted. Operator must resolve account billing/limit privately or explicitly approve a supported alternative; then required Node24 IMAGE workflow and independent review must pass before merge/deploy. Host pass does not replace container validation. New PR push may auto-trigger the existing nondeploy workflow, not a deliberate repeated rerun.

## Read-only origin/service evidence and manual auth gates

Official docs/api-tokens.md defines api.computeruse.site and app.computeruse.site; no guessed origin or fork endpoint. Both DNS names resolve8.231.155.139; bounded5s direct TCP443 probes both TimeoutError. Earlier unauth curl HTTPS15s also timeout28/HTTP000. DNS resolving does not establish TLS/auth readiness. Operator reports app loads and is signed in on their own machine: this is a REMOTE-path connectivity blocker, not a universal outage diagnosis. Operator/private-network verification only; no alternate origin or certificate bypass. No repeat probes after that report.

Railway authenticated read-only canvas confirmed irc/production, existing pi-irc Online and attached pi-irc-agent volume. No variable values/auth settings inspected and no services modified. Destination project37a71c12-bee2-43f7-8fad-3ebeaea66789 / envc7e27f4f-f5ef-43ca-9735-7949a42aa33a; existing piirc093b47b5-b69c-4565-935f-cce512b2b98d untouched. No cuse service/volume was provisioned.

Operator private actions, through parent: restore official edge reachability, privately sign into Computer Use app and create dedicated cuse token UNBOUND with sessions:read/write/connect ONLY, install through NEW cuse Railway service secret UI without sending it to agent/chat/IRC/guestdisk. After review and authorization provision NEW dedicated /data/agent volume and stable instanceID/one replica, select correct existing IRC/shared variable REFERENCES privately, do not copy legacy provider/API-key secrets or old piirc volume. Complete standard pi Codex /login via trusted PRIVATE ADMIN terminal sharing new host volume while public IRC process stopped, exit without prompt; presence and mode600 checks only. Tokens/callbacks/codes remain private. Live OAuth login/refresh and safe real-model E2E remain separately approved gates.

README contains onboarding command, two-independent-channel/restart/unsupportedfork E2E, external budget/initialcap2, sanitation/health, digest rollback and owned-resource cleanup plan. Current diskfork failsclosed, no freshdisk fallback/no invented endpoint. Need parent-delivered REVIEWED backend API contract before preparing adapter/tests; operation request/response/idempotency/reconciliation, source controlled-pause/lifecycle fencing, independent restored storage, quotas/cleanup and hostauth exclusion must be specified and backend cluster restore proven. No merge/deploy until these review/auth/image gates pass.
