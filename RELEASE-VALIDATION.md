# Release preparation evidence

Original root had no .git. Fourteen maintained src files matched the OLD pi/src/cuse overlay byte-for-byte before integration. Neither real pi nor computer-use was edited. Staging roots read/copied only.

Immutable archive SHA256 independently verified as af7d11986179445ce6fe88b37d57de22f823c0ffd3a65cae31c555b7f5e99253. Scratch git clone at cuse/.runtime/pi pinned d3e3b4ea7bd00e1e3784ac276a7c86fd1a5f1087; npm ci --ignore-scripts, check:model-data and build:offline all passed before overlay. Actual maintained overlay then built/typechecked via coding-agent tsgo build including src/**/*.ts (not excluded cuse). npm run check passed again.

Local Node22.23.3: npm test passes 6 existing primitive/model tests +29 portable regression tests =35 original tests,2 packaging/auth-byte-preservation tests,1 full ChannelSession test =38 total,0failed0skipped. Full session test uses real ModelRuntime+standard AuthStorage, intercepts EVERY fetch to synthetic Codex refresh, verifies actual builtin gpt-5.4, mode0600 refreshed persistence, reopened identity, independent second session, absent host/spawn/merge tools; sends no prompt or real model request. First fixture lacked run_js and failed, corrected. Later TSX picked inherited declaration paths after tsconfig update; corrected scripts to explicit upstream source tsconfig, full suite rerun passed.

Portable regressions preserve meaningful unsupported diskfork zeroeffects (bare/named/multi/existing/concurrent),504no replay,425only retry, stable names/caps/404no replacement, optional state validation, explicit provider/model failclosed. Current fork is NOT supported.

Docker/Nix/gh absent locally: no local image pass. Nondeploy Node24 Actions workflow checked in/private repository; first HEAD5c83b2026260cc1c013c1b0e587f08dfd27018f8 push and pull_request checks both showed FAILED after2s on PR UI. Exact runner error not obtained: subsequent browser requests timed out120s. Auth-free REST query returned404 (private repo) and was not worked around with credential reads. Latest HEAD must be independently checked; no CI/image success claimed.

PRIVATE repo https://github.com/r33drichards/cuse, DRAFT PR https://github.com/r33drichards/cuse/pull/1. No merge/deploy/model calls. PR initial title has cosmetic appended text from UI typing.

Official API and app origins both curl exit28 timeout15s HTTP000. Dedicated host Computer Use token and private admin Codex login remain missing/manual; supervisor confirmed deferred and operator private UI assistance. Existing Railway service was not modified or credentials inspected; refreshed UI discovery not completed due browser timeout. README includes intended identifiers, commands, host/guest separation,2channel/restart/unsupportedfork E2E,health,rollback,budget and resource cleanup. Review gate and actual backend diskfork contract remain required.
