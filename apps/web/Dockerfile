# Build from the repository root: docker build -f apps/web/Dockerfile .
FROM node:22-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm turbo run build --filter=@melonoffice/web...

# Static files only: an unprivileged nginx listening on 8080, as Cloud Run expects.
FROM nginxinc/nginx-unprivileged:1.29-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
