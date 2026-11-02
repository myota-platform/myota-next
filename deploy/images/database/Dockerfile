FROM --platform=$BUILDPLATFORM golang:1.27.3-alpine3.24@sha256:d200d2dd76b03a99b52651fd1325aff7dcd35422c35c01bac56571b0507f3deb AS gosu-build
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

FROM postgres:18-alpine3.24@sha256:10a5c69a83035ab5239f5620d708520e8b28f5aa1f2b20143e6024532edadfb5 AS postgres
COPY --from=gosu-build --chmod=0755 /out/gosu /usr/local/bin/gosu
COPY --chmod=0555 deploy/images/database/020-create-app-role.sh /docker-entrypoint-initdb.d/020-create-app-role.sh

FROM postgis/postgis:18-3.6-alpine@sha256:c53a483fc274072dfa02cd491efa79f3c8ae0a10774a0ece6c9c53b6a632cdef AS postgis
COPY --from=gosu-build --chmod=0755 /out/gosu /usr/local/bin/gosu
COPY --chmod=0555 deploy/images/database/020-create-app-role.sh /docker-entrypoint-initdb.d/020-create-app-role.sh
RUN apk add --no-cache --upgrade \
    brotli-libs=1.2.1-r0 \
    curl=8.23.0-r0 \
    libcurl=8.23.0-r0
