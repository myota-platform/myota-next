FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.30.6-alpine-slim@sha256:5d8bb9437d74a600ec5dbf90c035451c724dc33eac8d3a71078f6f8612c345f6
ENV MYOTA_GATEWAY_UPSTREAM=gateway:8080
ENV MYOTA_GRAFANA_UPSTREAM=grafana:3000
ENV NGINX_ENVSUBST_FILTER=^(MYOTA_GATEWAY_UPSTREAM|MYOTA_GRAFANA_UPSTREAM|MYOTA_DNS_RESOLVER)$
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY 05-dns-resolver.envsh /docker-entrypoint.d/05-dns-resolver.envsh
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
USER 101
