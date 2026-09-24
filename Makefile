.PHONY: test docker-run docker-stop docker-reset status logs test-backend prepare-localnet

test:
	@./scripts/test-contracts.sh

docker-run:
	@docker compose build contract-builder backend frontend
	@docker compose up -d --wait --wait-timeout 1200 frontend
	@docker compose run --rm --no-deps \
		-v ./docker/bootstrap.env:/app/keycloak.env:ro \
		-e DEX_KEYCLOAK_URL=http://keycloak:8082 \
		frontend node --env-file=/app/keycloak.env scripts/provision-keycloak.mjs
	@printf '\nFrontend: http://localhost:5180\nBackend: http://localhost:18080\nKeycloak: http://localhost:18082\n'

docker-stop:
	@docker compose down

docker-reset:
	@./scripts/dex-reset.sh

status:
	@docker compose ps

logs:
	@docker compose logs --tail=100 -f frontend backend contract-builder

test-backend:
	@./scripts/test-backend.sh all

LOCALNET_VERSION := v0.2.0
LOCALNET_SHA256 := 1f69385e1fe50eece22e01ee226abd3433b34d329acd4401cd1a32d63c056309
LOCALNET_ARCHIVE := docker/artifacts/cn-localnet-$(LOCALNET_VERSION).tar.gz
LOCALNET_DIR := .deps/cn-localnet

docker-run docker-stop status logs: prepare-localnet

prepare-localnet:
	@./scripts/prepare-localnet.sh "$(LOCALNET_ARCHIVE)" "$(LOCALNET_SHA256)" "$(LOCALNET_DIR)"
