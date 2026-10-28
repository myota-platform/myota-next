FROM --platform=$BUILDPLATFORM golang:1.27.3-alpine3.24@sha256:b8c9b82affbbb82a020bbcf998dad2ba9516944ac7e883524642a481a9505e9c AS nats-build
ARG TARGETOS
ARG TARGETARCH
ARG NATS_COMMIT=b2fd3efc7456b11b06a54877ad6f6ccfb911edb4
RUN apk add --no-cache git
RUN git init /src/nats-server \
    && git -C /src/nats-server remote add origin https://github.com/nats-io/nats-server.git \
    && git -C /src/nats-server fetch --depth 1 origin "$NATS_COMMIT" \
    && git -C /src/nats-server checkout --detach FETCH_HEAD \
    && test "$(git -C /src/nats-server rev-parse HEAD)" = "$NATS_COMMIT"
WORKDIR /src/nats-server
ENV GOTOOLCHAIN=local
RUN mkdir -p /out \
    && CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" \
    go build -trimpath -buildvcs=false -ldflags='-s -w' -o /out/nats-server .

FROM nats:2.15.1-alpine3.22@sha256:7ae34c25dfd6fe2e01c6483eabef20d796690fdcac6c4d94ca780a6cf9877fde
COPY --from=nats-build --chmod=0755 /out/nats-server /usr/local/bin/nats-server
