# cuse deployment packaging

> **Fork feature backend dependency:** disk-snapshot fork requires a new
> Computer Use API that is not deployed yet. It must fail explicitly until
> supported, never silently fall back to a fresh blank desktop. The upstream
> model-data build blocker has been resolved using the exact published pi-ai
> artifact; upstream offline builds and actual Node24 CI Docker build passed at predecessor d842679.
> Container smoke must pass at the current PR HEAD before release; deployment
> remains unperformed.

This repository packages its maintained `src` tree against public
[r33drichards/pi](https://github.com/r33drichards/pi) pinned to

d3e3b4ea7bd00e1e3784ac276a7c86fd1a5f1087.

Node 24 runs both stages. The build uses npm ci --ignore-scripts, hydrates
model data from a SHA256-verified immutable npm artifact, and builds upstream with build:offline **before** overlaying cuse
into /app/packages/coding-agent/src/cuse. Runtime starts:

    /app/node_modules/.bin/tsx --tsconfig /app/tsconfig.json /app/packages/coding-agent/src/cuse/main.ts

No extensions are installed or seeded by this image. Existing volume settings
and explicitly configured extensions are preserved; use a fresh dedicated
volume to avoid inheriting extensions or pi-irc state. cuse does not need an
mcp-js coordinator; entrypoint always removes the top-level mcpJs setting.

## Local Docker Compose

Build context is this repository root. Only cuse source, entrypoint and the immutable model artifact are copied from the context;
never add secrets to COPY or build arguments. The build context excludes runtime checkouts, dependencies, auth files and environment files.

    cd cuse
    cp .env.example .env
    # Privately populate IRC_SERVER, COMPUTERUSE_API_TOKEN and complete the private ChatGPT admin login below.
    docker compose --env-file .env -f compose.yml config --quiet
    docker compose --env-file .env -f compose.yml build
    docker compose --env-file .env -f compose.yml up -d

Do not publish resolved compose config or logs containing secrets. There is no
HTTP service, port mapping, or HTTP healthcheck. A running process alone does
not prove IRC/provider/desktop connectivity. Check sanitized startup logs and
perform a controlled addressed prompt only after approval.

## Railway setup (operator only; not performed by packaging)

Use Dockerfile deployment with this repository as build context and Dockerfile path Dockerfile. No root
railway.json is supplied or required. The image ENTRYPOINT is the start
command; do not replace it with pi irc or skip its configuration step.

Attach a dedicated persistent Railway volume at **/data/agent**. This stores
settings.json, models.json, IRC channel-to-desktop mapping, conversations and
per-channel working directories. Back it up securely. Do not attach the old
pi-irc state volume: its schema/desktop mapping is not interchangeable. Keep
one replica per IRC identity and volume; concurrent replicas are unsupported.

Set IRC_SERVER, IRC_PORT, IRC_TLS, IRC_PASSWORD as references to the existing
Railway IRC service/shared variables, using Railway's reference picker (for
example `${{shared.IRC_PASSWORD}}` with the actual source selected by the
operator). Reference COMPUTERUSE_API_TOKEN from an approved secret variable.
Do NOT automatically import any existing pi-irc provider secret. The default
provider is ChatGPT account OAuth (openai-codex), not API-key billing.
Existing service names and variable availability must be
confirmed by the operator; this packaging does not retrieve, display or
assume their values. Never include auth.json in the image. Provider OAuth login is permitted ONLY
in the private admin onboarding flow below, not through IRC or a guest desktop. No Railway credentials or deployment actions are required to
validate packaging.

Defaults: nick cuse, control channel #cuse, addressed-only responses,
https://api.computeruse.site, viewer https://app.computeruse.site, small
sessions, and maximum 10 cuse desktops within this instance namespace. The
limit is not a global account quota or spending cap. Choose a stable unique
CUSE_INSTANCE_ID if service identity might change; otherwise RAILWAY_SERVICE_ID
is used when available, falling back to IRC server:port:nick. Preserve it
across restarts to reconcile desktop names. Setting a new identity can create
new desktops while old ones keep incurring charges.

