# Build context: this repository root.
FROM node:24-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN git clone --filter=blob:none https://github.com/r33drichards/pi.git . \
 && git checkout --quiet d3e3b4ea7bd00e1e3784ac276a7c86fd1a5f1087 \
 && test "$(git rev-parse HEAD)" = d3e3b4ea7bd00e1e3784ac276a7c86fd1a5f1087 \
 && rm -rf .git
# Keep dev dependencies: runtime uses tsx and workspace source imports.
# Hydrate ignored data from an immutable compatible published artifact, NOT
# today's changing model APIs. Preserve the pinned generated TS metadata.
COPY model-snapshot/pi-ai-0.85.1.tgz /opt/pi-ai-0.85.1.tgz
RUN echo "af7d11986179445ce6fe88b37d57de22f823c0ffd3a65cae31c555b7f5e99253  /opt/pi-ai-0.85.1.tgz" | sha256sum --check --status \
 && npm ci --ignore-scripts --no-audit --no-fund \
 && mkdir -p packages/ai/src/providers/data \
 && tar -xzf /opt/pi-ai-0.85.1.tgz -C packages/ai/src/providers/data \
      --strip-components=4 package/dist/providers/data \
 && npm run check:model-data \
 && npm run build:offline \
 && rm /opt/pi-ai-0.85.1.tgz \
 && npm cache clean --force
# Install cuse-owned runtime dependencies from its committed lockfile.
COPY package.json package-lock.json /opt/cuse-deps/
RUN cd /opt/cuse-deps && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && cp -R node_modules/croner /app/node_modules/croner
# Build upstream before overlaying cuse, which is run directly with tsx.
COPY src/ /app/packages/coding-agent/src/cuse/
RUN npm --prefix packages/coding-agent run build

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PI_CODING_AGENT_DIR=/data/agent \
    IRC_NICK=cuse \
    IRC_CONTROL_CHANNEL=#cuse \
    COMPUTERUSE_API_URL=https://api.computeruse.site \
    COMPUTERUSE_APP_URL=https://app.computeruse.site \
    COMPUTERUSE_SESSION_SIZE=small \
    CUSE_MAX_DESKTOPS=10
COPY --from=build /app /app
COPY entrypoint.sh /usr/local/bin/cuse-entrypoint
COPY scripts/image-smoke.mts /app/cuse/image-smoke.mts
RUN chmod 0755 /usr/local/bin/cuse-entrypoint && mkdir -p /data/agent /workspace
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/cuse-entrypoint"]
