FROM node:24.19.0-bookworm-slim AS build

WORKDIR /workspace
RUN npm install --global pnpm@11.19.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:24.19.0-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /workspace
RUN npm install --global pnpm@11.19.0

COPY --from=build /workspace /workspace

FROM runtime AS api
CMD ["pnpm", "--filter", "@travel/api", "start"]

FROM runtime AS worker
CMD ["pnpm", "--filter", "@travel/worker", "start"]

