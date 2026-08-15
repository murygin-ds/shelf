SHELL := /bin/bash
.DEFAULT_GOAL := help

ifneq (,$(wildcard ./.env))
include .env
export
endif

APP_NAME	   ?= shelf-backend
MAIN_PKG	   := ./cmd/server
BIN_DIR		:= bin
BIN			:= $(BIN_DIR)/$(APP_NAME)
MIGRATIONS_DIR := migrations
DOCS_DIR	   := docs
COVERAGE_FILE  := coverage.out
WEB_DIR		:= web
WEB_DIST	   := internal/web/dist

GO			 ?= go
NPM			?= npm
MIGRATE		?= migrate
SWAG		   ?= swag
GOLANGCI_LINT  ?= golangci-lint
DOCKER_COMPOSE ?= docker compose

# Default if env not exists
SHELF_POSTGRES_HOST	 ?= localhost
SHELF_POSTGRES_PORT	 ?= 5432
SHELF_POSTGRES_USER	 ?= postgres
SHELF_POSTGRES_PASSWORD ?= postgres
SHELF_POSTGRES_DATABASE ?= shelf
SHELF_POSTGRES_SSL_MODE ?= disable

DB_URL ?= postgres://$(SHELF_POSTGRES_USER):$(SHELF_POSTGRES_PASSWORD)@$(SHELF_POSTGRES_HOST):$(SHELF_POSTGRES_PORT)/$(SHELF_POSTGRES_DATABASE)?sslmode=$(SHELF_POSTGRES_SSL_MODE)

.PHONY: help
help: ## Show commands list
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| sort \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

# Dev

.PHONY: env
env: ## Create .env from .env.example
	@test -f .env && echo ".env already exists" || (cp .env.example .env && echo ".env created")

.PHONY: run
run: ## Start local
	$(GO) run $(MAIN_PKG)

.PHONY: build
build: web ## Build the frontend and the binary to the bin
	@mkdir -p $(BIN_DIR)
	CGO_ENABLED=0 $(GO) build -trimpath -ldflags "-s -w" -o $(BIN) $(MAIN_PKG)

.PHONY: clean
clean: ## Delete build artefacts
	@rm -rf $(BIN_DIR) $(COVERAGE_FILE) coverage.html
	@find $(WEB_DIST) -mindepth 1 ! -name .gitkeep -delete 2>/dev/null || true

# Frontend

.PHONY: web-install
web-install: ## Install frontend dependencies
	cd $(WEB_DIR) && $(NPM) ci

.PHONY: web
web: ## Build the frontend into internal/web/dist (embedded into the binary)
	cd $(WEB_DIR) && $(NPM) run build
	@touch $(WEB_DIST)/.gitkeep

.PHONY: web-dev
web-dev: ## Start the Vite dev server on :5173, proxying /api to :8080
	cd $(WEB_DIR) && $(NPM) run dev

.PHONY: web-test
web-test: ## Frontend tests
	cd $(WEB_DIR) && $(NPM) run test

.PHONY: web-typecheck
web-typecheck: ## Frontend type check
	cd $(WEB_DIR) && $(NPM) run typecheck

.PHONY: tidy
tidy: ## Tidy
	$(GO) mod tidy

.PHONY: fmt
fmt: ## Format code
	$(GO) fmt ./...

.PHONY: vet
vet: ## Vet
	$(GO) vet ./...

.PHONY: lint
lint: ## Start golangci-lint
	@command -v $(GOLANGCI_LINT) >/dev/null || { echo "golangci-lint not install: make tools"; exit 1; }
	$(GOLANGCI_LINT) run ./...

.PHONY: lint-fix
lint-fix: ## Start golangci-lint with auto format
	@command -v $(GOLANGCI_LINT) >/dev/null || { echo "golangci-lint not install: make tools"; exit 1; }
	$(GOLANGCI_LINT) run --fix ./...

.PHONY: test
test: ## Tests
	$(GO) test -race -count=1 ./...

.PHONY: test-cover
test-cover: ## Tests with coverage report (coverage.html)
	$(GO) test -race -count=1 -coverprofile=$(COVERAGE_FILE) -covermode=atomic ./...
	$(GO) tool cover -html=$(COVERAGE_FILE) -o coverage.html
	@echo "report: coverage.html"

.PHONY: check
check: fmt vet lint test ## Full check

# Swagger

