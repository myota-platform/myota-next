FROM --platform=$BUILDPLATFORM golang:1.27.3-alpine3.24@sha256:d200d2dd76b03a99b52651fd1325aff7dcd35422c35c01bac56571b0507f3deb AS nats-build
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

FROM nats:2.15.2-alpine3.22@sha256:823e7f1d6d8ffe3b30dbd73d4a06bbb939acf94929f7fdf224404da7a05bafb5
COPY --from=nats-build --chmod=0755 /out/nats-server /usr/local/bin/nats-server
