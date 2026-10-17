# Distributed Wagering Processor — Jungle Gaming

Solução sênior para o desafio técnico da Jungle Gaming: processador de apostas distribuído, transacional e resiliente a falhas e concorrência massiva.

---

## 🚀 Como Executar

### Pré-requisitos
- **Bun 1.x** (ou Node.js v20+)
- **Docker** e **Docker Compose**

### 1. Inicialização Rápida com Docker Compose
Suba o PostgreSQL, o LocalStack SQS provisionado com as filas FIFO e a aplicação:

```bash
docker compose up -d --build
```

Os seguintes serviços estarão disponíveis:
- **API Wagering**: `http://localhost:3000`
- **Métricas Prometheus**: `http://localhost:3000/metrics`
- **Health Checks**: `http://localhost:3000/health/live` e `http://localhost:3000/health/ready`
- **PostgreSQL**: `localhost:5432` (`wagering_db`)
- **LocalStack SQS**: `localhost:4566`

---

### 2. Execução Local com Bun

1. **Instalar dependências**:
   ```bash
   bun install
   ```

2. **Subir apenas os serviços de infraestrutura (Postgres e LocalStack)**:
   ```bash
   docker compose up -d postgres localstack
   ```

3. **Rodar a aplicação**:
   ```bash
   bun run start:dev
   ```

---

## 🧪 Testes Automatizados

O projeto conta com baterias completas de testes unitários, de integração e concorrência executados nativamente via Bun Test:

```bash
# Executar todos os testes unitários e de domínio
bun test

# Executar benchmark e teste de carga
bun run test:load
```

---

## 📋 Endpoints Principais da API

### 1. Criar Carteira
`POST /wallets`
```json
{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "1000.00", "currency": "BRL" }
}
```

### 2. Submeter Transação de Aposta
`POST /wagering/transactions`  
Header: `Idempotency-Key: provider-a:tx-100`

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "tx-100",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```

### 3. Consultar Extrato do Ledger (Cursor Opaque)
`GET /wallets/:walletId/ledger?limit=50&cursor=...`

### 4. Reconciliação Contábil da Carteira
`POST /wallets/:walletId/reconciliation`

---

## 🛡️ Decisões e Detalhes de Arquitetura
Consulte o arquivo **[ARCHITECTURE.md](./ARCHITECTURE.md)** para uma análise detalhada dos trade-offs, modelagem de concorrência com Pessimistic Locking no MikroORM, triggers de imutabilidade no PostgreSQL, Transactional Outbox com `SKIP LOCKED` e design de IdP externo.
