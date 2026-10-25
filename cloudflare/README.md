# Cuse durable webhook stage

Passive Pi Durable / Cloudflare receiver, with no direct IRC connection and no
model or outgoing-message execution. See the [migration plan](../docs/durable-webhook-migration.md)
for the verified protocol, identity capability gap, rollout gates and rollback.

Run `npm ci --ignore-scripts`, `npm run check`, `npm test`, `npm run test:worker`,
and `WRANGLER_SEND_METRICS=false npm run dry-run` with Node 24. Do not deploy or
configure secrets/subscriptions without the per-action review described there.
