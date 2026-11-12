# ADR 003: Transactional Outbox, Inbox & `SKIP LOCKED` Workers

- **Status**: Accepted
- **Date**: 2026-11-12
- **Related**: [ARCHITECTURE.md](../../ARCHITECTURE.md)

---

## Context

The processor both consumes wagering commands from AWS SQS FIFO (`wager-transactions.fifo`) and emits domain integration events (`WalletBalanceChanged`, `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`) to `wager-events.fifo`.

Publishing to SQS inside a database transaction risks:
- Dual-write inconsistency (DB commits, SQS fails; or SQS succeeds, DB rolls back).
- Holding database connections and row locks open during network I/O.

Additionally, multiple application instances may poll `outbox_messages` and `PENDING_REFERENCE` transactions simultaneously, and `REFUND`/`ROLLBACK` messages may arrive out of order before their referenced `BET`.

## Decision

1. **Inbox Pattern (`inbox_messages`)**:
   - `SqsWagerConsumer` inserts `(consumer_name, message_id)` into `inbox_messages` within the same database transaction as the wager operation.
   - SQS `DeleteMessageCommand` is executed **only after** the PostgreSQL transaction commits.
   - Poison messages exceeding `maxReceiveCount = 5` are routed by SQS `RedrivePolicy` to `wager-transactions-dlq.fifo`.
2. **Transactional Outbox (`outbox_messages`) + 3-Phase `OutboxPublisherWorker`**:
   - Domain events are persisted to `outbox_messages` in the same ACID transaction as the wallet and ledger updates.
   - `OutboxPublisherWorker` runs in 3 phases:
     1. **Claim**: `LockMode.PESSIMISTIC_PARTIAL_WRITE` (`FOR UPDATE SKIP LOCKED`) selects due rows and sets a 30-second lease (`next_attempt_at`).
     2. **Publish**: Sends messages to `wager-events.fifo` (`MessageGroupId = aggregateId`, `MessageDeduplicationId = outboxMessage.id`) **outside** any DB transaction.
     3. **Acknowledge / Retry**: Marks `published_at` on success or applies backoff and increments `wagering_message_retries_total` on failure.
3. **Out-of-Order Recovery (`PendingReferenceWorker`)**:
   - Polls `PENDING_REFERENCE` transactions using `FOR UPDATE SKIP LOCKED`, locks the wallet first, fast-rejects if the referenced transaction is `REJECTED`/`FAILED`, applies the reversal in-place if `PROCESSED`, or marks `FAILED` after a 5-minute TTL.

## Consequences

### Positive
- **No dual-write anomalies**: Every committed state change produces its outbox event atomically.
- **Horizontal worker scaling**: Multiple replicas run `OutboxPublisherWorker` and `PendingReferenceWorker` concurrently without duplicate processing or lock contention thanks to `FOR UPDATE SKIP LOCKED`.
- **Clean DB connection utilization**: SQS network calls happen outside database transactions.

### Trade-offs & Mitigations
- **At-least-once delivery semantics**: If the worker crashes after `SendMessage` and before marking `published_at`, the event may be sent again after the 30s lease. *Mitigation*: SQS FIFO deduplication (`MessageDeduplicationId = outboxMessage.id`) and `eventId` in the `IntegrationEvent` envelope allow downstream consumers to deduplicate safely.

## Implementation References

- [`OutboxPublisherWorker`](../../src/infrastructure/workers/outbox-publisher.worker.ts)
- [`PendingReferenceWorker`](../../src/infrastructure/workers/pending-reference.worker.ts)
- [`SqsWagerConsumer`](../../src/infrastructure/messaging/sqs-consumer.service.ts)
- [`IntegrationEvent`](../../src/domain/events/integration-event.ts)
- [`init-sqs.sh`](../../docker/localstack-init/init-sqs.sh)
