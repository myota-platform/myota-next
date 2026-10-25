FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build

ARG APP_NAME
WORKDIR /workspace

COPY package.json package-lock.json ./
COPY vendor/shapefile ./vendor/shapefile
RUN npm ci
COPY . .
RUN test -n "$APP_NAME" \
  && npx nest build "$APP_NAME" \
  && test -f "dist/apps/$APP_NAME/main.js"

FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS runtime

ARG APP_NAME
ENV APP_NAME=${APP_NAME}
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY vendor/shapefile ./vendor/shapefile
RUN npm ci --omit=dev \
  && npm cache clean --force \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
RUN if [ "$APP_NAME" = "geodata-worker" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends osmium-tool \
      && rm -rf /var/lib/apt/lists/*; \
    fi
COPY --from=build /workspace/dist/apps/${APP_NAME}/ ./dist/apps/${APP_NAME}/
COPY --from=build /workspace/contracts ./contracts
COPY --from=build /workspace/libs/geodata-domain/data/es_ign_SPED2ETV2.tif ./libs/geodata-domain/data/es_ign_SPED2ETV2.tif

USER node
CMD ["sh", "-c", "exec node dist/apps/${APP_NAME}/main.js"]
