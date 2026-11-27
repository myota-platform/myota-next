FROM --platform=$BUILDPLATFORM golang:1.27.4-alpine3.24@sha256:70bd7ddea8b6cbe5d6943cde279d6b67feb10cc924fb9100d1d8757c1575b280 AS gosu-build
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

FROM postgres:19-alpine3.24@sha256:cac45fb483caee3668946088a1c0532db89d5285c28dbfeac889b4068296e06f AS postgres
COPY --from=gosu-build --chmod=0755 /out/gosu /usr/local/bin/gosu
COPY --chmod=0555 deploy/images/database/020-create-app-role.sh /docker-entrypoint-initdb.d/020-create-app-role.sh

FROM postgis/postgis:18-3.6-alpine@sha256:c53a483fc274072dfa02cd491efa79f3c8ae0a10774a0ece6c9c53b6a632cdef AS postgis
COPY --from=gosu-build --chmod=0755 /out/gosu /usr/local/bin/gosu
COPY --chmod=0555 deploy/images/database/020-create-app-role.sh /docker-entrypoint-initdb.d/020-create-app-role.sh
RUN apk add --no-cache --upgrade \
    brotli-libs=1.2.1-r0 \
    curl=8.23.0-r0 \
    libcurl=8.23.0-r0
