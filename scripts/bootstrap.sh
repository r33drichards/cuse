#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# vendor/pi is the source of truth; .runtime is disposable build output.
test -f vendor/pi/package-lock.json
mkdir -p .runtime
rm -rf .runtime/pi
cp -R vendor/pi .runtime/pi
echo 'af7d11986179445ce6fe88b37d57de22f823c0ffd3a65cae31c555b7f5e99253  model-snapshot/pi-ai-0.85.1.tgz' | sha256sum -c -
cd .runtime/pi
rm -rf packages/coding-agent/src/cuse
npm ci --ignore-scripts --no-audit --no-fund
mkdir -p packages/ai/src/providers/data
tar -xzf ../../model-snapshot/pi-ai-0.85.1.tgz -C packages/ai/src/providers/data --strip-components=4 package/dist/providers/data
npm run check:model-data
npm run build:offline
cd ../..
python3 scripts/prepare.py
npm --prefix .runtime/pi/packages/coding-agent run build
