# Effective channel image policy correction — not feature approval

Base06b214e7b705b4c4fe8ec85a7b468d36a0bba6e2, release/preparation, draft public PR1.

## F1 resolution and actual API inspection

Pinned SettingsManager.applyOverrides changes only effective settings; save/reload recombine global/project. setBlockImages changes GLOBAL and cannot override trusted project blockImages=true. SDK conversion dynamically queries public getBlockImages each turn. Therefore a session-local controlled SettingsManager Proxy overrides only that public query to false; all other methods bind to original manager, retaining storage/private receiver/trust behavior. No upstream patch, persistent global/project image rewrite, repeated setter or pin change. SDK receives this view at OPEN and retains it through actual RELOAD/save.

New project-images case uses actual file-backed SettingsManager with trusted .pi/settings.json blockImages=true over globalfalse, later bothtrue. It executes actual bot/adapter/SDK/session/model conversion/IRC success screenshot before and after real channel.reload, and supported model-settings save recombination. Underlying getter remains true; session getter remains false. Persisted image preferences stay false/true atopen, true/true after deliberate synthetic globalfixture change/reload. Synthetic stream observer verifies exact screenshot and ordinary stdout; EXTERNAL completed-conversion counts and final assistanttext=finished ensure assertions cannot be swallowed into SDK error events. Two explicitly requested prompts call remote twice, not replay; zero fetch requests. Existing remote-error/transport-error canaries and successful stdout/screenshot paths retained.

## P3 documentation

Existing README bad entrypoint testpath and stale unvalidated-container paragraphs replaced, not merely contradicted by an appendix. Settled06b214e public PUSH37221827152/PR37221830888 is distinguished from newer pending CI. PROVENANCE now describes actual Dockerfile WORKDIR/app extraction from /opt/pi-ai-0.85.1.tgz, separately from host/CI bootstrap .runtime/pi; Docker does not invoke bootstrap. Prior historical63/65/82 artifacts unchanged.

## Actual final validation

Final execa30b82fa-7e4b-4cd5-97c8-7b5c74f7b73c completed:0 under existing bounded strict shared heavy flock; actual verified Nodev24.14.0; prepare; full overlay build/typecheck; all83tests/0failed/0skipped across11maintained files (12+29+11+1+21+2+4+3). All82previous cases retained, including actual startup JOIN#cuse/nickcuse, explicitoverride, isolation, transactional cloned state, hosttools disabled, controlled errors, standardAuthStorage and max10. No live model/OAuth refresh/IRC/desktop/cloud call or realcredential read. Initial2c99aff5 completed:0; final revalidation follows stronger external observer guards, not any policy/auth/transport failure.

Final manifest binds44inputs/15byte-identical staged overlay files. Digest1ae6375d79804b0fe7f0a0cac54fcabbb870130059411bfa403f621aa12341e9. Evidence capturee6249e68 completed:0; diffchecke7fea362 completed:0. Pin remains d3e3b4ea7bd00e1e3784ac276a7c86fd1a5f1087; archive SHA256af7d11986179445ce6fe88b37d57de22f823c0ffd3a65cae31c555b7f5e99253. No moving public main selected/fetched and no dependency bump.

Preflight9f0a8058/eb1c98e9/d68c3c54/cc95c195 completed:0; clean expected root/head and gh account r33drichards without auth/config/token reads. Tests clean owned synthetic fixtures in finally; ignored .tools helpers/logs retained, no shared workers killed/unlinked. No new policy/auth/transport failure or ambiguous owned job state. No CI queue polling/blind reruns/rawjoblogs/terminalguard bypass.

Parent owns settled exact-new-HEAD public CI and fresh source approval. This correction does not grant acceptance or full fork support. UnsupportedDesktopForkError remains; independently reviewed backend fork/restore, private ADMIN credentials/token, live E2E and separately authorized release/deployment gates remain. Controlled view relies on pinned SDK public getBlockImages contract; trusted host extensions remain unsandboxed. Standard OAuth storage and existing state durability limitations are unchanged.
