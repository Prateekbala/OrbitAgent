FROM node:24-alpine AS api
WORKDIR /app
RUN npm install --global npm@12.2.1
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
RUN npm ci --omit=dev --ignore-scripts --workspace @ao/api --workspace @ao/contracts --workspace @ao/database
COPY apps/api/src apps/api/src
COPY packages/contracts/src packages/contracts/src
COPY packages/database/src packages/database/src
COPY packages/database/migrations packages/database/migrations
COPY scripts/operations/entrypoint.mjs scripts/operations/entrypoint.mjs
RUN mkdir -p /app/.data/uploads /app/.data/files && chown -R node:node /app
USER node
ENV NODE_ENV=production API_HOST=0.0.0.0
CMD ["node","scripts/operations/entrypoint.mjs","apps/api/src/server.ts"]

FROM node:24-alpine AS web-build
WORKDIR /app
RUN npm install --global npm@12.2.1
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci --ignore-scripts --workspace @ao/web --workspace @ao/contracts --include-workspace-root
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/web apps/web
ENV API_INTERNAL_URL=http://api:4000 NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w @ao/web

FROM node:24-alpine AS web
WORKDIR /app
RUN npm install --global npm@12.2.1
COPY --from=web-build --chown=node:node /app /app
USER node
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
EXPOSE 3000
CMD ["npm","run","start","-w","@ao/web","--","--hostname","0.0.0.0"]
