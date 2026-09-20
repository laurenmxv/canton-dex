FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553

# Compose mounts the local projects. Only Linux dependencies live in volumes.
RUN mkdir -p /app/client/node_modules /app/frontend/node_modules \
    && chown -R node:node /app
USER node
WORKDIR /app/frontend

EXPOSE 5180 4040
CMD ["sh", "-c", "npm --prefix ../client ci --no-audit --no-fund && npm ci --no-audit --no-fund && exec npm run dev:keycloak -- --host 0.0.0.0"]
