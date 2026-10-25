FROM --platform=$BUILDPLATFORM golang:1.26.10-alpine3.24@sha256:27f2d3b83cfc5803c8078f8e730af0f7c431bf067afaec8f60a36fb763187cba AS gosu-build
ARG TARGETOS
ARG TARGETARCH
ARG GOSU_COMMIT=29b939aa5bd4dc588af765b8248f6e39150d2565
RUN apk add --no-cache git
RUN git init /src/gosu \
    && git -C /src/gosu remote add origin https://github.com/tianon/gosu.git \
    && git -C /src/gosu fetch --depth 1 origin "$GOSU_COMMIT" \
    && git -C /src/gosu checkout --detach FETCH_HEAD \
    && test "$(git -C /src/gosu rev-parse HEAD)" = "$GOSU_COMMIT"
WORKDIR /src/gosu
RUN mkdir -p /out \
    && CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" \
    go build -trimpath -buildvcs=false -ldflags='-s -w' -o /out/gosu .

FROM postgres:16-alpine3.24@sha256:f4610795587492cd4fb887c2dc3de301b813278bb6f616992061141b5f15ac36 AS postgres
COPY --from=gosu-build --chmod=0755 /out/gosu /usr/local/bin/gosu
COPY --chmod=0555 deploy/images/database/020-create-app-role.sh /docker-entrypoint-initdb.d/020-create-app-role.sh

FROM postgis/postgis:16-3.6-alpine@sha256:a8ae5aac22bfe4b734c1fa0644ca18039a1e6bd7105c5aa9308cd24bfa1b2ef7 AS postgis
COPY --from=gosu-build --chmod=0755 /out/gosu /usr/local/bin/gosu
COPY --chmod=0555 deploy/images/database/020-create-app-role.sh /docker-entrypoint-initdb.d/020-create-app-role.sh
RUN apk add --no-cache --upgrade brotli-libs=1.2.1-r0
