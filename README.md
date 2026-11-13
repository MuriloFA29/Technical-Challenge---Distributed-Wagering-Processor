# Distributed Wagering Processor

[![CI](https://github.com/MuriloFA29/Technical-Challenge---Distributed-Wagering-Processor/actions/workflows/ci.yml/badge.svg)](https://github.com/MuriloFA29/Technical-Challenge---Distributed-Wagering-Processor/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-1.2-000000?logo=bun&logoColor=white)](https://bun.sh/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

> **Idioma:** Português (Brasil) | [English](./README.en.md)

Processador de apostas e ledger financeiro distribuído, transacional e tolerante a falhas, projetado para cenários de alta concorrência. Construído com **Domain-Driven Design (DDD)**, **Arquitetura Hexagonal (Ports & Adapters)** e **Arquitetura Orientada a Eventos (EDA)** sobre **Bun 1.2**, **NestJS 10**, **MikroORM 6**, **PostgreSQL 16** e **AWS SQS FIFO**.

---

## Destaques de Engenharia

- **Concorrência sem Divergência de Saldo**: Serialização por carteira via pessimistic row locking no PostgreSQL (`SELECT ... FOR UPDATE` com `LockMode.PESSIMISTIC_WRITE`) e `SET LOCAL lock_timeout = '5000ms'`, permitindo processamento paralelo entre carteiras distintas sem locks distribuídos em Redis.
- **Imutabilidade do Ledger Garantida pelo Banco**: Tabela `wallet_ledger_entries` append-only protegida por trigger `BEFORE UPDATE OR DELETE` (`trg_prevent_ledger_update_or_delete`), constraints `CHECK` (`chk_wallet_balance_non_negative`, `chk_ledger_math`) e índice único parcial (`idx_unique_reversal`) contra dupla reversão.
- **Transactional Outbox, Inbox & Recuperação Fora de Ordem**: Entrega *at-least-once* e consumo idempotente no SQS FIFO com `FOR UPDATE SKIP LOCKED` (`LockMode.PESSIMISTIC_PARTIAL_WRITE`) tanto no `OutboxPublisherWorker` (3 fases: claim com lease de 30s, envio SQS fora da transação, ack/retry) quanto no `PendingReferenceWorker` (resolução in-place de `REFUND`/`ROLLBACK` fora de ordem).
- **Precisão Monetária & Idempotência Canônica**: Value Object `Money` baseado em `decimal.js` (precisão 28, `ROUND_HALF_UP`, 2 casas decimais) aliado a hash SHA-256 sobre JSON canônico ordenado (`idempotentReplay: true` com `observedBalance` histórico, ou `409 IDEMPOTENCY_CONFLICT`).
- **Observabilidade & Documentação OpenAPI**: Logs estruturados em Pino com propagação de `X-Correlation-Id`, 7 métricas Prometheus em `/metrics`, probes `/health/live` e `/health/ready` e Swagger UI interativo em `/docs`.

---

## Stack Tecnológica

| Camada | Tecnologia |
| :--- | :--- |
| **Runtime & Linguagem** | Bun 1.2, TypeScript 5.7 (modo estrito) |
| **Framework** | NestJS 10.4, `class-validator`, `@nestjs/swagger` 7 |
| **Persistência & ORM** | PostgreSQL 16, MikroORM 6.4 (Unit of Work + Identity Map) |
| **Mensageria** | AWS SQS FIFO (`@aws-sdk/client-sqs`), LocalStack 3.8 |
| **Precisão Financeira** | `decimal.js` 10.5 |
| **Observabilidade** | Pino 9.6, `prom-client` 15.1 |
| **Qualidade & Tooling** | Biome 2.6, Bun Test, Docker & Docker Compose, GitHub Actions |

---

## Inicialização Rápida

### Pré-requisitos
- **Docker** e **Docker Compose**
- **Bun 1.2+** (para desenvolvimento local, testes e teste de carga)

### 1. Subir a Stack Completa com Docker Compose

Inicia o PostgreSQL 16, o LocalStack SQS (com filas FIFO e DLQ provisionadas automaticamente) e a aplicação NestJS:

```bash
make up
# ou: docker compose up -d --build
```

Serviços disponíveis:
- **API Base**: `http://localhost:3000`
- **Swagger UI**: `http://localhost:3000/docs` (OpenAPI JSON em `http://localhost:3000/docs-json`)
- **Métricas Prometheus**: `http://localhost:3000/metrics`
- **Health Checks**: `http://localhost:3000/health/live` e `http://localhost:3000/health/ready`
- **PostgreSQL**: `localhost:5432` (`wagering_db`)
- **LocalStack SQS**: `localhost:4566`

### 2. Desenvolvimento Local com Bun

```bash
# Instalar dependências (lockfile congelado)
make install

# Subir apenas infraestrutura (PostgreSQL + LocalStack)
docker compose up -d postgres localstack

# Copiar variáveis de ambiente, se necessário
cp .env.example .env

# Executar aplicação em modo watch
bun run start:dev
```

### Comandos do Makefile

| Comando | Descrição |
| :--- | :--- |
| `make up` | Constrói e sobe todos os containers (`docker compose up -d --build`) |
| `make down` | Para e remove os containers (`docker compose down`) |
| `make logs` | Acompanha os logs dos containers (`docker compose logs -f`) |
| `make install` | Instala dependências com `bun install --frozen-lockfile` |
| `make typecheck` | Executa verificação de tipos TypeScript (`tsc --noEmit`) |
| `make lint` | Executa verificação de lint e formatação com Biome |
| `make build` | Compila o projeto TypeScript (`tsc`) |
| `make test` | Executa todas as suítes de testes do Bun |
| `make test-unit` | Executa testes unitários (`test/unit`) |
| `make test-concurrency` | Executa testes de concorrência (`test/concurrency`) |
| `make load-test` | Executa o teste de carga concorrente (`scripts/load-test.ts`) |

---

## Referência da API HTTP

A documentação interativa está disponível em **`GET /docs`** (Swagger UI) e **`GET /docs-json`**.

### Headers e Formato de Erro
- **`x-provider-id`** *(opcional, padrão `"provider-a"`)*: Identidade do provedor validada pelo `AuthGuard` contra `body.providerId` ou `:providerId`.
- **`Idempotency-Key`** *(opcional em `POST /wagering/transactions`)*: Padrão `${providerId}:${externalTransactionId}`.
- **`X-Correlation-Id`** *(opcional)*: Propagado nas respostas HTTP e nos logs HTTP/Pino (`CorrelationIdMiddleware`). Os envelopes `IntegrationEvent` de saída usam `wagerTx.idempotencyKey` (ou `OPENING-${wallet.id}` no `OpenWalletUseCase`) como `correlationId`.
- **Formato Padrão de Erro**:
  ```json
  {
    "statusCode": 409,
    "errorCode": "IDEMPOTENCY_CONFLICT",
    "message": "Idempotency key already used with a different payload",
    "timestamp": "2026-11-12T21:00:00.000Z"
  }
  ```

### Endpoints

| Método | Rota | Status Codes | Descrição |
| :--- | :--- | :--- | :--- |
| `POST` | `/wallets` | `201`, `400`, `409`, `422` | Cria carteira para o jogador (`WALLET_ALREADY_EXISTS` se duplicada) |
| `GET` | `/wallets/:walletId` | `200`, `404` | Consulta detalhes e saldo atual da carteira |
| `GET` | `/wallets/:walletId/ledger` | `200`, `404` | Extrato paginado por cursor (`?cursor=...&limit=...`, padrão `50`, limite `1..100`) |
| `POST` | `/wallets/:walletId/reconciliation` | `200`, `404` | Reconcilia saldo armazenado com `SUM`/`COUNT` SQL em transação `PESSIMISTIC_READ` |
| `POST` | `/wagering/transactions` | `200`, `400`, `403`, `404`, `409` | Processa `BET`, `WIN`, `LOSS`, `REFUND` ou `ROLLBACK` (`OPENING` rejeitado com `400 INVALID_TRANSACTION_KIND`) |
| `GET` | `/wagering/transactions/:transactionId` | `200`, `404` | Consulta transação pelo UUID interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | `200`, `403`, `404` | Consulta transação por provedor e ID externo |
| `GET` | `/health/live` | `200` | Probe de liveness (`{ status: "UP", timestamp }`) |
| `GET` | `/health/ready` | `200`, `503` | Probe de readiness validando PostgreSQL (`SELECT 1`) e SQS (`ListQueuesCommand`) |
| `GET` | `/metrics` | `200` | Métricas no formato Prometheus (`text/plain; version=0.0.4; charset=utf-8`) |

### Exemplos de Requisição

**1. Criar Carteira (`POST /wallets`)**
```json
{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "1000.00", "currency": "BRL" }
}
```

**2. Submeter Transação (`POST /wagering/transactions`)**
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

## Mensageria SQS FIFO

O LocalStack provisiona três filas FIFO na inicialização (`docker/localstack-init/init-sqs.sh`):
- **Entrada**: `wager-transactions.fifo` (com `RedrivePolicy` `maxReceiveCount=5` encaminhando falhas persistentes para a DLQ)
- **Dead-Letter Queue**: `wager-transactions-dlq.fifo`
- **Eventos de Saída**: `wager-events.fifo` (publicada pelo `OutboxPublisherWorker` com `MessageGroupId = aggregateId` (`walletId`) e `MessageDeduplicationId = outboxMessage.id`)

### Payload de Entrada SQS
Aceita payload direto ou envelope `{ "data": { ... } }`:
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

### Envelope de Saída `IntegrationEvent`
Tipos de eventos publicados em `wager-events.fifo`: `WalletBalanceChanged`, `WagerTransactionProcessed`, `WagerTransactionRejected` e `WagerTransactionPendingReference`.
```json
{
  "eventId": "019320a1-7c2b-7000-8000-000000000001",
  "eventType": "WagerTransactionProcessed",
  "aggregateId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "correlationId": "provider-a:tx-100",
  "causationId": "019320a1-7c2b-7000-8000-000000000000",
  "occurredAt": "2026-11-12T21:00:00.000Z",
  "version": 1,
  "data": {
    "transactionId": "019320a1-7c2b-7000-8000-000000000000",
    "providerId": "provider-a",
    "externalTransactionId": "tx-100",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "roundId": "round-987",
    "gameId": "fortune-tiger",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" },
    "balanceAfter": { "amount": "975.00", "currency": "BRL" }
  }
}
```

---

## Observabilidade & Métricas Prometheus

`GET /metrics` expõe 7 métricas instrumentadas via `prom-client`:

| Métrica | Tipo | Labels | Descrição |
| :--- | :--- | :--- | :--- |
| `wagering_transactions_total` | Counter | `kind`, `status`, `provider_id` | Total de transações por tipo, status e provedor |
| `wagering_duplicate_transactions_total` | Counter | `provider_id` | Total de replays idempotentes detectados |
| `wagering_message_retries_total` | Counter | `worker_name` | Tentativas de reprocessamento executadas pelos workers |
| `wagering_dlq_messages_total` | Counter | — | Mensagens encaminhadas ou sinalizadas para DLQ |
| `wagering_lock_conflicts_total` | Counter | — | Ocorrências de conflito / timeout de lock no PostgreSQL |
| `wagering_outbox_lag_messages` | Gauge | — | Quantidade atual de mensagens pendentes em `outbox_messages` |
| `wagering_transaction_duration_seconds` | Histogram | `kind`, `status` | Latência das transações (`[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5]`s) |

---

## Testes & Teste de Carga

```bash
# Testes unitários (domínio, value objects, use cases, métricas)
make test-unit

# Testes de concorrência e race conditions
make test-concurrency

# Suíte completa
make test
```

### Teste de Carga & Verificação de Integridade
Com a aplicação em execução (`make up` ou `bun run start:dev`), execute:
```bash
make load-test
# ou: bun run test:load
```
O script `scripts/load-test.ts` cria uma carteira com `10.000,00 BRL`, dispara **200 requisições `BET` concorrentes** (`10,00 BRL` cada, concorrência `20`), exibe **Throughput (`req/s`)**, **Sucessos/Falhas/Taxa de Erro** e **Latência Média / p50 / p95 / p99**, e executa `POST /wallets/:walletId/reconciliation` para comprovar **diferença de 0.00 BRL** entre o saldo armazenado e a soma do ledger imutável.

---

## Arquitetura & Decision Records

Diagramas detalhados, mecânica de concorrência, triggers de banco e análise de trade-offs estão documentados em:
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — Arquitetura do sistema, diagramas Mermaid de sequência e estado, locking, outbox/inbox e observabilidade.
- **[ADR 001: MikroORM & Pessimistic Row Locking](./docs/adr/001-mikroorm-pessimistic-locking.md)**
- **[ADR 002: Imutabilidade do Ledger & Constraints no PostgreSQL](./docs/adr/002-postgresql-ledger-immutability.md)**
- **[ADR 003: Transactional Outbox, Inbox & Workers `SKIP LOCKED`](./docs/adr/003-transactional-outbox-and-inbox.md)**
- **[ADR 004: `Money` de Precisão Arbitrária & Idempotência SHA-256](./docs/adr/004-decimal-money-and-idempotent-replay.md)**

---

## Licença

Este projeto está licenciado sob a [Licença MIT](./LICENSE).
