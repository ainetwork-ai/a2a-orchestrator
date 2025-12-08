.PHONY: dev dev-up dev-down dev-build dev-logs prod prod-up prod-down prod-build prod-logs

# Development environment
dev:
	docker compose --env-file .env.dev -f docker-compose.yml -f docker-compose.dev.yml up -d

dev-up:
	docker compose --env-file .env.dev -f docker-compose.yml -f docker-compose.dev.yml up -d

dev-down:
	docker compose --env-file .env.dev -f docker-compose.yml -f docker-compose.dev.yml down

dev-build:
	docker compose --env-file .env.dev -f docker-compose.yml -f docker-compose.dev.yml up -d --build

dev-build-backend:
	docker compose --env-file .env.dev -f docker-compose.yml -f docker-compose.dev.yml up -d --build backend

dev-logs:
	docker compose --env-file .env.dev -f docker-compose.yml -f docker-compose.dev.yml logs -f

# Production environment
prod:
	docker compose --env-file .env.prod -f docker-compose.yml -f docker-compose.prod.yml up -d

prod-up:
	docker compose --env-file .env.prod -f docker-compose.yml -f docker-compose.prod.yml up -d

prod-down:
	docker compose --env-file .env.prod -f docker-compose.yml -f docker-compose.prod.yml down

prod-build:
	docker compose --env-file .env.prod -f docker-compose.yml -f docker-compose.prod.yml up -d --build

prod-build-backend:
	docker compose --env-file .env.prod -f docker-compose.yml -f docker-compose.prod.yml up -d --build backend

prod-logs:
	docker compose --env-file .env.prod -f docker-compose.yml -f docker-compose.prod.yml logs -f
