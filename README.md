# Distributed Wagering Processor

[![CI](https://github.com/MuriloFA29/Technical-Challenge---Distributed-Wagering-Processor/actions/workflows/ci.yml/badge.svg)](https://github.com/MuriloFA29/Technical-Challenge---Distributed-Wagering-Processor/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-1.2-000000?logo=bun&logoColor=white)](https://bun.sh/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

> **Language:** English | [Português (Brasil)](./README.pt-BR.md)

A fault-tolerant, transactional **Distributed Wagering & Wallet Ledger Processor** designed for high-concurrency iGaming and financial workloads. Built with **Domain-Driven Design (DDD)**, **Hexagonal Architecture (Ports & Adapters)**, and **Event-Driven Architecture (EDA)** on **Bun 1.2**, **NestJS 10**, **MikroORM 6**, **PostgreSQL 16**, and **AWS SQS FIFO**.

---

## Engineering Highlights

- **Zero-Drift Wallet Concurrency**: Per-wallet serialization using PostgreSQL pessimistic row locking (`SELECT ... FOR UPDATE` via `LockMode.PESSIMISTIC_WRITE`) with `SET LOCAL lock_timeout = '5000ms'`, allowing distinct wallets to process in parallel without distributed Redis locks.
- **Database-Enforced Ledger Immutability**: Append-only `wallet_ledger_entries` table protected by a PostgreSQL `BEFORE UPDATE OR DELETE` trigger (`trg_prevent_ledger_update_or_delete`), `CHECK` constraints (`chk_wallet_balance_non_negative`, `chk_ledger_math`), and a partial unique index (`idx_unique_reversal`) preventing double refunds/rollbacks.
- **Transactional Outbox, Inbox & Out-of-Order Recovery**: Guarantees *at-least-once* event delivery and idempotent SQS FIFO consumption using `FOR UPDATE SKIP LOCKED` (`LockMode.PESSIMISTIC_PARTIAL_WRITE`) in both `OutboxPublisherWorker` (3-phase lease-claim/publish/ack) and `PendingReferenceWorker` (in-place out-of-order `REFUND`/`ROLLBACK` resolution).
- **Exact Decimal Money & Canonical Idempotency**: Arbitrary-precision `Money` Value Object (`decimal.js`, precision 28, `ROUND_HALF_UP`, 2 decimal places) paired with recursive key-sorted canonical JSON SHA-256 `payloadHash` verification (`idempotentReplay: true` with historical `observedBalance`, or `409 IDEMPOTENCY_CONFLICT`).
- **Production Observability & API Docs**: Structured Pino JSON logs with `X-Correlation-Id` propagation, 7 Prometheus metrics at `/metrics`, Kubernetes-ready `/health/live` and `/health/ready` probes, and interactive OpenAPI/Swagger UI at `/docs`.

---

## Tech Stack

| Layer | Technology |
| :--- | :--- |
| **Runtime & Language** | Bun 1.2, TypeScript 5.7 (strict mode) |
| **Application Framework** | NestJS 10.4, `class-validator`, `@nestjs/swagger` 7 |
| **Persistence & ORM** | PostgreSQL 16, MikroORM 6.4 (Unit of Work + Identity Map) |
| **Messaging** | AWS SQS FIFO (`@aws-sdk/client-sqs`), LocalStack 3.8 |
| **Financial Precision** | `decimal.js` 10.5 |
| **Observability** | Pino 9.6, `prom-client` 15.1 |
| **Quality & Tooling** | Biome 2.6, Bun Test, Docker & Docker Compose, GitHub Actions |

---

## Quickstart

### Prerequisites
- **Docker** and **Docker Compose**
- **Bun 1.2+** (for local development, tests, and load testing)

### 1. Run the Full Stack with Docker Compose

Starts PostgreSQL 16, LocalStack SQS (auto-provisioned with FIFO queues + DLQ), and the NestJS application:

```bash
make up
# or: docker compose up -d --build
```

Available endpoints once running:
- **API Base URL**: `http://localhost:3000`
- **Swagger UI**: `http://localhost:3000/docs` (OpenAPI JSON at `http://localhost:3000/docs-json`)
- **Prometheus Metrics**: `http://localhost:3000/metrics`
- **Health Probes**: `http://localhost:3000/health/live` and `http://localhost:3000/health/ready`
- **PostgreSQL**: `localhost:5432` (`wagering_db`)
- **LocalStack SQS**: `localhost:4566`

### 2. Local Development with Bun

```bash
# Install dependencies (frozen lockfile)
make install

# Start only infrastructure services (PostgreSQL + LocalStack)
docker compose up -d postgres localstack

# Copy environment variables if needed
cp .env.example .env

# Run the application in watch mode
bun run start:dev
```

### Makefile Commands

| Command | Description |
| :--- | :--- |
| `make up` | Build and start all containers (`docker compose up -d --build`) |
| `make down` | Stop and remove containers (`docker compose down`) |
| `make logs` | Tail container logs (`docker compose logs -f`) |
| `make install` | Install dependencies with `bun install --frozen-lockfile` |
| `make typecheck` | Run TypeScript compiler check (`tsc --noEmit`) |
| `make lint` | Run Biome lint & format checks |
| `make build` | Compile TypeScript build (`tsc`) |
| `make test` | Run all Bun test suites |
| `make test-unit` | Run unit tests (`test/unit`) |
| `make test-concurrency` | Run concurrency tests (`test/concurrency`) |
| `make load-test` | Execute the concurrent HTTP load test (`scripts/load-test.ts`) |

---

## HTTP API Reference

Interactive documentation is available at **`GET /docs`** (Swagger UI) and **`GET /docs-json`**.

### Request Headers & Error Format
- **`x-provider-id`** *(optional, defaults to `"provider-a"`)*: Provider identity header validated by `AuthGuard` against `body.providerId` or `:providerId`.
- **`Idempotency-Key`** *(optional on `POST /wagering/transactions`)*: Defaults to `${providerId}:${externalTransactionId}`.
- **`X-Correlation-Id`** *(optional)*: Propagated across HTTP responses, Pino logs, and outbound `IntegrationEvent` envelopes.
- **Standard Error Shape**:
  ```json
  {
    "statusCode": 409,
    "errorCode": "IDEMPOTENCY_CONFLICT",
    "message": "Idempotency key already used with a different payload",
    "timestamp": "2026-11-12T21:00:00.000Z"
  }
  ```

### Endpoints

| Method | Path | Status Codes | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/wallets` | `201`, `400`, `409`, `422` | Create a player wallet (`WALLET_ALREADY_EXISTS` on duplicate `(playerId, currency)`) |
| `GET` | `/wallets/:walletId` | `200`, `404` | Retrieve wallet details and current balance |
| `GET` | `/wallets/:walletId/ledger` | `200`, `404` | Paginated ledger statement (`?cursor=...&limit=...`, default `50`, clamped `1..100`) |
| `POST` | `/wallets/:walletId/reconciliation` | `200`, `404` | Reconcile stored balance against SQL `SUM`/`COUNT` inside `PESSIMISTIC_READ` tx |
| `POST` | `/wagering/transactions` | `200`, `400`, `403`, `404`, `409` | Process `BET`, `WIN`, `LOSS`, `REFUND`, or `ROLLBACK` (`OPENING` rejected with `400 INVALID_TRANSACTION_KIND`) |
| `GET` | `/wagering/transactions/:transactionId` | `200`, `404` | Fetch transaction by internal UUID |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | `200`, `403`, `404` | Fetch transaction by provider & external transaction ID |
| `GET` | `/health/live` | `200` | Liveness probe (`{ status: "UP", timestamp }`) |
| `GET` | `/health/ready` | `200`, `503` | Readiness probe checking PostgreSQL (`SELECT 1`) and SQS (`ListQueuesCommand`) |
| `GET` | `/metrics` | `200` | Prometheus exposition format (`text/plain; version=0.0.4; charset=utf-8`) |

### Example Requests

**1. Create Wallet (`POST /wallets`)**
```json
{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "1000.00", "currency": "BRL" }
}
```

**2. Submit Wager Transaction (`POST /wagering/transactions`)**
```json
{
  "providerId": "provider-a",
  "externalTransactionId": "tx-100",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "roundId": "round-987",
  "gameId": "fortune-tiger",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```

---

## SQS FIFO Messaging

LocalStack provisions three FIFO queues at startup (`docker/localstack-init/init-sqs.sh`):
- **Inbound**: `wager-transactions.fifo` (with `RedrivePolicy` `maxReceiveCount=5` routing poison messages to DLQ)
- **Dead-Letter Queue**: `wager-transactions-dlq.fifo`
- **Outbound Events**: `wager-events.fifo` (published by `OutboxPublisherWorker` with `MessageGroupId = aggregateId` (`walletId`) and `MessageDeduplicationId = outboxMessage.id`)

### Inbound SQS Payload
Supports direct payloads or a `{ "data": { ... } }` envelope:
```json
{
  "providerId": "provider-a",
  "externalTransactionId": "tx-101",
  "idempotencyKey": "provider-a:tx-101",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "roundId": "round-987",
  "gameId": "fortune-tiger",
  "kind": "REFUND",
  "money": { "amount": "25.00", "currency": "BRL" },
  "referenceExternalTransactionId": "tx-100"
}
```

### Outbound `IntegrationEvent` Envelope
Event types emitted to `wager-events.fifo`: `WalletBalanceChanged`, `WagerTransactionProcessed`, `WagerTransactionRejected`, and `WagerTransactionPendingReference`.
```json
{
  "eventId": "019320a1-7c2b-7000-8000-000000000001",
  "eventType": "WagerTransactionProcessed",
  "aggregateId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "correlationId": "corr-123e4567",
  "causationId": "019320a1-7c2b-7000-8000-000000000000",
  "occurredAt": "2026-11-12T21:00:00.000Z",
  "version": 1,
  "data": {
    "transactionId": "019320a1-7c2b-7000-8000-000000000000",
    "status": "PROCESSED"
  }
}
```

---

## Observability & Prometheus Metrics

`GET /metrics` exposes 7 instrumented metrics via `prom-client`:

| Metric | Type | Labels | Description |
| :--- | :--- | :--- | :--- |
| `wagering_transactions_total` | Counter | `kind`, `status`, `provider_id` | Total wager transactions processed by kind, status, and provider |
| `wagering_duplicate_transactions_total` | Counter | `provider_id` | Total idempotent replays detected |
| `wagering_message_retries_total` | Counter | `worker_name` | Retry attempts executed by background workers |
| `wagering_dlq_messages_total` | Counter | — | Messages routed or flagged for DLQ handling |
| `wagering_lock_conflicts_total` | Counter | — | PostgreSQL lock timeout / conflict occurrences |
| `wagering_outbox_lag_messages` | Gauge | — | Current count of unpublished `outbox_messages` |
| `wagering_transaction_duration_seconds` | Histogram | `kind`, `status` | Transaction latency (`[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5]`s) |

---

## Testing & Load Testing

```bash
# Unit tests (domain, value objects, use cases, metrics)
make test-unit

# Concurrency & race-condition tests
make test-concurrency

# Full test suite
make test
```

### Load Test & Integrity Verification
With the application running (`make up` or `bun run start:dev`), execute:
```bash
make load-test
# or: bun run test:load
```
`scripts/load-test.ts` provisions a `10,000.00 BRL` wallet, fires **200 concurrent `BET` requests** (`10.00 BRL` each, concurrency `20`), reports **Throughput (`req/s`)**, **Success/Failure/Error Rate**, and **Mean / p50 / p95 / p99 latency**, and then invokes `POST /wallets/:walletId/reconciliation` to verify **0.00 BRL drift** between the stored wallet balance and the immutable ledger sum.

---

## Architecture & Decision Records

Detailed system diagrams, concurrency mechanics, database triggers, and trade-off analyses are documented in:
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — System architecture, Mermaid sequence & state diagrams, locking, outbox/inbox, and observability.
- **[ADR 001: MikroORM & Pessimistic Row Locking](./docs/adr/001-mikroorm-pessimistic-locking.md)**
- **[ADR 002: PostgreSQL Ledger Immutability & Structural Constraints](./docs/adr/002-postgresql-ledger-immutability.md)**
- **[ADR 003: Transactional Outbox, Inbox & `SKIP LOCKED` Workers](./docs/adr/003-transactional-outbox-and-inbox.md)**
- **[ADR 004: Arbitrary-Precision `Money` & Canonical SHA-256 Idempotency](./docs/adr/004-decimal-money-and-idempotent-replay.md)**

---

## License

This project is licensed under the [MIT License](./LICENSE).
