import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DeleteMessageCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { LockMode } from "@mikro-orm/postgresql";
import { v7 as uuidv7 } from "uuid";
import {
  IdempotencyConflictError,
  InvalidTransactionKindError,
  WalletNotFoundError,
} from "../../src/application/errors/application-errors";
import { ProcessWagerTransactionUseCase } from "../../src/application/use-cases/process-wager-transaction.use-case";
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/entities/wager-transaction";
import { LedgerDirection } from "../../src/domain/entities/wallet-ledger-entry";
import { InvalidMoneyError } from "../../src/domain/errors/domain-errors";
import {
  OutboxMessageOrmEntity,
  WagerTransactionOrmEntity,
  WalletLedgerEntryOrmEntity,
  WalletOrmEntity,
} from "../../src/infrastructure/database/entities";
import { SqsConsumerService } from "../../src/infrastructure/messaging/sqs-consumer.service";
import { OutboxPublisherWorker } from "../../src/infrastructure/workers/outbox-publisher.worker";
import { PendingReferenceWorker } from "../../src/infrastructure/workers/pending-reference.worker";

/**
 * Helper to create a mock EntityManager supporting transactional, createQueryBuilder with setLockMode,
 * getConnection().execute(), find, findOne, create, persist, flush.
 */
function createWorkerMockEm(options?: {
  outboxMessages?: OutboxMessageOrmEntity[];
  wallets?: WalletOrmEntity[];
  transactions?: WagerTransactionOrmEntity[];
}) {
  const outboxMessages = options?.outboxMessages ?? [];
  const wallets = options?.wallets ?? [];
  const transactions = options?.transactions ?? [];
  const ledgerEntries: WalletLedgerEntryOrmEntity[] = [];

  const lockModesUsed: LockMode[] = [];
  const executedSql: string[] = [];
  let activeTxDepth = 0;
  let txCount = 0;

  const makeEm = (): any => ({
    getConnection: () => ({
      execute: async (sql: string) => {
        executedSql.push(sql);
        return [];
      },
    }),
    transactional: async (cb: (txEm: any) => Promise<any>) => {
      txCount += 1;
      activeTxDepth += 1;
      try {
        return await cb(makeEm());
      } finally {
        activeTxDepth -= 1;
      }
    },
    createQueryBuilder: (entityClass: any, _alias: string) => {
      const qb = {
        where: (_cond: any) => qb,
        andWhere: (_cond: any, _params?: any) => qb,
        orderBy: (_order: any) => qb,
        limit: (_n: number) => qb,
        setLockMode: (mode: LockMode) => {
          lockModesUsed.push(mode);
          return qb;
        },
        getResultList: async () => {
          if (entityClass === OutboxMessageOrmEntity) {
            const now = new Date();
            return outboxMessages.filter(
              (m) =>
                (m.publishedAt === undefined || m.publishedAt === null) &&
                (!m.nextAttemptAt || m.nextAttemptAt <= now)
            );
          }
          if (entityClass === WagerTransactionOrmEntity) {
            return transactions.filter((t) => t.status === WagerTransactionStatus.PendingReference);
          }
          return [];
        },
      };
      return qb;
    },
    find: async (entityClass: any, where: any) => {
      if (entityClass === OutboxMessageOrmEntity && where?.id?.$in) {
        const ids = new Set<string>(where.id.$in);
        return outboxMessages.filter((m) => ids.has(m.id));
      }
      return [];
    },
    findOne: async (entityClass: any, where: any, findOpts?: any) => {
      if (findOpts?.lockMode) {
        lockModesUsed.push(findOpts.lockMode);
      }
      if (entityClass === WalletOrmEntity) {
        return wallets.find((w) => w.id === where.id) ?? null;
      }
      if (entityClass === WagerTransactionOrmEntity) {
        if (where.id) {
          return transactions.find((t) => t.id === where.id) ?? null;
        }
        if (where.providerId && where.externalTransactionId) {
          return (
            transactions.find(
              (t) =>
                t.providerId === where.providerId &&
                t.externalTransactionId === where.externalTransactionId
            ) ?? null
          );
        }
        if (where.referenceTransactionId && where.kind && where.status) {
          return (
            transactions.find(
              (t) =>
                t.referenceTransactionId === where.referenceTransactionId &&
                t.kind === where.kind &&
                t.status === where.status
            ) ?? null
          );
        }
      }
      return null;
    },
    create: (entityClass: any, data: any) => {
      return Object.assign(new entityClass(), data);
    },
    persist: (entity: any) => {
      if (entity instanceof OutboxMessageOrmEntity) {
        outboxMessages.push(entity);
      } else if (entity instanceof WalletLedgerEntryOrmEntity) {
        ledgerEntries.push(entity);
      }
    },
    flush: async () => {},
  });

  return {
    em: makeEm(),
    outboxMessages,
    wallets,
    transactions,
    ledgerEntries,
    lockModesUsed,
    executedSql,
    getTxCount: () => txCount,
    isInsideTx: () => activeTxDepth > 0,
  };
}

