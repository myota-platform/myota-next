FROM node:26-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS build
WORKDIR /app/web/admin
COPY web/admin/package*.json ./
RUN npm ci
COPY web/admin/ ./
COPY contracts/award-definition.ts /app/contracts/award-definition.ts
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.31.7-alpine-slim@sha256:a8cb0f33d51fa107c96fd2bd3a71aaf564ec131e9d2bdf8700944f0ed8b170d7
ENV MYOTA_GATEWAY_UPSTREAM=gateway:8080
ENV MYOTA_GRAFANA_UPSTREAM=grafana:3000
ENV NGINX_ENVSUBST_FILTER=^(MYOTA_GATEWAY_UPSTREAM|MYOTA_GRAFANA_UPSTREAM|MYOTA_DNS_RESOLVER)$
COPY web/admin/nginx.conf /etc/nginx/templates/default.conf.template
COPY web/admin/05-dns-resolver.envsh /docker-entrypoint.d/05-dns-resolver.envsh
COPY --from=build /app/web/admin/dist /usr/share/nginx/html
EXPOSE 8080
USER 101
