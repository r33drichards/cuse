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
