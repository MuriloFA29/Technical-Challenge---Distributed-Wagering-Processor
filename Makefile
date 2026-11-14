.PHONY: install up down logs typecheck lint test test-unit test-concurrency load-test build

install:
	bun install --frozen-lockfile

up:
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f

typecheck:
	bun run typecheck

lint:
	bun run lint

test:
	bun test

test-unit:
	bun run test:unit

test-concurrency:
	bun run test:concurrency

load-test:
	bun run test:load

build:
	bun run build
