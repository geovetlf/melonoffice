# Build from the repository root: docker build -f apps/worker/Dockerfile .
FROM node:22-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm turbo run build --filter=@melonoffice/worker... \
  && pnpm --filter=@melonoffice/worker deploy --prod --legacy /out

FROM node:22-slim
# The commit being deployed, reported by GET /health. CD passes it with --build-arg.
ARG SERVICE_VERSION=dev
ENV SERVICE_VERSION=$SERVICE_VERSION
ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app
COPY --from=build /out .
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
