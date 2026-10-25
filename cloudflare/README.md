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
Do not deploy or configure secrets/subscriptions without per-action review.
