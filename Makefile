.PHONY: test docker-run docker-stop status logs test-backend

test:
	@./scripts/test-contracts.sh

docker-run:
	@if ! docker image inspect canton-dex-tools:3.5.7-java21 >/dev/null 2>&1; then \
		docker compose build contract-bootstrap; \
	fi
	@docker compose build frontend
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

LOCALNET_VERSION := v0.1.0
LOCALNET_SHA256 := 68589de6ee411ea50d5621ad716baff3de64a5e0c1609b1d5c845acbef25753c
LOCALNET_URL := https://github.com/raynaudoe/cn-quickstart/releases/download/localnet-$(LOCALNET_VERSION)/cn-localnet-$(LOCALNET_VERSION).tar.gz
LOCALNET_DIR := .deps/cn-localnet

.PHONY: fetch-localnet
docker-run docker-stop status logs test-backend: fetch-localnet

fetch-localnet:
	@set -eu; \
	if [ -f "$(LOCALNET_DIR)/.sha256-$(LOCALNET_SHA256)" ] && [ -f "$(LOCALNET_DIR)/infra/compose.yaml" ]; then exit 0; fi; \
	mkdir -p .deps; \
	work=$$(mktemp -d .deps/.cn-localnet.XXXXXX); \
	trap 'rm -rf "$$work"' EXIT HUP INT TERM; \
	printf 'Downloading LocalNet %s\n' '$(LOCALNET_VERSION)'; \
	curl --fail --location --retry 3 --connect-timeout 15 --max-time 120 --proto '=https' \
		'$(LOCALNET_URL)' --output "$$work/bundle.tar.gz"; \
	if command -v sha256sum >/dev/null 2>&1; then \
		digest=$$(sha256sum "$$work/bundle.tar.gz"); \
	else \
		digest=$$(shasum -a 256 "$$work/bundle.tar.gz"); \
	fi; \
	[ "$${digest%% *}" = '$(LOCALNET_SHA256)' ] || { printf 'LocalNet checksum mismatch\n' >&2; exit 1; }; \
	mkdir "$$work/extracted"; \
	tar -xzf "$$work/bundle.tar.gz" -C "$$work/extracted"; \
	test -f "$$work/extracted/infra/compose.yaml"; \
	test -f "$$work/extracted/manifest.json"; \
	touch "$$work/extracted/.sha256-$(LOCALNET_SHA256)"; \
	rm -rf "$(LOCALNET_DIR)"; \
	mv "$$work/extracted" "$(LOCALNET_DIR)"
