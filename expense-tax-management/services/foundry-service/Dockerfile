FROM node:24-alpine AS build

WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/tsconfig.json ./packages/contracts/
COPY packages/contracts/src ./packages/contracts/src
COPY packages/contracts/generated ./packages/contracts/generated
COPY services/foundry-service/package.json services/foundry-service/tsconfig.json ./services/foundry-service/
COPY services/foundry-service/src ./services/foundry-service/src

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @expense-tax/contracts build
RUN pnpm --filter @expense-tax/foundry-service build

FROM node:24-alpine AS runtime

WORKDIR /workspace
RUN addgroup -S app && adduser -S app -G app

COPY --from=build --chown=app:app /workspace/node_modules ./node_modules
COPY --from=build --chown=app:app /workspace/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=build --chown=app:app /workspace/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=app:app /workspace/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=app:app /workspace/services/foundry-service/package.json ./services/foundry-service/package.json
COPY --from=build --chown=app:app /workspace/services/foundry-service/node_modules ./services/foundry-service/node_modules
COPY --from=build --chown=app:app /workspace/services/foundry-service/dist ./services/foundry-service/dist

WORKDIR /workspace/services/foundry-service
USER app
EXPOSE 8200
CMD ["node", "dist/server.js"]
