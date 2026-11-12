# ADR 001: MikroORM & Pessimistic Row Locking for Wallet Concurrency

- **Status**: Accepted
- **Date**: 2026-11-12
- **Related**: [ARCHITECTURE.md](../../ARCHITECTURE.md)

---

## Context

A distributed wagering processor must handle bursty, concurrent balance mutations (e.g., simultaneous `BET`, `WIN`, `REFUND`, and `ROLLBACK` requests for the same player wallet across multiple application replicas) without:
- Lost updates or negative balances.
- Ledger-to-wallet balance drift.
- High-contention optimistic retry storms or fragile distributed lock infrastructure (e.g., Redis Redlock).

We also need an ORM that tracks entity state mutations cleanly across multiple tables (`wallets`, `wager_transactions`, `wallet_ledger_entries`, `outbox_messages`, `inbox_messages`) within a single atomic SQL transaction.

## Decision

1. **Adopt MikroORM 6.4** as the persistence layer due to its explicit **Unit of Work** and **Identity Map** per `EntityManager` fork (`em.transactional(...)`).
2. **Use `walletId` as the concurrency unit** and serialize balance-mutating operations per wallet using PostgreSQL pessimistic row locking:
   - `LockMode.PESSIMISTIC_WRITE` (`SELECT ... FROM wallets WHERE id = $1 FOR UPDATE`).
   - Bounded wait via `SET LOCAL lock_timeout = '5000ms'` inside each transaction.
3. **Use `LockMode.PESSIMISTIC_READ`** in `ReconcileWalletUseCase` so ledger `SUM`/`COUNT` reconciliation runs against a consistent snapshot without blocking concurrent readers.
4. **Enforce consistent lock ordering** in background workers (`PendingReferenceWorker` locks the target `wallet` row before mutating `wager_transactions` and `wallet_ledger_entries`) to prevent deadlocks.

## Consequences

### Positive
- **Zero balance drift**: Concurrent mutations on the same wallet are strictly serialized by PostgreSQL's transactional lock manager.
- **Full cross-wallet parallelism**: Transactions on distinct `walletId`s never contend with one another.
- **No external lock coordinator**: Eliminates Redis lock lease drift, split-brain failure modes, and extra network hops.
- **Bounded tail latency**: `SET LOCAL lock_timeout = '5000ms'` prevents indefinite lock queuing and increments `wagering_lock_conflicts_total` when triggered.

### Trade-offs & Mitigations
- **Per-wallet throughput ceiling**: A single hot wallet is serialized at database transaction latency. *Mitigation*: Keep transactions short (no external HTTP/SQS I/O inside `em.transactional`) and offload async publishing to `OutboxPublisherWorker`.
- **Connection pool pressure under extreme contention**: Waiting transactions hold a PostgreSQL connection. *Mitigation*: `lock_timeout = 5000ms` bounds hold time and surfaces lock conflicts cleanly.

## Implementation References

- [`ProcessWagerTransactionUseCase`](../../src/application/use-cases/process-wager-transaction.use-case.ts)
- [`ReconcileWalletUseCase`](../../src/application/use-cases/reconcile-wallet.use-case.ts)
- [`PendingReferenceWorker`](../../src/infrastructure/workers/pending-reference.worker.ts)
- [`mikro-orm.config.ts`](../../src/infrastructure/database/mikro-orm.config.ts)