.PHONY: swagger
swagger: ## Build swagger-docs to docs/
	@command -v $(SWAG) >/dev/null || { echo "swag is not installed: make tools"; exit 1; }
	$(SWAG) init -g $(MAIN_PKG)/main.go -o $(DOCS_DIR) --parseInternal

.PHONY: swagger-check
swagger-check: ## Fail if docs/ is out of date with the annotations
	@command -v $(SWAG) >/dev/null || { echo "swag is not installed: make tools"; exit 1; }
	@$(SWAG) init -g $(MAIN_PKG)/main.go -o $(DOCS_DIR) --parseInternal >/dev/null
	@git diff --quiet -- $(DOCS_DIR) || { echo "$(DOCS_DIR)/ is stale: commit the result of make swagger"; exit 1; }

.PHONY: swagger-fmt
swagger-fmt: ## Format swagger-annotations
	@command -v $(SWAG) >/dev/null || { echo "swag is not installed: make tools"; exit 1; }
	$(SWAG) fmt
	$(GO) fmt ./...

# Migrations

.PHONY: migrate-create
migrate-create: ## Create migration: make migrate-create name=add_books
	@test -n "$(name)" || { echo "specify name: make migrate-create name=add_books"; exit 1; }
	$(MIGRATE) create -ext sql -dir $(MIGRATIONS_DIR) -seq $(name)

.PHONY: migrate-up
migrate-up: ## Apply all migrations
	$(MIGRATE) -path $(MIGRATIONS_DIR) -database "$(DB_URL)" up

.PHONY: migrate-down
migrate-down: ## Undo last migration
	$(MIGRATE) -path $(MIGRATIONS_DIR) -database "$(DB_URL)" down 1

.PHONY: migrate-down-all
migrate-down-all: ## Undo all migrations
	@read -p "Undo ALL migrations $(SHELF_POSTGRES_DATABASE)? [y/N] " ok; [ "$$ok" = "y" ] || exit 1
	$(MIGRATE) -path $(MIGRATIONS_DIR) -database "$(DB_URL)" down -all

.PHONY: migrate-version
migrate-version: ## Show current scheme
	$(MIGRATE) -path $(MIGRATIONS_DIR) -database "$(DB_URL)" version

.PHONY: migrate-force
migrate-force: ## Undo dirty-flag: make migrate-force version=1
	@test -n "$(version)" || { echo "specify version: make migrate-force version=1"; exit 1; }
	$(MIGRATE) -path $(MIGRATIONS_DIR) -database "$(DB_URL)" force $(version)

.PHONY: migrate-drop
migrate-drop: ## Delete all objects from Database
	@read -p "DELETE scheme $(SHELF_POSTGRES_DATABASE)? [y/N] " ok; [ "$$ok" = "y" ] || exit 1
	$(MIGRATE) -path $(MIGRATIONS_DIR) -database "$(DB_URL)" drop -f

# Docker

.PHONY: db-up
db-up: ## Up PostgreSQL in docker
	$(DOCKER_COMPOSE) up -d postgres

.PHONY: db-down
db-down: ## Stop PostgreSQL
	$(DOCKER_COMPOSE) down

.PHONY: db-reset
db-reset: ## Rebuild PostgreSQL with data
	@read -p "Delete PostgreSQL data and start over? [y/N] " ok; [ "$$ok" = "y" ] || exit 1
	$(DOCKER_COMPOSE) down -v
	$(DOCKER_COMPOSE) up -d postgres

.PHONY: db-logs
db-logs: ## Logs PostgreSQL
	$(DOCKER_COMPOSE) logs -f postgres

.PHONY: db-psql
db-psql: ## Open psql in container
	$(DOCKER_COMPOSE) exec postgres psql -U $(SHELF_POSTGRES_USER) -d $(SHELF_POSTGRES_DATABASE)

.PHONY: docker-build
docker-build: ## Build docker app
	docker build -t $(APP_NAME):latest .

.PHONY: docker-up
docker-up: ## Up app with database
	$(DOCKER_COMPOSE) --profile app up -d --build

# Tools

.PHONY: tools
tools: ## Install swag, migrate and golangci-lint
	$(GO) install github.com/swaggo/swag/cmd/swag@latest
	$(GO) install -tags 'postgres' github.com/golang-migrate/migrate/v4/cmd/migrate@latest
	$(GO) install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@latest
