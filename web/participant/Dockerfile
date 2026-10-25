FROM nginxinc/nginx-unprivileged:1.30.6-alpine-slim@sha256:5d8bb9437d74a600ec5dbf90c035451c724dc33eac8d3a71078f6f8612c345f6

LABEL org.opencontainers.image.title="MyOTA Web" \
      org.opencontainers.image.source="https://github.com/myota-platform/myota" \
      org.opencontainers.image.description="Static MyOTA participant web client"

COPY --chown=101:101 web/ /usr/share/nginx/html/

EXPOSE 8080
USER 101
