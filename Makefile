.PHONY: test docker-run docker-stop docker-reset status logs test-backend prepare-localnet

COMPOSE := docker compose -f docker/compose.dev.yaml

test:
	@./scripts/test-contracts.sh

docker-run:
	@$(COMPOSE) build contract-builder backend frontend
	@$(COMPOSE) up -d --wait --wait-timeout 1200 frontend
	@$(COMPOSE) run --rm --no-deps \
		-v "$(CURDIR)/docker/env/bootstrap.env":/app/keycloak.env:ro \
		-e DEX_KEYCLOAK_URL=http://keycloak:8082 \
		frontend node --env-file=/app/keycloak.env scripts/provision-keycloak.mjs
	@printf '\nFrontend: http://localhost:5180\nBackend: http://localhost:18080\nKeycloak: http://localhost:18082\n'

docker-stop:
	@$(COMPOSE) down

docker-reset:
	@./scripts/dex-reset.sh

status:
	@$(COMPOSE) ps

logs:
	@$(COMPOSE) logs --tail=100 -f frontend backend contract-builder

test-backend:
	@./scripts/test-backend.sh all

LOCALNET_VERSION := v0.3.0
LOCALNET_SHA256 := 5fcc0f5f55aaa298fa29d6571abe5038a1ad0c84d771c5d0274621d5e91897cf
LOCALNET_ARCHIVE := docker/artifacts/cn-localnet-$(LOCALNET_VERSION).tar.gz
LOCALNET_DIR := .deps/cn-localnet

docker-run docker-stop status logs: prepare-localnet

prepare-localnet:
	@./scripts/prepare-localnet.sh "$(LOCALNET_ARCHIVE)" "$(LOCALNET_SHA256)" "$(LOCALNET_DIR)"
