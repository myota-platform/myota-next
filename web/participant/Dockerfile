FROM nginxinc/nginx-unprivileged:1.30.4-alpine-slim

LABEL org.opencontainers.image.title="MyOTA Web" \
      org.opencontainers.image.source="https://github.com/myota-platform/myota" \
      org.opencontainers.image.description="Static MyOTA participant web client"

COPY --chown=101:101 web/ /usr/share/nginx/html/

EXPOSE 8080
