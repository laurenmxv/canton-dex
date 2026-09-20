.PHONY: test docker-run docker-stop status logs test-backend prepare-localnet

test:
	@./scripts/test-contracts.sh

docker-run:
	@docker compose build contract-bootstrap frontend
	@docker compose up -d --wait --wait-timeout 1200 frontend
	@docker compose run --rm --no-deps \
		-v ./docker/bootstrap.env:/app/keycloak.env:ro \
		-e DEX_KEYCLOAK_URL=http://keycloak:8082 \
		frontend node --env-file=/app/keycloak.env scripts/provision-keycloak.mjs
	@printf '\nFrontend: http://localhost:5180\nBackend: http://localhost:18080\nKeycloak: http://localhost:18082\n'

docker-stop:
	@docker compose down

status:
	@docker compose ps

logs:
	@docker compose logs --tail=100 -f frontend backend contract-bootstrap

test-backend:
	@./scripts/test-backend.sh all

LOCALNET_ARCHIVE := docker/artifacts/cn-localnet-v0.1.0.tar.gz
LOCALNET_DIR := .deps/cn-localnet

docker-run docker-stop status logs: prepare-localnet

prepare-localnet: $(LOCALNET_DIR)/.prepared

$(LOCALNET_DIR)/.prepared: $(LOCALNET_ARCHIVE)
	@mkdir -p "$(LOCALNET_DIR)"
	@tar -xzf "$<" -C "$(LOCALNET_DIR)"
	@touch "$@"