## Provider and configuration precedence

Default new-install provider/model: **openai-codex / gpt-5.4**, using the admin's
ChatGPT account OAuth. The immutable catalog includes this model. Set both env
variables explicitly to migrate an existing volume; persisted provider/model
settings are otherwise preserved. There is no automatic Anthropic or OpenAI
API-key fallback. An alternate provider requires an explicit admin choice,
its own credentials and acceptance of separate billing.

## Private ADMIN ChatGPT onboarding (operator-only)

Based on pi/packages/coding-agent/docs/providers.md: pi interactive /login
supports ChatGPT Plus/Pro (Codex), stores OAuth credentials via AuthStorage,
and refreshes expired credentials. **No login was performed for validation.**

1. Build and validate the image, provision the dedicated writable persistent
   volume, and stop the public bot during setup. Use a private admin terminal
   that is not logged/broadcast to IRC and is not a Computer Use desktop.
2. With the same agent-data volume and PI_CODING_AGENT_DIR=/data/agent, start
   interactive pi instead of the cuse entrypoint. Proposed local command:

       docker compose --env-file .env -f compose.yml run --rm --no-deps --entrypoint /app/node_modules/.bin/tsx cuse --tsconfig /app/tsconfig.json /app/packages/coding-agent/src/cli.ts --provider openai-codex --model gpt-5.4

   In that private interactive session use /login and select ChatGPT
   Plus/Pro (Codex). Complete authorization only in the admin's trusted browser
   and private terminal. Remote callback/pasted redirect handling must follow
   pi's actual prompt; never post a login URL, callback URL, authorization code,
   access token or refresh token in IRC. This is an operator procedure, not a
   public bot command; do not add an IRC login/callback endpoint.
3. Exit without sending a model prompt. Ensure /data/agent/auth.json has mode
   **0600**, is owned by the runtime user, and the volume remains writable for
   token refresh. Inspect file presence/mode only, never print its contents.
   In Railway, use an approved private admin console with that same mounted
   volume and agent-directory setting; do not place auth data in build args,
   source, env JSON, or public service logs.
4. Restart the bot with PI_DEFAULT_PROVIDER=openai-codex and the selected model.
   OAuth credentials survive restarts on /data/agent; pi AuthStorage refreshes
   expired tokens and persists updates there. Refresh can still fail after
   revocation or account changes: stop/re-authenticate privately rather than
   switching to API-key billing. Run one replica per shared auth/state volume.

Startup never writes generated API-key entries to auth.json or imports secrets
from pi-irc. It preserves existing auth bytes, restricts an existing auth file
to mode0600, and uses umask077 for new files. Settings/models merges do not
replace auth.json. OAuth refresh writes belong to pi, not this entrypoint.

**Host/guest separation:** /data/agent/auth.json remains on the cuse host volume,
not inside a Computer Use desktop. Never mount, upload or copy host OAuth
credentials into any guest disk, tool output, prompt, snapshot or fork.
Computer Use disk snapshots may copy guest-site logins/keyring data, but MUST
NOT copy the host ChatGPT OAuth credentials. Keep encrypted credential backups
private and protect against untrusted extensions accessing the host volume.

All public bot users share the ADMIN ChatGPT account's usage limits. Desktop
billing is separate and forks can incur additional desktop charges. Account
sharing/subscription eligibility and service terms must be reviewed by the
admin; this packaging does not guarantee account entitlement or quota.

Optional /config/settings.json is a read-only JSON object. Startup performs a
shallow merge of persisted settings then mounted settings, then explicit
nonempty PI_DEFAULT_PROVIDER/PI_DEFAULT_MODEL environment overrides. Defaults
fill missing provider/model only. Unrelated settings (including extension
lists) survive, but mcpJs is removed even from a mounted overlay.

Custom providers: mount a read-only /config/models.json or supply PI_MODELS_JSON
as a JSON object following pi's models.json schema. Mounted models take
precedence over env; absent both, the previous volume file is retained.
Invalid JSON fails startup rather than silently replacing configuration.
Removing an override does not remove persisted models/settings: manage the
volume deliberately. Entry point writes settings/models atomically with
mode 0600. No secrets are interpolated into shell-built JSON.

