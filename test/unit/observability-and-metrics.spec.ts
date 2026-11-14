import { describe, expect, it } from "bun:test";
import { SQSClient } from "@aws-sdk/client-sqs";
import { EntityManager } from "@mikro-orm/postgresql";
import { v7 as uuidv7 } from "uuid";
import { ProcessWagerTransactionUseCase } from "../../src/application/use-cases/process-wager-transaction.use-case";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/entities/wager-transaction";
import { OutboxMessageOrmEntity } from "../../src/infrastructure/database/entities/outbox-message.orm-entity";
import { WagerTransactionOrmEntity } from "../../src/infrastructure/database/entities/wager-transaction.orm-entity";
import { WalletOrmEntity } from "../../src/infrastructure/database/entities/wallet.orm-entity";
import { SqsConsumerService } from "../../src/infrastructure/messaging/sqs-consumer.service";
import { MetricsService } from "../../src/infrastructure/observability/metrics.service";
import { OutboxPublisherWorker } from "../../src/infrastructure/workers/outbox-publisher.worker";
import { PendingReferenceWorker } from "../../src/infrastructure/workers/pending-reference.worker";

describe("M4 Observability — All 7 Prometheus Metrics", () => {
  it("ProcessWagerTransactionUseCase records transactionsTotal, duplicateTransactionsTotal, lockConflictsTotal, and transactionDurationSeconds", async () => {
    const metrics = new MetricsService();
    const wallet = Object.assign(new WalletOrmEntity(), {
      id: uuidv7(),
      playerId: "p-1",
      currency: "USD",
      balance: "100.00",
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const transactions: WagerTransactionOrmEntity[] = [];

    const txEm = {
      getConnection: () => ({ execute: async () => undefined }),
      findOne: async (entity: unknown, where: Record<string, unknown>) => {
        if (entity === WalletOrmEntity && where.id === wallet.id) {
          return wallet;
        }
        if (entity === WagerTransactionOrmEntity) {
          return (
            transactions.find(
              (t) =>
                t.providerId === where.providerId &&
                (where.idempotencyKey
                  ? t.idempotencyKey === where.idempotencyKey
                  : t.externalTransactionId === where.externalTransactionId)
            ) ?? null
          );
        }
        return null;
      },
      create: (entity: unknown, data: Record<string, unknown>) => {
        const obj = Object.assign(
          entity === WagerTransactionOrmEntity
            ? new WagerTransactionOrmEntity()
            : new OutboxMessageOrmEntity(),
          data
        );
        return obj;
      },
      persist: (obj: unknown) => {
        if (obj instanceof WagerTransactionOrmEntity) {
          transactions.push(obj);
        }
      },
      flush: async () => undefined,
    };

    const em = {
      transactional: async <T>(cb: (innerEm: typeof txEm) => Promise<T>) => cb(txEm),
    } as unknown as EntityManager;

    const useCase = new ProcessWagerTransactionUseCase(em, metrics);

    // 1. Processed BET
    await useCase.execute({
      providerId: "prov-m4",
      externalTransactionId: "ext-1",
      idempotencyKey: "idem-1",
      playerId: "p-1",
      walletId: wallet.id,
      roundId: "r-1",
      gameId: "g-1",
      kind: WagerTransactionKind.Bet,
      money: { amount: "20.00", currency: "USD" },
    });

    // 2. Idempotent replay
    await useCase.execute({
      providerId: "prov-m4",
      externalTransactionId: "ext-1",
      idempotencyKey: "idem-1",
      playerId: "p-1",
      walletId: wallet.id,
      roundId: "r-1",
      gameId: "g-1",
      kind: WagerTransactionKind.Bet,
      money: { amount: "20.00", currency: "USD" },
    });

    // 3. Idempotency conflict (same key, different amount)
    await expect(
      useCase.execute({
        providerId: "prov-m4",
        externalTransactionId: "ext-1",
        idempotencyKey: "idem-1",
        playerId: "p-1",
        walletId: wallet.id,
        roundId: "r-1",
        gameId: "g-1",
        kind: WagerTransactionKind.Bet,
        money: { amount: "99.00", currency: "USD" },
      })
    ).rejects.toThrow();

    // 4. Rejected (insufficient funds)
    await useCase.execute({
      providerId: "prov-m4",
      externalTransactionId: "ext-2",
      idempotencyKey: "idem-2",
      playerId: "p-1",
      walletId: wallet.id,
      roundId: "r-1",
      gameId: "g-1",
      kind: WagerTransactionKind.Bet,
      money: { amount: "500.00", currency: "USD" },
    });

    const output = await metrics.getMetrics();
    expect(output).toContain(
      'wagering_transactions_total{kind="BET",status="PROCESSED",provider_id="prov-m4"} 1'
    );
    expect(output).toContain(
      'wagering_transactions_total{kind="BET",status="REJECTED",provider_id="prov-m4"} 1'
    );
    expect(output).toContain('wagering_duplicate_transactions_total{provider_id="prov-m4"} 1');
    expect(output).toContain("wagering_lock_conflicts_total 1");
    expect(output).toContain(
      'wagering_transaction_duration_seconds_count{kind="BET",status="PROCESSED"} 2'
    );
  });

  it("OutboxPublisherWorker records outboxLagGauge and messageRetriesTotal", async () => {
    const metrics = new MetricsService();
    const msg = Object.assign(new OutboxMessageOrmEntity(), {
      id: uuidv7(),
      aggregateId: "wallet-1",
      eventType: "WalletBalanceChanged",
      payload: { eventId: "e1" },
      occurredAt: new Date(Date.now() - 1000),
      attempts: 0,
    });

    const txEm = {
      count: async () => 1,
      createQueryBuilder: () => ({
        where: function () {
          return this;
        },
        andWhere: function () {
          return this;
        },
        orderBy: function () {
          return this;
        },
        limit: function () {
          return this;
        },
        setLockMode: function () {
          return this;
        },
        getResultList: async () => [msg],
      }),
      find: async () => [msg],
      flush: async () => undefined,
    };

    const em = {
      transactional: async <T>(cb: (innerEm: typeof txEm) => Promise<T>) => cb(txEm),
    } as unknown as EntityManager;

    const sqsClient = {
      send: async () => {
        throw new Error("SQS unavailable");
      },
    } as unknown as SQSClient;

    const worker = new OutboxPublisherWorker(em, sqsClient, metrics);
    await worker.handleOutboxPublishing();

    const output = await metrics.getMetrics();
    expect(output).toContain("wagering_outbox_lag_messages 1");
    expect(output).toContain(
      'wagering_message_retries_total{worker_name="OutboxPublisherWorker"} 1'
    );
  });

  it("SqsConsumerService records dlqMessagesTotal on poison pills and messageRetriesTotal on transient errors", async () => {
    const metrics = new MetricsService();
    const sqsClient = { send: async () => ({}) } as unknown as SQSClient;
    const useCase = {
      execute: async () => {
        throw new Error("ECONNREFUSED");
      },
    } as unknown as ProcessWagerTransactionUseCase;

    const consumer = new SqsConsumerService(sqsClient, useCase, metrics);
    const processMsg = (
      consumer as unknown as {
        processMessage: (msg: Record<string, unknown>, queueUrl: string) => Promise<void>;
      }
    ).processMessage.bind(consumer);

    // Poison pill (invalid JSON) -> dlqMessagesTotal
    await processMsg(
      { MessageId: "m-poison", ReceiptHandle: "rh-1", Body: "{bad-json" },
      "http://localhost/q"
    );

    // Transient error -> messageRetriesTotal
    await processMsg(
      {
        MessageId: "m-transient",
        ReceiptHandle: "rh-2",
        Body: JSON.stringify({ providerId: "p", externalTransactionId: "e" }),
        Attributes: { ApproximateReceiveCount: "2" },
      },
      "http://localhost/q"
    );

    const output = await metrics.getMetrics();
    expect(output).toContain("wagering_dlq_messages_total 1");
    expect(output).toContain('wagering_message_retries_total{worker_name="SqsConsumerService"} 2');
  });

  it("PendingReferenceWorker records messageRetriesTotal and lockConflictsTotal on lock timeout", async () => {
    const metrics = new MetricsService();
    const candidate = Object.assign(new WagerTransactionOrmEntity(), {
      id: uuidv7(),
      walletId: uuidv7(),
      providerId: "prov-1",
      status: WagerTransactionStatus.PendingReference,
      kind: WagerTransactionKind.Refund,
    });

    let callIdx = 0;
    const em = {
      transactional: async <T>(cb: (innerEm: Record<string, unknown>) => Promise<T>) => {
        callIdx += 1;
        if (callIdx === 1) {
          return (await cb({
            createQueryBuilder: () => ({
              where: function () {
                return this;
              },
              orderBy: function () {
                return this;
              },
              limit: function () {
                return this;
              },
              setLockMode: function () {
                return this;
              },
              getResultList: async () => [candidate],
            }),
          })) as T;
        }
        const lockErr = Object.assign(new Error("canceling statement due to lock_timeout"), {
          code: "55P03",
        });
        throw lockErr;
      },
    } as unknown as EntityManager;

    const worker = new PendingReferenceWorker(em, metrics);
    await worker.handlePendingReferences();

    const output = await metrics.getMetrics();
    expect(output).toContain(
      'wagering_message_retries_total{worker_name="PendingReferenceWorker"} 1'
    );
    expect(output).toContain("wagering_lock_conflicts_total 1");
  });
});
