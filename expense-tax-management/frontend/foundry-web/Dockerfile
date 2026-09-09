FROM node:24-alpine AS build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/tsconfig.json ./packages/contracts/
COPY packages/contracts/src ./packages/contracts/src
COPY packages/contracts/generated ./packages/contracts/generated
COPY frontend/foundry-web/package.json frontend/foundry-web/tsconfig.json frontend/foundry-web/next.config.ts frontend/foundry-web/eslint.config.mjs ./frontend/foundry-web/
COPY frontend/foundry-web/src ./frontend/foundry-web/src
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @expense-tax/contracts build
RUN pnpm --filter @expense-tax/foundry-web build
FROM node:24-alpine AS runtime
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /workspace/frontend/foundry-web/.next/standalone ./
COPY --from=build --chown=app:app /workspace/frontend/foundry-web/.next/static ./frontend/foundry-web/.next/static
USER app
ENV NODE_ENV=production PORT=7303 HOSTNAME=0.0.0.0
EXPOSE 7303
CMD ["node", "frontend/foundry-web/server.js"]
