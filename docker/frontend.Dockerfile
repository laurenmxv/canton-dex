FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553

WORKDIR /app/client
COPY client/package.json client/package-lock.json client/tsconfig.json client/tsconfig.build.json ./
COPY client/src ./src
RUN npm ci --no-audit --no-fund

WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run typecheck && chown -R node:node /app
USER node

EXPOSE 5180 4040
CMD ["npm", "run", "dev:keycloak", "--", "--host", "0.0.0.0"]
