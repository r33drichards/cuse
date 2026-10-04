# Immutable model-data snapshot

Source: published @earendil-works/pi-ai@0.85.1, matching pinned workspace
version. URL: https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-0.85.1.tgz
Downloaded with npm pack --ignore-scripts; package scripts were not run.
Original tarball retained unchanged as pi-ai-0.85.1.tgz.

- npm SHA1: 3f5726032c30149f6060a3aeacb79436c7387a37
- SHA256: af7d11986179445ce6fe88b37d57de22f823c0ffd3a65cae31c555b7f5e99253
- npm integrity: sha512-+VgVIJDkDO2efYJKEEqvPTH4zmnIaXdAppGbO+vKFA9qy5PdhFiAenuFAkU+oiCSfOC4dMHDyrjdQeL4ZoC5CQ==
- SHA512 hex: f958152090e40ced9e7d824a104aaf3d31f8ce69c8697740a6919b3bebca140f6acb93dd8458807a7b8502453ea220927ce0b874c1c3cab8dd41e2f86680b909
- Artifact manifest generatedAt: 2026-09-05T11:58:56.761Z
- Artifact structureHash: ff87cfcb3c1decb7ceeb4a5d71282696e108d093b7098f372d6f8a442dfed40d

Dockerfile builds directly in /app: it copies the archive to /opt/pi-ai-0.85.1.tgz,
verifies SHA256, and extracts only package/dist/providers/data into
/app/packages/ai/src/providers/data. This build does NOT invoke scripts/bootstrap.sh.
For host/CI source checks, scripts/bootstrap.sh instead hydrates the disposable
.runtime/pi/packages/ai/src/providers/data under the repository; these are distinct
execution paths with the same verified archive and pinned source.
No published JS, declaration files, wrappers, generated TS metadata or image
model metadata replaces pinned source. This hydrates ignored data only.

## Compatibility evidence

Pinned pi commit: d3e3b4ea7bd00e1e3784ac276a7c86fd1a5f1087.
Published models.generated.js.map embedded models.generated.ts matches pinned
source byte-for-byte. All 39 published provider *.models.js.map embedded
TypeScript wrappers match pinned source byte-for-byte. Artifact includes
kimi-coding.json and its existing wrapper. Upstream check:model-data validates
manifest structure and provider data hashes; it passed against unmodified
pinned metadata. Full build:offline passed on host Node22.23.3 after
npm ci --ignore-scripts. No fabricated definitions or weakened types.

This preserves the exact published catalog; no provider is added/removed by
regeneration. Model availability at providers can nevertheless change. The
upstream npm SHA512 integrity was compared to downloaded bytes, but no
independent provenance/signature verification was performed. At that historical check, Node24 container build was unperformed and local Docker unavailable. Later d842679 public CI successfully built/smoked the actual Node24 container; see Current status below.

## Exact data files added (final-image paths; no pinned source replaced)

- /app/packages/ai/src/providers/data/.manifest.json
- /app/packages/ai/src/providers/data/amazon-bedrock.json
- /app/packages/ai/src/providers/data/ant-ling.json
- /app/packages/ai/src/providers/data/anthropic.json
- /app/packages/ai/src/providers/data/azure-openai-responses.json
- /app/packages/ai/src/providers/data/baseten.json
- /app/packages/ai/src/providers/data/cerebras.json
- /app/packages/ai/src/providers/data/cloudflare-ai-gateway.json
- /app/packages/ai/src/providers/data/cloudflare-workers-ai.json
- /app/packages/ai/src/providers/data/deepseek.json
- /app/packages/ai/src/providers/data/fireworks.json
- /app/packages/ai/src/providers/data/github-copilot.json
- /app/packages/ai/src/providers/data/google-vertex.json
- /app/packages/ai/src/providers/data/google.json
- /app/packages/ai/src/providers/data/groq.json
- /app/packages/ai/src/providers/data/huggingface.json
- /app/packages/ai/src/providers/data/kimi-coding.json
- /app/packages/ai/src/providers/data/minimax-cn.json
- /app/packages/ai/src/providers/data/minimax.json
- /app/packages/ai/src/providers/data/mistral.json
- /app/packages/ai/src/providers/data/moonshotai-cn.json
- /app/packages/ai/src/providers/data/moonshotai.json
- /app/packages/ai/src/providers/data/nvidia.json
- /app/packages/ai/src/providers/data/openai-codex.json
- /app/packages/ai/src/providers/data/openai.json
- /app/packages/ai/src/providers/data/opencode-go.json
- /app/packages/ai/src/providers/data/opencode.json
- /app/packages/ai/src/providers/data/openrouter.json
- /app/packages/ai/src/providers/data/qwen-token-plan-cn.json
- /app/packages/ai/src/providers/data/qwen-token-plan-individual.json
- /app/packages/ai/src/providers/data/qwen-token-plan.json
- /app/packages/ai/src/providers/data/together.json
- /app/packages/ai/src/providers/data/vercel-ai-gateway.json
- /app/packages/ai/src/providers/data/xai.json
- /app/packages/ai/src/providers/data/xiaomi-token-plan-ams.json
- /app/packages/ai/src/providers/data/xiaomi-token-plan-cn.json
- /app/packages/ai/src/providers/data/xiaomi-token-plan-sgp.json
- /app/packages/ai/src/providers/data/xiaomi.json
- /app/packages/ai/src/providers/data/zai-coding-cn.json
- /app/packages/ai/src/providers/data/zai.json

All generated build output remains ordinary npm run build:offline output.
Model API/network calls are not required during image hydration/build.

## Reproduce compatibility check in a disposable pinned checkout

Run with Node24 in a supported Linux environment. Set SNAPSHOT to the absolute
path of this directory's pi-ai-0.85.1.tgz, then from the disposable pi root:

    npm ci --ignore-scripts --no-audit --no-fund
    mkdir -p packages/ai/src/providers/data
    tar -xzf "$SNAPSHOT" -C packages/ai/src/providers/data --strip-components=4 package/dist/providers/data
    npm run check:model-data
    npm run build:offline
    git diff --exit-code

A follow-up attempt to execute npm's node-linux-x64@24.14.0 binary on the
remote host failed before any build execution: required interpreter not found.
That historical binary attempt did not test the Node24 bookworm image; later actual container CI evidence is separate.

Followup: actual Node24.14.0 HOST offline build and overlay/tests now passed using verified tooling in scratch; see ../validation/node24-result.md. That historical private Actions billing gate was superseded by actual public CI at d842679; local Docker/Nix remain absent. No model snapshot bytes changed.

## Current status

The model archive SHA256 and pinned pi are unchanged. Single-repository Docker context copies model-snapshot/pi-ai-0.85.1.tgz to /opt and hydrates /app directly; separate host/CI bootstrap hydrates disposable .runtime/pi before maintained overlay. Settled public CI atd842679 (37188937272/37188934400) and06b214e (37221827152/37221830888) passed Node24 Docker build/container runtime+catalog, including Codexgpt-5.4,kimi-coding,40runtime providers and zero network requests in smoke. That settled predecessor evidence does not approve newer corrections; parent owns settled exact-new-HEAD CI. Historical unperformed/billing statements above are chronology only, not current prerequisites. No full disk-fork support or live auth validation is claimed.
