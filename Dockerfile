# ExpenseSyncBot container image (linux/arm64 on the Raspberry Pi cluster; builds on amd64 too).
#
# One image, two processes (the Pi runs them as separate workloads):
#   main bot   : bun run index.ts   (default CMD; Telegram long polling + HTTP API on :3311)
#   bank sync  : bun bank-sync.ts    (outbound only; shares the SQLite file with the main bot)
#
# No secrets are baked in: configuration comes from environment variables at runtime and
# .dockerignore keeps every .env* file out of the build context.
ARG BUN_VERSION=1.2.17

# Stage 1: bun binary, shared by every later stage.
FROM debian:bookworm-slim AS bun
ARG BUN_VERSION
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl unzip ca-certificates && \
    curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v${BUN_VERSION}" && \
    rm -rf /var/lib/apt/lists/*

# Stage 2: locked dependencies of the bot and of the ZenPlugins bank plugins.
# git is needed: ZenPlugins depends on packages fetched straight from git hosts.
FROM bun AS deps
WORKDIR /app
RUN apt-get update && \
    apt-get install -y --no-install-recommends git && \
    rm -rf /var/lib/apt/lists/*
COPY package.json bun.lock ./
# --ignore-scripts: skips the repo's git-hook postinstall. sharp ships prebuilt
# linux-arm64 binaries as optional packages, so it needs no install script.
RUN bun install --frozen-lockfile --ignore-scripts
# yarn.lock is honoured by bun, like the pm2 deploy's identical install. An empty submodule
# (checkout without --recurse-submodules) fails here instead of shipping a bot with no banks.
COPY src/services/bank/ZenPlugins/package.json src/services/bank/ZenPlugins/yarn.lock ./src/services/bank/ZenPlugins/
RUN bun install --cwd src/services/bank/ZenPlugins

# Stage 3: Mini App (Vite) static build -> miniapp/dist.
FROM bun AS miniapp
WORKDIR /app/miniapp
COPY miniapp/package.json miniapp/bun.lock ./
RUN bun install --frozen-lockfile
COPY miniapp ./
RUN bun run build

# Stage 4: runtime.
FROM debian:bookworm-slim AS runner
WORKDIR /app
# util-linux provides flock (the single-writer fence wrapper used by the cluster manifests);
# tzdata keeps TZ=UTC explicit.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates tzdata util-linux && \
    rm -rf /var/lib/apt/lists/*
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

COPY --from=deps /app/node_modules ./node_modules

# Headless Chromium for the table renderer and receipt fetcher (playwright launches it with
# headless: true, which uses the headless shell). Installed with its apt deps before the app
# source is copied so source edits do not invalidate this large layer. The cli runs under bun.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN apt-get update && \
    bun node_modules/playwright/cli.js install --with-deps chromium-headless-shell && \
    rm -rf /var/lib/apt/lists/*

COPY package.json tsconfig.json bunfig.toml index.ts bank-sync.ts ./
COPY libs ./libs
COPY src ./src
COPY --from=deps /app/src/services/bank/ZenPlugins/node_modules ./src/services/bank/ZenPlugins/node_modules
COPY public ./public
COPY --from=miniapp /app/miniapp/dist ./miniapp/dist

# Fixed uid/gid so a volume's ownership can be matched with fsGroup / chown on the cluster.
# data/ holds the SQLite database and receipt photos; logs/ the optional AI debug transcripts.
RUN groupadd --system --gid 10001 bot && \
    useradd --system --uid 10001 --gid bot --home-dir /app --shell /usr/sbin/nologin bot && \
    mkdir -p data logs && \
    chown bot:bot data logs

# Same environment the pm2 setup gave the bot: node-cron and date math use process-local time.
ENV NODE_ENV=production \
    TZ=UTC \
    OAUTH_SERVER_PORT=3311
USER bot
VOLUME ["/app/data"]
EXPOSE 3311
CMD ["bun", "run", "index.ts"]
