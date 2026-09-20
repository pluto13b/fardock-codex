# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS builder

ARG CODEX_PLUS_NPM_REGISTRY=https://registry.npmjs.org
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV COREPACK_NPM_REGISTRY=$CODEX_PLUS_NPM_REGISTRY
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/codex-web/package.json ./apps/codex-web/package.json
COPY packages/codex-serve-client/package.json ./packages/codex-serve-client/package.json
COPY packages/e2ee/package.json ./packages/e2ee/package.json
COPY packages/protocol/package.json ./packages/protocol/package.json
COPY services/relay/package.json ./services/relay/package.json

RUN pnpm config set registry "$CODEX_PLUS_NPM_REGISTRY" \
    && pnpm config set node-linker isolated \
    && pnpm install --frozen-lockfile --ignore-scripts \
      --filter @codex-plus/web... \
      --filter @codex-plus/relay...

COPY apps/codex-web/ ./apps/codex-web/
COPY apps/windows-agent/src/relay-host-client.ts ./apps/windows-agent/src/relay-host-client.ts
COPY packages/codex-serve-client/ ./packages/codex-serve-client/
COPY packages/e2ee/ ./packages/e2ee/
COPY packages/protocol/ ./packages/protocol/
COPY services/relay/ ./services/relay/
COPY scripts/verify-dsh-ui-boundary.mjs ./scripts/verify-dsh-ui-boundary.mjs
COPY vendor/deepseek-harness-ui/ ./vendor/deepseek-harness-ui/
RUN pnpm --filter @codex-plus/protocol test \
    && pnpm --filter @codex-plus/relay test \
    && pnpm --filter @codex-plus/web test
RUN pnpm codex-web:build
RUN pnpm --filter @codex-plus/relay build:production

FROM node:22-alpine AS runtime

ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="Codex Plus Gateway" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.revision=$VCS_REF \
      io.codex-plus.protocol-version="1"

RUN addgroup -S -g 10001 codexplus \
    && adduser -S -D -H -u 10001 -G codexplus codexplus \
    && mkdir -p /opt/codex-plus/web /var/lib/codex-plus \
    && chown -R 10001:10001 /opt/codex-plus /var/lib/codex-plus

COPY --from=builder --chown=10001:10001 /workspace/.tmp/gateway-runtime/gateway.cjs /opt/codex-plus/gateway.cjs
COPY --from=builder --chown=10001:10001 /workspace/.tmp/codex-web/ /opt/codex-plus/web/

ENV NODE_ENV=production
USER 10001:10001
WORKDIR /opt/codex-plus
EXPOSE 8787
STOPSIGNAL SIGTERM

CMD ["node", "/opt/codex-plus/gateway.cjs"]
