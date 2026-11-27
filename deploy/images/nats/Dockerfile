FROM --platform=$BUILDPLATFORM golang:1.27.4-alpine3.24@sha256:70bd7ddea8b6cbe5d6943cde279d6b67feb10cc924fb9100d1d8757c1575b280 AS nats-build
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

FROM nats:2.15.3-alpine3.22@sha256:558394a23dd3c36f2d3a64b51865fd09908010e80a542cea5e75c2af543ed62a
COPY --from=nats-build --chmod=0755 /out/nats-server /usr/local/bin/nats-server
