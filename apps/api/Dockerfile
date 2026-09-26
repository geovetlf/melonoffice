# Build from the repository root: docker build -f apps/api/Dockerfile .
FROM node:22-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm turbo run build --filter=@melonoffice/api... \
  && pnpm --filter=@melonoffice/api deploy --prod --legacy /out

FROM node:22-slim
ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app
COPY --from=build /out .
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