## Explicit authorization and safety decision

**All IRC users are authorized by the user's decision.** There is no nickname,
account or role allowlist. Anyone able to address the bot or send supported
control commands can cause work, join channels, provision desktops and incur
provider/desktop spending. Keep the IRC network/channels restricted to the
intended group; do not treat addressed-only mode as access control.

Desktops visit untrusted sites and may contain logged-in sessions, downloaded
files, credentials and private data. Site text can attempt prompt injection.
A shared channel shares conversation, desktop access and tool results: a
participant can request disclosure of secrets available to that desktop.
The Computer Use token is host-side rather than placed in prompts, but this
is not a promise that shared-channel workflows are safe for secrets. Only
put credentials/data on a desktop that every participant is authorized to
access; use separate accounts/channels where needed. Viewer links and
conversation archives should be treated as sensitive.

Joining creates/reconciles a desktop; channel activity can wake it. Leaving
a channel retains its desktop and conversation. Commands include desktop,
sleep and wake. The planned ,fork command copies the conversation PLUS an
independent disk snapshot: use ,fork #target, or bare ,fork for an auto-named
channel. The snapshot includes browser profile, stored logins, keyring files
and other files on disk. The child cold-starts from that snapshot; this is not
a live memory/process clone and does not guarantee restoring active tabs or
in-flight operations. Parent and child disks are independent after the fork.

**Backend dependency: the new Computer Use disk-snapshot fork API is not yet
deployed.** Fork must fail explicitly until the backend supports it; there is
no silent fresh-desktop fallback. Packaging does not implement this API or the
runtime command. No ,merge or merge_channel is supported, and no spawn_channel
tool is planned.

Forking creates another potentially billable desktop and copies conversation,
logged-in browser profiles, cookies, keyring files and other sensitive disk
contents into the target channel's desktop. Every participant there must be
authorized for ALL copied credentials/data, not just the conversation. Disk
independence does not revoke account sessions or make shared credentials safe;
parent and child may still access the same remote accounts. Cold-starting may
require unlocking the copied keyring and re-authentication for some services.
Treat snapshot storage and backups as secret-bearing assets.

Desktop deletion is deliberately performed in https://app.computeruse.site,
not in IRC.
Sleeping is not deletion. After deletion, a remembered mapping can fail;
resolve stale channel records and backups deliberately before reprovisioning
rather than assuming part/rejoin creates a fresh desktop. Review active
sessions and billing regularly; max10 does not cap remote account spend.

## Validation boundaries

Run `bash -n entrypoint.sh` and `node --test test/packaging/entrypoint.test.cjs`.
The tests use ONLY synthetic OAuth data in disposable packaging-root folders:
they check byte preservation across three simulated starts, mode0600, codex
defaults, explicit migration of persisted provider settings and volume/agent-dir
configuration. They do not test real login or token refresh.
Run Compose config --quiet with a private env file, and
a Docker build in an approved Docker-capable environment. Build requires
public GitHub/npm access, but never fetches live model catalogs. See
model-snapshot/PROVENANCE.md for artifact provenance, hashes and exact paths
added upstream. The snapshot preserves the pinned provider/model catalog,
including kimi-coding; published availability may change even though build
data is fixed. npm install scripts are intentionally skipped, so unrelated
native pi features are not guaranteed. Historical offline build passed in an isolated pinned clone on Node22.23.3.
Actual Node24 host builds and public container CI have since passed:06b214e
push37221827152 and PR37221830888 include all82tests, Docker and container smoke.
Local Docker/Compose remain unavailable; newer source requires its own settled
exact-HEAD CI at the parent barrier, not a new billing/runner change. No actual IRC,
provider API, Computer Use API, Railway deployment or secret inspection is
needed for syntax/configuration checks.

## Reproduce release checks