describe("M3 Distributed Workers & SQS Consumer", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.SQS_OUTBOX_QUEUE_URL;
    delete process.env.SQS_QUEUE_URL;
    delete process.env.OUTBOX_POLL_INTERVAL_MS;
    delete process.env.PENDING_REFERENCE_POLL_INTERVAL_MS;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("OutboxPublisherWorker (Reqs 1, 2, 4)", () => {
    it("deve publicar na SQS_OUTBOX_QUEUE_URL (não SQS_QUEUE_URL) usando 3 fases e PESSIMISTIC_PARTIAL_WRITE", async () => {
      process.env.SQS_QUEUE_URL = "http://localhost:4566/000000000000/wager-transactions.fifo";
      process.env.SQS_OUTBOX_QUEUE_URL = "http://localhost:4566/000000000000/wager-events.fifo";

      const msg1 = Object.assign(new OutboxMessageOrmEntity(), {
        id: uuidv7(),
        aggregateId: "wallet-1",
        eventType: "WalletBalanceChanged",
        payload: { eventId: "e1", data: {} },
        occurredAt: new Date(Date.now() - 5000),
        attempts: 0,
      });
      const msg2 = Object.assign(new OutboxMessageOrmEntity(), {
        id: uuidv7(),
        aggregateId: "wallet-2",
        eventType: "WagerTransactionProcessed",
        payload: { eventId: "e2", data: {} },
        occurredAt: new Date(Date.now() - 4000),
        attempts: 0,
      });

      const mockDb = createWorkerMockEm({ outboxMessages: [msg1, msg2] });

      const sentCommands: Array<{ cmd: SendMessageCommand; insideTx: boolean }> = [];
      const mockSqs = {
        send: async (cmd: SendMessageCommand) => {
          sentCommands.push({ cmd, insideTx: mockDb.isInsideTx() });
          if (cmd.input.MessageDeduplicationId === msg2.id) {
            throw new Error("SQS network timeout");
          }
          return { MessageId: "sqs-1" };
        },
      } as unknown as SQSClient;

      const worker = new OutboxPublisherWorker(mockDb.em, mockSqs);
      await worker.handleOutboxPublishing();

      // 1. Deve ter usado LockMode.PESSIMISTIC_PARTIAL_WRITE (FOR UPDATE SKIP LOCKED)
      expect(mockDb.lockModesUsed).toContain(LockMode.PESSIMISTIC_PARTIAL_WRITE);

      // 2. Deve ter executado 2 transações curtas (Claim + Finalize), e SQS fora de qualquer tx
      expect(mockDb.getTxCount()).toBe(2);
      expect(sentCommands.length).toBe(2);
      expect(sentCommands[0].insideTx).toBe(false);
      expect(sentCommands[1].insideTx).toBe(false);
      expect(sentCommands[0].cmd.input.QueueUrl).toBe(
        "http://localhost:4566/000000000000/wager-events.fifo"
      );

      // 3. msg1 publicada com sucesso; msg2 agendada para retry
      expect(msg1.publishedAt).toBeInstanceOf(Date);
      expect(msg1.nextAttemptAt).toBeUndefined();
      expect(msg2.publishedAt).toBeUndefined();
      expect(msg2.attempts).toBe(1);
      expect(msg2.nextAttemptAt).toBeInstanceOf(Date);
    });

    it("deve usar default wager-events.fifo quando SQS_OUTBOX_QUEUE_URL não estiver definido", async () => {
      const msg = Object.assign(new OutboxMessageOrmEntity(), {
        id: uuidv7(),
        aggregateId: "wallet-1",
        eventType: "WalletBalanceChanged",
        payload: { eventId: "e1" },
        occurredAt: new Date(Date.now() - 1000),
        attempts: 0,
      });

      const mockDb = createWorkerMockEm({ outboxMessages: [msg] });
      let usedQueueUrl = "";
      const mockSqs = {
        send: async (cmd: SendMessageCommand) => {
          usedQueueUrl = cmd.input.QueueUrl ?? "";
          return {};
        },
      } as unknown as SQSClient;

      const worker = new OutboxPublisherWorker(mockDb.em, mockSqs);
      await worker.handleOutboxPublishing();

      expect(usedQueueUrl).toBe("http://localhost:4566/000000000000/wager-events.fifo");
    });

    it("deve validar OUTBOX_POLL_INTERVAL_MS e aguardar tick em voo no onModuleDestroy", async () => {
      const mockDb = createWorkerMockEm();
      const mockSqs = { send: async () => ({}) } as unknown as SQSClient;

      process.env.OUTBOX_POLL_INTERVAL_MS = "0";
      const badWorker = new OutboxPublisherWorker(mockDb.em, mockSqs);
      expect(() => badWorker.onModuleInit()).toThrow(/OUTBOX_POLL_INTERVAL_MS/);

      process.env.OUTBOX_POLL_INTERVAL_MS = "abc";
      expect(() => badWorker.onModuleInit()).toThrow(/OUTBOX_POLL_INTERVAL_MS/);

      process.env.OUTBOX_POLL_INTERVAL_MS = "50";
      let releaseClaim!: () => void;
      const claimGate = new Promise<void>((resolve) => {
        releaseClaim = resolve;
      });
      const slowEm = {
        ...mockDb.em,
        transactional: async () => {
          await claimGate;
          return [];
        },
      };
      const worker = new OutboxPublisherWorker(slowEm, mockSqs);
      worker.onModuleInit();

      const inFlight = worker.handleOutboxPublishing();
      let destroyed = false;
      const destroyPromise = worker.onModuleDestroy().then(() => {
        destroyed = true;
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(destroyed).toBe(false);

      releaseClaim();
      await Promise.all([inFlight, destroyPromise]);
      expect(destroyed).toBe(true);
    });
  });

  describe("PendingReferenceWorker (Reqs 3, 4)", () => {
    const baseWallet = () =>
      Object.assign(new WalletOrmEntity(), {
        id: uuidv7(),
        playerId: "player-1",
        currency: "BRL",
        balance: "100.00",
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

    it("deve resolver REFUND de BET in-place preservando txOrm.id, atualizando wallet, ledger e outbox", async () => {
      const wallet = baseWallet();
      const betTx = Object.assign(new WagerTransactionOrmEntity(), {
        id: uuidv7(),
        providerId: "prov-1",
        externalTransactionId: "ext-bet-1",
        idempotencyKey: "idem-bet-1",
        payloadHash: "hash-1",
        walletId: wallet.id,
        playerId: "player-1",
        roundId: "round-1",
        gameId: "game-1",
        kind: WagerTransactionKind.Bet,
        amount: "25.00",
        currency: "BRL",
        status: WagerTransactionStatus.Processed,
        createdAt: new Date(),
      });
      const pendingRefund = Object.assign(new WagerTransactionOrmEntity(), {
        id: uuidv7(),
        providerId: "prov-1",
        externalTransactionId: "ext-refund-1",
        idempotencyKey: "idem-refund-1",
        payloadHash: "hash-2",
        walletId: wallet.id,
        playerId: "player-1",
        roundId: "round-1",
        gameId: "game-1",
        kind: WagerTransactionKind.Refund,
        amount: "25.00",
        currency: "BRL",
        referenceExternalTransactionId: "ext-bet-1",
        status: WagerTransactionStatus.PendingReference,
        createdAt: new Date(),
      });
      const originalId = pendingRefund.id;

      const mockDb = createWorkerMockEm({
        wallets: [wallet],
        transactions: [betTx, pendingRefund],
      });

      const worker = new PendingReferenceWorker(mockDb.em);
      await worker.handlePendingReferences();

      expect(mockDb.executedSql).toContain("SET LOCAL lock_timeout = '5000ms'");
      expect(mockDb.lockModesUsed).toContain(LockMode.PESSIMISTIC_PARTIAL_WRITE);
      expect(mockDb.lockModesUsed).toContain(LockMode.PESSIMISTIC_WRITE);

      expect(pendingRefund.id).toBe(originalId);
      expect(pendingRefund.status).toBe(WagerTransactionStatus.Processed);
      expect(pendingRefund.referenceTransactionId).toBe(betTx.id);
      expect(pendingRefund.observedBalance).toBe("125.00");
      expect(pendingRefund.observedBalanceCurrency).toBe("BRL");
      expect(pendingRefund.processedAt).toBeInstanceOf(Date);

      expect(wallet.balance).toBe("125.00");
      expect(wallet.version).toBe(2);

      expect(mockDb.ledgerEntries.length).toBe(1);
      expect(mockDb.ledgerEntries[0].transactionId).toBe(originalId);
      expect(mockDb.ledgerEntries[0].direction).toBe(LedgerDirection.Credit);
      expect(mockDb.ledgerEntries[0].balanceAfter).toBe("125.00");

      const eventTypes = mockDb.outboxMessages.map((m) => m.eventType);
      expect(eventTypes).toContain("WalletBalanceChanged");
      expect(eventTypes).toContain("WagerTransactionProcessed");
    });

    it("deve fazer fast-reject in-place quando referência estiver REJECTED ou FAILED", async () => {
      const wallet = baseWallet();
      const failedBet = Object.assign(new WagerTransactionOrmEntity(), {
        id: uuidv7(),
        providerId: "prov-1",
        externalTransactionId: "ext-bet-failed",
        idempotencyKey: "idem-bet-failed",
        payloadHash: "hash-1",
        walletId: wallet.id,
        playerId: "player-1",
        roundId: "round-1",
        gameId: "game-1",
        kind: WagerTransactionKind.Bet,
        amount: "25.00",
        currency: "BRL",
        status: WagerTransactionStatus.Rejected,
        createdAt: new Date(),
      });
      const pendingRefund = Object.assign(new WagerTransactionOrmEntity(), {
        id: uuidv7(),
        providerId: "prov-1",
        externalTransactionId: "ext-refund-2",
        idempotencyKey: "idem-refund-2",
        payloadHash: "hash-2",
        walletId: wallet.id,
        playerId: "player-1",
        roundId: "round-1",
        gameId: "game-1",
        kind: WagerTransactionKind.Refund,
        amount: "25.00",
        currency: "BRL",
        referenceExternalTransactionId: "ext-bet-failed",
        status: WagerTransactionStatus.PendingReference,
        createdAt: new Date(),
      });

      const mockDb = createWorkerMockEm({
        wallets: [wallet],
        transactions: [failedBet, pendingRefund],
      });

      const worker = new PendingReferenceWorker(mockDb.em);
      await worker.handlePendingReferences();

      expect(pendingRefund.status).toBe(WagerTransactionStatus.Rejected);
      expect(pendingRefund.failureCode).toBe(FailureCode.ReferenceNotFound);
      expect(pendingRefund.observedBalance).toBe("100.00");
      expect(wallet.balance).toBe("100.00");
      expect(mockDb.outboxMessages.map((m) => m.eventType)).toEqual(["WagerTransactionRejected"]);
    });

    it("deve rejeitar in-place por TTL expirado (> 5 min) e manter pendente se dentro do TTL", async () => {
      const wallet = baseWallet();
      const expiredTx = Object.assign(new WagerTransactionOrmEntity(), {
        id: uuidv7(),
        providerId: "prov-1",
        externalTransactionId: "ext-exp",
        idempotencyKey: "idem-exp",
        payloadHash: "hash-1",
        walletId: wallet.id,
        playerId: "player-1",
        roundId: "round-1",
        gameId: "game-1",
        kind: WagerTransactionKind.Refund,
        amount: "10.00",
        currency: "BRL",
        referenceExternalTransactionId: "missing-ref",
        status: WagerTransactionStatus.PendingReference,
        createdAt: new Date(Date.now() - 6 * 60 * 1000),
      });
      const freshTx = Object.assign(new WagerTransactionOrmEntity(), {
        id: uuidv7(),
        providerId: "prov-1",
        externalTransactionId: "ext-fresh",
        idempotencyKey: "idem-fresh",
        payloadHash: "hash-2",
        walletId: wallet.id,
        playerId: "player-1",
        roundId: "round-1",
        gameId: "game-1",
        kind: WagerTransactionKind.Refund,
        amount: "10.00",
        currency: "BRL",
        referenceExternalTransactionId: "missing-ref-2",
        status: WagerTransactionStatus.PendingReference,
        createdAt: new Date(Date.now() - 60 * 1000),
      });

      const mockDb = createWorkerMockEm({
        wallets: [wallet],
        transactions: [expiredTx, freshTx],
      });

      const worker = new PendingReferenceWorker(mockDb.em);
      await worker.handlePendingReferences();

      expect(expiredTx.status).toBe(WagerTransactionStatus.Rejected);
      expect(expiredTx.failureCode).toBe(FailureCode.ReferenceNotFound);
      expect(freshTx.status).toBe(WagerTransactionStatus.PendingReference);
    });

    it("deve rejeitar ROLLBACK de WIN com REVERSAL_INSUFFICIENT_FUNDS se saldo for insuficiente", async () => {
      const wallet = baseWallet();
      wallet.balance = "20.00";

      const winTx = Object.assign(new WagerTransactionOrmEntity(), {
        id: uuidv7(),
        providerId: "prov-1",
        externalTransactionId: "ext-win-1",
        idempotencyKey: "idem-win-1",
        payloadHash: "hash-w",
        walletId: wallet.id,
        playerId: "player-1",
        roundId: "round-1",
        gameId: "game-1",
        kind: WagerTransactionKind.Win,
        amount: "50.00",
        currency: "BRL",
        status: WagerTransactionStatus.Processed,
        createdAt: new Date(),
      });
      const pendingRollback = Object.assign(new WagerTransactionOrmEntity(), {
        id: uuidv7(),
        providerId: "prov-1",
        externalTransactionId: "ext-rb-1",
        idempotencyKey: "idem-rb-1",
        payloadHash: "hash-rb",
        walletId: wallet.id,
        playerId: "player-1",
        roundId: "round-1",
        gameId: "game-1",
        kind: WagerTransactionKind.Rollback,
        amount: "50.00",
        currency: "BRL",
        referenceExternalTransactionId: "ext-win-1",
        status: WagerTransactionStatus.PendingReference,
        createdAt: new Date(),
      });

      const mockDb = createWorkerMockEm({
        wallets: [wallet],
        transactions: [winTx, pendingRollback],
      });

      const worker = new PendingReferenceWorker(mockDb.em);
      await worker.handlePendingReferences();

      expect(pendingRollback.status).toBe(WagerTransactionStatus.Rejected);
      expect(pendingRollback.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
      expect(wallet.balance).toBe("20.00");
    });

    it("deve rejeitar REFUND de WIN com INVALID_REFERENCE_TYPE", async () => {
      const wallet = baseWallet();
      const winTx = Object.assign(new WagerTransactionOrmEntity(), {
        id: uuidv7(),
        providerId: "prov-1",
        externalTransactionId: "ext-win-2",
        idempotencyKey: "idem-win-2",
        payloadHash: "hash-w",
        walletId: wallet.id,
        playerId: "player-1",
        roundId: "round-1",
        gameId: "game-1",
        kind: WagerTransactionKind.Win,
        amount: "20.00",
        currency: "BRL",
        status: WagerTransactionStatus.Processed,
        createdAt: new Date(),
      });
      const pendingRefund = Object.assign(new WagerTransactionOrmEntity(), {
        id: uuidv7(),
        providerId: "prov-1",
        externalTransactionId: "ext-ref-win",
        idempotencyKey: "idem-ref-win",
        payloadHash: "hash-rw",
        walletId: wallet.id,
        playerId: "player-1",
        roundId: "round-1",
        gameId: "game-1",
        kind: WagerTransactionKind.Refund,
        amount: "20.00",
        currency: "BRL",
        referenceExternalTransactionId: "ext-win-2",
        status: WagerTransactionStatus.PendingReference,
        createdAt: new Date(),
      });

      const mockDb = createWorkerMockEm({
        wallets: [wallet],
        transactions: [winTx, pendingRefund],
      });

      const worker = new PendingReferenceWorker(mockDb.em);
      await worker.handlePendingReferences();

      expect(pendingRefund.status).toBe(WagerTransactionStatus.Rejected);
      expect(pendingRefund.failureCode).toBe(FailureCode.InvalidReferenceType);
    });

    it("deve validar PENDING_REFERENCE_POLL_INTERVAL_MS e drenar no onModuleDestroy", async () => {
      const mockDb = createWorkerMockEm();
      process.env.PENDING_REFERENCE_POLL_INTERVAL_MS = "-10";
      const badWorker = new PendingReferenceWorker(mockDb.em);
      expect(() => badWorker.onModuleInit()).toThrow(/PENDING_REFERENCE_POLL_INTERVAL_MS/);

      process.env.PENDING_REFERENCE_POLL_INTERVAL_MS = "100";
      const worker = new PendingReferenceWorker(mockDb.em);
      worker.onModuleInit();
      await worker.onModuleDestroy();
    });
  });

  describe("SqsConsumerService Poison-Pill Classification (Req 5)", () => {
    const queueUrl = "http://localhost:4566/000000000000/wager-transactions.fifo";

    it("deve deletar mensagem da fila SQS para SyntaxError (JSON malformado)", async () => {
      const deleted: DeleteMessageCommand[] = [];
      const mockSqs = {
        send: async (cmd: DeleteMessageCommand) => {
          deleted.push(cmd);
          return {};
        },
      } as unknown as SQSClient;
      const mockUseCase = { execute: async () => {} } as unknown as ProcessWagerTransactionUseCase;

      const consumer = new SqsConsumerService(mockSqs, mockUseCase);
      await (consumer as any).processMessage(
        { MessageId: "m1", ReceiptHandle: "rh-1", Body: "{not-valid-json" },
        queueUrl
      );

      expect(deleted.length).toBe(1);
      expect(deleted[0].input.ReceiptHandle).toBe("rh-1");
    });

    it("deve deletar mensagem da fila SQS para DomainError e ApplicationError", async () => {
      const errorsToTest = [
        new InvalidMoneyError("negative amount"),
        new WalletNotFoundError("w-1"),
        new InvalidTransactionKindError("OPENING"),
        new IdempotencyConflictError("key-1"),
      ];

      for (const err of errorsToTest) {
        const deleted: DeleteMessageCommand[] = [];
        const mockSqs = {
          send: async (cmd: DeleteMessageCommand) => {
            deleted.push(cmd);
            return {};
          },
        } as unknown as SQSClient;
        const mockUseCase = {
          execute: async () => {
            throw err;
          },
        } as unknown as ProcessWagerTransactionUseCase;

        const consumer = new SqsConsumerService(mockSqs, mockUseCase);
        await (consumer as any).processMessage(
          {
            MessageId: "m-err",
            ReceiptHandle: "rh-err",
            Body: JSON.stringify({ providerId: "p1", externalTransactionId: "e1" }),
          },
          queueUrl
        );

        expect(deleted.length).toBe(1);
      }
    });

    it("NÃO deve deletar mensagem da fila SQS para erros transitórios de infraestrutura", async () => {
      const deleted: DeleteMessageCommand[] = [];
      const mockSqs = {
        send: async (cmd: DeleteMessageCommand) => {
          deleted.push(cmd);
          return {};
        },
      } as unknown as SQSClient;
      const mockUseCase = {
        execute: async () => {
          throw new Error("ECONNREFUSED postgres:5432");
        },
      } as unknown as ProcessWagerTransactionUseCase;

      const consumer = new SqsConsumerService(mockSqs, mockUseCase);
      await (consumer as any).processMessage(
        {
          MessageId: "m-transient",
          ReceiptHandle: "rh-transient",
          Body: JSON.stringify({ providerId: "p1", externalTransactionId: "e1" }),
        },
        queueUrl
      );

      expect(deleted.length).toBe(0);
    });
  });
});
