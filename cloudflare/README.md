# Cuse durable webhook stage

Pi Durable / Cloudflare runtime with authenticated MCP event intake, private
history import, gated active model/tools, renewal and shared desktop coordination.
It has no direct IRC connection. Default operation is passive; live migration
remains blocked on inventory, identity and capability parity.

See the [migration plan](../docs/durable-webhook-migration.md) for exact contracts,
private rehearsal commands, activation gates, remaining gaps and rollback.

With Node 24, run `npm run bootstrap` at repository root for the original history
projector, then here: `npm ci --ignore-scripts`, `npm run check`, `npm test`,
`npm run test:worker`, and `WRANGLER_SEND_METRICS=false npm run dry-run`.
Tests use synthetic credentials/model/tool responses and local workerd only.
Main-branch Worker deployment uses the reviewed workflow below. Secret and
subscription configuration and live cutover still require separate review.

## GitHub Actions deployment on main

`.github/workflows/deploy-cloudflare.yml` runs on pushes to `main` (including
merges), not PRs or `workflow_run`. It calls both existing validation workflows:
release/native Docker checks and Worker type checks, unit/integration tests and
Wrangler dry-run. Deployment requires both to pass for that same event commit.
The deploy job checks out the exact `github.sha` and rebuilds from committed
lockfiles using Node 24 and Wrangler **4.150.0**, not an unpinned `npx` download.
PR and other branch validation remain credential-free. The entire main pipeline
is serialized with cancellation disabled for running deployments; GitHub may
replace a pending run with a newer push and does not guarantee queue order.
Before accessing Cloudflare credentials, a read-only GitHub API check skips a
superseded SHA and fails closed if current `main` cannot be verified. Re-running
an old workflow therefore cannot deploy its old SHA unless that is current main.

### One-time prerequisites (not provisioned by this repository)

1. Verify the intended Cloudflare account and `cuse-durable-shadow` Worker.
   The checked-in configuration keeps four SQLite Durable Object classes:
   `AgentSession`, `DesktopCoordinator`, `ModelAuthority`, and `ChannelRegistry`.
   First deployment applies its `v1` migration if not already present. Review
   existing migrations/bindings before targeting an existing Worker.
2. Create the GitHub environment **`cloudflare-shadow`**; restrict deployment
   branches to `main` and configure any required reviewers before enabling it.
3. Set environment variable **`CLOUDFLARE_ACCOUNT_ID`** to the verified account ID
   and environment secret **`CLOUDFLARE_API_TOKEN`** to an approved scoped token.
   Both are mandatory; missing values cause a clear failure before deployment.
   Use the least privilege supported for the intended operation: the documented
   Workers **Editor** role scoped to this existing Worker includes its Durable
   Objects. Creating a Worker for the first time requires separate provisioning
   authority (Workers **Creator** at account-product scope), rather than leaving
   broad creation permissions on the steady-state deploy credential. Verify the
   token's available permission/resource scope with your account administrator.
   Never commit credentials or use a Global API Key.
4. Provision/approve runtime secret bindings separately using the migration plan.
   This workflow does not create, rotate, upload or delete Worker secrets, import
   history, register MCP subscriptions, or switch sessions into active mode.
   Wrangler preserves existing secrets; `--keep-vars` also preserves configured
   dashboard variables. Existing active state is not reset to passive by deploy.
   A first deployment without runtime bindings is **not** a live-service cutover.