From this repo on Node24 (actual host Node24.14.0 and settled predecessor06b214e container validated; newer source requires exact-HEAD CI):

    npm ci --ignore-scripts
    npm run bootstrap
    npm run check
    npm test

bootstrap checks out pinned upstream exclusively under .runtime/pi, verifies the model archive SHA256, hydrates and builds upstream offline before copying maintained overlay, then builds/typechecks the whole coding-agent including actual overlay. It never writes the real pi checkout. npm test runs all maintained suites, including executed startup sanitization/precedence/defaults, detached state transactions, controlled error boundaries, full adapter-to-SDK/model-context/IRC, synthetic AuthStorage/session checks, actual default registration/JOIN and image probe regressions. All fetches in the refresh integration are intercepted; no real credentials or model calls are used.

The Actions workflow runs these checks on Node24 and builds/smokes the Node24 Docker image. It publishes nothing and never deploys. Absence of Docker/Nix locally is not an image-build pass; inspect the exact PR HEAD workflow result before release.

## Release gate, E2E and rollback runbook

Do not deploy or merge until independent source/image review passes and the backend interface decision is recorded. Current disk fork is explicitly unsupported: bare, named, multi-target and concurrent forks must have zero target JOIN/provision/conversation/state effects. No invented endpoint or fresh-disk fallback. A supported fork later requires reviewed backend semantics, disk/profile/keyring restore tests and host-credential exclusion.

Provision one NEW cuse service/replica and NEW /data/agent volume; never mutate existing piirc. Confirm dedicated token scoped to intended account, IRC reference names privately, a stable instance ID, small size and cap initially2 (absolute maximum10). Confirm prices in operator UI and set an external budget/alarm: cap is not a monetary limit. Record created desktop IDs privately for cleanup, never credentials. Operator privately completes Codex login, validates auth presence/mode only, exits without prompting. Treat auth revocation as private reauthentication, not API-key fallback.

After explicit safe live-validation authorization, join two disposable independent channels A/B. Check distinct desktop IDs, separate session files and independent browser state. Address one harmless prompt in A; B must stay unchanged. irc_send to unjoined target must reject, joined B succeeds only on explicit request. Host read/write/edit/bash/spawn/merge must be absent. Restart process preserving instance/volume; recover SAME IDs/session identities with no extra POST. Remembered404 must fail, never replace. Ambiguous504 must not replay tool calls. Test cap exhaustion without provisioning a third desktop. Current ,fork must fail closed before any target JOIN or effect. Once backend is supported, separate approved E2E must verify copied guest disk/profile/keyring but cold processes, separately copied conversation, independently mutable child storage, source resume under latest intent, lost-response reconciliation and cleanup at bounded quota. Never upload host auth to guests.

Health is sanitized IRC connection+joined channel+controlled response, not merely PID: there is no HTTP endpoint. Check startup errors without credential dumps. Stop cuse immediately on identity leakage, duplicate provisioning, auth fallback, replay, host-tool exposure, or unintended billing. Roll back to the last reviewed IMAGE DIGEST with the same instance and dedicated volume; stop before secure backup/restore to avoid competing writers. Do not delete or replace remembered mappings to hide404. Preserve encrypted private evidence and reconcile desktops by stable namespace. Stop/delete ONLY the recorded disposable cuse desktops after validation via operator approved API/UI; verify billing termination and no foreign resources changed. Remove temporary channels and test service/volume only after secure required state retention. Existing piirc remains untouched.

## Credential/network gates observed in release preparation

Official Computer Use repository docs/api-tokens.md confirms https://api.computeruse.site /v1/me and /v1/sessions use direct Bearer API token; https://app.computeruse.site is the private Pomerium browser UI. Token may alternatively exchange via client credentials, but cuse uses direct Bearer. Provision a dedicated UNBOUND token with sessions:read, sessions:write, sessions:connect ONLY. Do not add policies scopes or give guests the host provisioning token. It acts as its owner, not an admin, and is shown only once. Operator installs it directly into NEW cuse service Railway secret UI; no agent/IRC handling.

