FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
ENV MYOTA_GATEWAY_UPSTREAM=gateway:8080
ENV MYOTA_GRAFANA_UPSTREAM=grafana:3000
ENV NGINX_ENVSUBST_FILTER=^(MYOTA_GATEWAY_UPSTREAM|MYOTA_GRAFANA_UPSTREAM|MYOTA_DNS_RESOLVER)$
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY 05-dns-resolver.envsh /docker-entrypoint.d/05-dns-resolver.envsh
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
