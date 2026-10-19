FROM node:24-bookworm-slim AS build

ARG APP_NAME
WORKDIR /workspace

COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN test -n "$APP_NAME" \
  && npx nest build "$APP_NAME" \
  && test -f "dist/apps/$APP_NAME/main.js"

FROM node:24-bookworm-slim AS runtime

ARG APP_NAME
ENV APP_NAME=${APP_NAME}
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /workspace/dist/apps/${APP_NAME}/ ./dist/apps/${APP_NAME}/
COPY --from=build /workspace/contracts ./contracts

USER node
CMD ["sh", "-c", "exec node dist/apps/${APP_NAME}/main.js"]