Both official origins were tested without credentials using curl --max-time15: API /v1/me and app each timed out (exit28, HTTP000), a separate network gate. No live credential validation is inferred.

Railway intended destination references (read-only inherited identifiers, not newly validated UI): project37a71c12-bee2-43f7-8fad-3ebeaea66789, productionc7e27f4f-f5ef-43ca-9735-7949a42aa33a; existing piirc093b47b5-b69c-4565-935f-cce512b2b98d MUST NOT be changed. Create a separate cuse service/volume only after review authorization. Discovery of existing service variable references remains operator work; never dump environment/resolved compose config.

Do NOT launch IRC until private OAuth onboarding is complete. Local onboarding command in the section above bypasses the public cuse entrypoint; it uses pi's standard /login and no model prompt. For presence/mode only in that same trusted admin container (never print contents):

    test -f /data/agent/auth.json
    chmod 0600 /data/agent/auth.json
    stat -c '%a' /data/agent/auth.json # must be600

Do not use cat, token dumps or callbacks in recorded/shared terminals. Live login, refresh and E2E remain explicit manual gates; synthetic tests do not substitute for them.

## Current shipping gate clarification

Repository is now PUBLIC after explicit user authorization and parent history/content audits. Historical private Actions run37179062680/job111367722132 never started due account payment/spending eligibility; that is historical evidence, NOT a current financial prerequisite. Public runs37187598097/37187595643 at27c37b1 actually passed Node24 bootstrap/check/63tests and Docker build, then failed only the catalog smoke because tsx -e selected CommonJS against import-only pi-ai exports. At d842679, both public runs37188937272/37188934400 passed actual65tests, Docker build and corrected file-mode ESM container smoke. Newer corrections require their own settled exact-HEAD CI at the parent dependency barrier; predecessor evidence is not current feature approval. No billing/limits/runner changes are part of this fix.

Remote API/app DNS resolves8.231.155.139 but remote TCP443 times out. Operator reports app loads and is signed in on their own machine, so this is a remote-path connectivity issue, not proof of universal outage. Use operator PRIVATE UI for token creation without passing values to agent. In app token UI: name cuse, UNBOUND to a single session, scopes sessions:read/write/connect ONLY, no policies scopes; choose operator-approved lifetime. Install COMPUTERUSE_API_TOKEN directly into NEW cuse Railway service variables via secret UI, never echo/retrieve it or embed in source/buildargs. On Railway use project/env identifiers above, NEW cuse service sourced from this PUBLIC repo and reviewed image/HEAD, NEW volume at /data/agent, one replica and stable CUSE_INSTANCE_ID. Select existing IRC service/shared secret REFERENCE names privately; current canvas confirms existing pi-irc and pi-irc-agent volume but neither is to be changed/reused. Set provider/model explicitly openai-codex/gpt-5.4 and initiallycap2/small for approved E2E. Do not start public IRC before the private on-volume admin /login procedure above. Service/volume provisioning, merge and deployment are NOT performed by this lane and remain review-authorized future actions.

No independently reviewed fork backend contract exists yet per parent. Keep explicit UnsupportedDesktopForkError. Later adapter/tests require parent-delivered real operation/request/response/idempotency and lost-response reconciliation contract, controlled-pause/admission/drain/lifecycle intent fencing, independent restored disk/profile/keyring and hostauth exclusion, quota/cost/cleanup/error semantics and proven backend restore. No speculative endpoint or fresh-disk fallback.

## Persistence and controlled error-boundary limits

Channel state set operations are synchronous/serialized within one process: stage a candidate map, securely write and fsync mode0600 temp file, atomically rename, then publish memory. Write/rename failure retains prior memory+file and does not leave a phantom desktop/session record. One replica remains required; this is not multiprocess coordination or a directory-fsync/power-loss durability claim. Never repair remembered404 by creating a replacement.

Cuse catches/logs now expose only owned constant guidance codes, never arbitrary error.message, stacks, causes, provider response text or secret-bearing URLs. Failed assistant/tool error events are similarly withheld; synthetic canaries exercise command, cross-channel, lifecycle, model, reload, join/send and runtime error paths. This fixes propagation risk found in source review; no actual token leak incident was proven. Normal successful model/guest tool/user content is still intentionally relayed.

