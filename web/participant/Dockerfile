FROM nginxinc/nginx-unprivileged:1.31.7-alpine-slim@sha256:a8cb0f33d51fa107c96fd2bd3a71aaf564ec131e9d2bdf8700944f0ed8b170d7

LABEL org.opencontainers.image.title="MyOTA Web" \
      org.opencontainers.image.source="https://github.com/myota-platform/myota" \
      org.opencontainers.image.description="Static MyOTA participant web client"

COPY --chown=101:101 web/ /usr/share/nginx/html/

EXPOSE 8080
USER 101
