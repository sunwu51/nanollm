FROM rust:1-bookworm AS oauth-builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends cmake \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY native/oauth-transport/Cargo.toml native/oauth-transport/Cargo.lock ./
COPY native/oauth-transport/src ./src
RUN cargo build --release --locked

FROM node:24-bookworm-slim AS app-builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.dist.json cli.ts server.ts ./
COPY src ./src
RUN npm run build \
    && npm prune --omit=dev

FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=app-builder /app/package.json /app/package-lock.json ./
COPY --from=app-builder /app/node_modules ./node_modules
COPY --from=app-builder /app/dist ./dist
COPY scripts/start-railway.sh ./scripts/start-railway.sh
COPY --from=oauth-builder /build/target/release/nanollm-oauth-transport ./native-bin/linux-x64/nanollm-oauth-transport
RUN sed -i 's/\r$//' ./scripts/start-railway.sh \
    && chmod +x ./scripts/start-railway.sh ./native-bin/linux-x64/nanollm-oauth-transport

CMD ["bash", "scripts/start-railway.sh"]
