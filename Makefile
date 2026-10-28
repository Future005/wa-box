# Shortcuts for running WA Box on your own computer. Needs Docker.
# Windows without make: use the commands after each target, or scripts/setup.ps1.
COMPOSE = docker compose -f docker-compose.local.yml

.PHONY: help setup up down logs password status test update reset

help:            ## Show these commands
	@grep -E '^[a-z]+:.*## ' Makefile | awk -F':.*## ' '{printf "  make %-10s %s\n", $$1, $$2}'

setup:           ## Make .env with fresh secrets, build, start, and print the sign-in details
	@sh scripts/setup.sh

up:              ## Build (runs the safety tests) and start
	$(COMPOSE) up -d --build
	@echo "WA Box: http://localhost:$${PORT:-3000}"

down:            ## Stop (keeps your data and WhatsApp login)
	$(COMPOSE) down

logs:            ## Follow the logs
	$(COMPOSE) logs -f --tail=100

password:        ## Show the first admin's one-time password (first start only)
	@$(COMPOSE) logs wabox 2>/dev/null | grep -E "Username:|One-time password" | tail -2 || echo "No one-time password: ADMIN_PASSWORD was set in .env"

status:          ## Are both parts running and healthy?
	$(COMPOSE) ps
	@curl -fsS http://localhost:$${PORT:-3000}/health/monitor && echo || echo "Not answering yet"

test:            ## Run every safety test without Docker (needs Node 22)
	cd app && npm ci && npm test
	cd engine && npm ci && npm test

update:          ## Pull the latest code and rebuild
	git pull --ff-only
	$(COMPOSE) up -d --build

reset:           ## DELETE all local data, including the WhatsApp login
	@printf "This deletes every message, user and the WhatsApp login of this local copy. Type DELETE to continue: "; read a; [ "$$a" = "DELETE" ]
	$(COMPOSE) down -v