Cloudflare's [GitHub Actions guide](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
uses an API token plus account ID. No native GitHub OIDC-to-Workers deployment
credential exchange is assumed here; the workflow does not request `id-token`
or introduce an identity broker. See also the [Workers roles and scope reference](https://developers.cloudflare.com/workers/authorization/workers/).

After a merge, inspect both validation jobs and the deployment result for the
expected SHA. The workflow deploys only the Worker, **not** the native Docker
service. Do not configure secrets/subscriptions or change runtime activation as
part of a retry. Code rollback needs a separately reviewed known-good revision;
Durable Object data/schema migration rollback is not implied by a code rollback.

## Explicit private activation

The separate `operate-cloudflare.yml` workflow accepts manual `stage`, `activate`
and `cleanup` actions on current `main` only, after a successful deployment of
that same commit. It uses the protected `cloudflare-shadow` environment and the
same concurrency group as deployment. A code deployment never starts this flow.

Prepare a private package outside the checkout with `worker`, `approvedUntil`
(at most two hours ahead), and `runtime`. The runtime contains exactly three
JSON strings: `MODEL_SECRETS`, `MODEL_CONFIG`, and `WEBHOOK_ROUTES`. Each must fit
Cloudflare's 5 KB binding limit. Every route must have `activationPending: true`.
Gzip and base64 encode the package; store at most 48,000 characters in environment
secret `CUSE_OPERATOR_PACKAGE` and the remaining at most 48,000 characters in
`CUSE_OPERATOR_PACKAGE_2`. Never commit packages, credentials, archives or live
session inventories. Delete these temporary GitHub secrets after the operation.

`stage` installs runtime bindings with normal event delivery held at HTTP 503;
signed callback verification challenges still work. It creates no subscription
and starts no conversation. It enables an inert cron and waits for a log carrying
a fresh warmup nonce before succeeding. Keep the legacy owner active during
this wait: cron changes can take up to 15 minutes to propagate, longer than the
producer's bounded retry window. Activation preserves that warmed schedule.
Before `activate`, fence the legacy owner, verify
that the dedicated MCP profile owns the exact nick and buffer, and obtain the
reviewed existing subscription grant. Include `operator` in the package with
version 1, a fresh 32-character hexadecimal `id`, `routeKey`, complete `snapshot`,
matching `fence`, and `grant`. The workflow supplies a thirty-minute request lease (allowing cron propagation).
The fence must attest ownership release and identity verification, and the exact
snapshot hash must match the enabled route. Use empty archive/context arrays for
an approved fresh conversation; keep the original history and paused goal on the
retained rollback volume, referenced by private retained-state metadata.

The operator request is gzip encoded into at most 32 encrypted Worker secret
bindings of at most 4,800 characters each. A temporary minute cron invokes a
private Durable Object method; there is no public administrative HTTP endpoint.
Initialization validates the model and exact tools, imports the reviewed context,
and arms the existing grant. Repeated execution of the same request is idempotent
and does not reset renewal deadlines. Only a structured completion log matching
the request ID releases the delivery hold. No model prompt runs during setup.

The workflow removes the cron and request secrets after activation, including on
failure. Successful staging leaves its inert cron ready for handoff; run
`cleanup` if abandoning the cutover. A forced cancellation may interrupt cleanup: run `cleanup` explicitly;
the expired request also fails closed. Existing unrelated cron schedules cause a
failure before writes. On any failure, retain the legacy ownership fence, inspect
aggregate state, and do not replay uncertain effects. Rollback requires first
fencing the new owner before restoring the legacy service and its retained data.

### Adding another agent

Keep the original runtime secrets in place. Each additional agent uses a separate encrypted `CUSE_AGENT_<NAME>` binding (uppercase letters, digits and underscores; at most 48 characters). Its lowercase name is the webhook route key, such as `CUSE_AGENT_CUSE2` for `/events/cuse2`. The JSON value contains `binding`, `modelConfig`, and `modelSecrets`. Model configuration and authentication are selected only for that exact agent generation; each agent requires a separate native MCP profile and signing key.

The private operator package may contain exactly one such binding instead of the original three runtime secrets. Staging refuses an already installed binding name, leaves existing live agents unchanged, and holds only the new route. Activation initializes the reviewed generation and opens only that binding. The temporary cron and operator request are removed afterwards. Never use an original-agent package to add an agent or overwrite live route secrets.

### ChatGPT subscription authentication

Browser login runs privately outside the Worker using the pinned Pi OpenAI Codex provider. The protected, manual `authenticate-cloudflare.yml` workflow accepts an expiring `CUSE_AUTH_PACKAGE`; it requires a successful deployment of current main. It installs a fresh encryption key only when no key exists, seeds the OAuth credential through the internal shared `ModelAuthority`, then enables only the explicitly reviewed agents through separate `CUSE_AUTH_<NAME>` bindings. Tokens are encrypted in SQLite and refresh through the shared authority; an interrupted refresh remains held for reconciliation. A credential and its replay receipt commit atomically, so later cron invocations cannot reset a rotated token.

One request can include additional explicitly named active or staged agents sharing the same credential owner. For a staged migration, `preserveWarmedSchedule` may reuse only the known inert operator warmup schedule; final activation removes it. Otherwise the temporary authentication cron and request are removed after seeding. No public login, callback, or credential-import endpoint is added to the Worker, and credentials never go through IRC. After authentication, select `openai-codex/gpt-6.1-sol` with the ordinary model command.