Standard pinned pi AuthStorage/ModelRuntime OAuth remains unchanged. Its locked refresh file writes are inherited and NOT crash-atomic: a crash can leave auth.json incomplete despite access mode0600. Private encrypted host-volume backups are useful but an OLD backup of a rotated refresh token is not guaranteed valid; restoration may require trusted PRIVATE admin reauthentication while bot stopped. Do not claim crashproof OAuth or fall back to API-key billing. Keep backup credentials private/off guest disks, remove plaintext temporary backups and protect stored encrypted copies.

Normal trusted host resource/extension loading is NOT a security sandbox. Disabled host builtin model tools do not prevent trusted installed extension code, resource loading or direct host stdout from accessing/logging host data. Use a fresh dedicated agent volume and only trusted extensions/resources; controlled cuse error catches do not sandbox extension code or sanitize arbitrary intentional model/user/guest output. Host auth is never copied to guests/snapshots by cuse.

## Prior recovery corrections (06b214e; not release approval)

Default BOT nick is cuse and control/startup channel is #cuse; actual registration/JOIN and executed entrypoint export tests exercise this, while explicit IRC_NICK/IRC_CONTROL_CHANNEL overrides remain supported. Other joined channels keep independent desktop/session identities. This changes no host coding-agent IRC integration or existing pi-irc service.

Entrypoint configuration JSON/filesystem failures now have a controlled outer catch and constant shell guidance/nonzero status. Raw stderr is withheld, including from the exec'd runtime; controlled stdout/IRC diagnostics remain, and trusted extensions are still not sandboxed. Executable preflight detects missing launcher; no promise of crash-proof loader/runtime handling. Mounted JSON precedence, OAuth byte preservation/mode600 and standard AuthStorage remain.

Remote adapter failures now throw a controlled failed-tool outcome before raw remote content can enter model context. SDK isError is true, raw text/images/structured error data are withheld from model/IRC/transcript, and each adapter invocation calls the remote exactly once, including transport rejection. Normal successful guest stdout/images remain intact. The regression actually drives adapter -> real SDK/session -> model context -> IRC relay with only synthetic model generation, no live model, OAuth refresh or desktop connection.

State get/entries/set use detached deep snapshots, including nested data and mutation during a write; caller aliases cannot change committed state outside transaction. Prior write/rename failure/concurrency semantics remain. At06b214e, local Node24.14.0 build/typecheck and all82 maintained tests passed (zero failed/skipped); exact-input hashes/logs are recorded in validation/recovery-boundary-inputs.json and validation/recovery-boundary-result.md. Historical63/65 evidence is preserved. Its public CI subsequently passed (IDs above); newer exact-HEAD CI is parent-owned at the dependency barrier, and pending jobs are not satisfied and this document does not grant feature acceptance. Unsupported disk fork, private ADMIN auth/token and independent live/release review gates remain.

## Effective channel screenshots (current correction, not approval)

Cuse uses a session-local controlled SettingsManager view: the SDK's public
getBlockImages query always returns false, while all other methods are bound
to the original manager. Supported applyOverrides is transient and ordinary
save/reload merges can discard it; cuse no longer rewrites the GLOBAL image
preference to enforce this policy. Trusted project/global settings retain
their own persisted values. Actual file-backed precedence plus real SDK model
conversion tests preserve successful screenshots before and after reload/save.
All83 maintained tests and actual Node24.14.0 overlay build/typecheck passed;
see validation/effective-images-inputs.json and effective-images-result.md.
New exact-HEAD CI and independent source approval remain parent barriers.

### Mention toggle

Send `,toggle mention` in a channel to switch between requiring `cuse:` and responding to every message. The bot confirms whether mentions are ON (required) or OFF. The setting is per channel and survives restarts; channels without an override use `IRC_RESPOND_TO_ALL`. The toggle works without a bot prefix in any channel. DMs always accept messages.
