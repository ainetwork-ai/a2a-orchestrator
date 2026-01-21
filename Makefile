.PHONY: dev dev-up dev-down dev-build dev-logs prod prod-up prod-down prod-build prod-logs

# Development environment (includes Redis)
dev:
	docker compose -f docker-compose.dev.yml up -d

dev-up:
	docker compose -f docker-compose.dev.yml up -d

dev-down:
	docker compose -f docker-compose.dev.yml down

dev-build:
	docker compose -f docker-compose.dev.yml up -d --build

dev-logs:
	docker compose -f docker-compose.dev.yml logs -f

# Production environment (uses external Redis)
prod:
	docker compose -f docker-compose.prod.yml up -d

prod-up:
	docker compose -f docker-compose.prod.yml up -d

prod-down:
	docker compose -f docker-compose.prod.yml down

prod-build:
	docker compose -f docker-compose.prod.yml up -d --build

prod-logs:
	docker compose -f docker-compose.prod.yml logs -f
