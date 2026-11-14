import { describe, expect, it } from "bun:test";
import { InboxMessage } from "../../src/domain/entities/inbox-message";
import { OutboxMessage } from "../../src/domain/entities/outbox-message";
import { LedgerDirection } from "../../src/domain/entities/wallet-ledger-entry";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../../src/domain/events/integration-event";

describe("Messaging Entities & Integration Events", () => {
  describe("InboxMessage", () => {
    it("deve criar mensagem via receive com receivedAt padrão e não processada", () => {
      const msg = InboxMessage.receive({
        messageId: "msg-1",
        consumerName: "wager-consumer",
        payloadHash: "hash-abc",
      });

      expect(msg.messageId).toBe("msg-1");
      expect(msg.consumerName).toBe("wager-consumer");
      expect(msg.payloadHash).toBe("hash-abc");
      expect(msg.receivedAt).toBeInstanceOf(Date);
      expect(msg.processedAt).toBeUndefined();
      expect(msg.isProcessed()).toBe(false);
    });

    it("deve preservar receivedAt explícito e marcar como processada via markProcessed", () => {
      const receivedAt = new Date("2026-01-01T10:00:00.000Z");
      const processedAt = new Date("2026-01-01T10:00:05.000Z");

      const msg = InboxMessage.receive({
        messageId: "msg-2",
        consumerName: "wager-consumer",
        payloadHash: "hash-def",
        receivedAt,
      });

      expect(msg.receivedAt).toBe(receivedAt);
      msg.markProcessed(processedAt);

      expect(msg.isProcessed()).toBe(true);
      expect(msg.processedAt).toBe(processedAt);
    });

    it("deve reidratar estado processado e não processado", () => {
      const receivedAt = new Date("2026-01-01T10:00:00.000Z");
      const processedAt = new Date("2026-01-01T10:01:00.000Z");

      const pending = InboxMessage.rehydrate({
        messageId: "msg-3",
        consumerName: "consumer",
        payloadHash: "h1",
        receivedAt,
      });
      expect(pending.isProcessed()).toBe(false);
      expect(pending.processedAt).toBeUndefined();

      const done = InboxMessage.rehydrate({
        messageId: "msg-4",
        consumerName: "consumer",
        payloadHash: "h2",
        receivedAt,
        processedAt,
      });
      expect(done.isProcessed()).toBe(true);
      expect(done.processedAt).toBe(processedAt);
    });
  });

  describe("IntegrationEvent subclasses", () => {
    it("deve instanciar WalletBalanceChanged com freeze superficial em data e toJSON()", () => {
      const occurredAt = new Date("2026-02-01T12:00:00.000Z");
      const event = new WalletBalanceChanged({
        eventId: "evt-1",
        aggregateId: "wallet-1",
        correlationId: "corr-1",
        causationId: "cause-1",
        occurredAt,
        data: {
          walletId: "wallet-1",
          transactionId: "tx-1",
          direction: LedgerDirection.Credit,
          money: { amount: "50.00", currency: "BRL" },
          balanceBefore: { amount: "100.00", currency: "BRL" },
          balanceAfter: { amount: "150.00", currency: "BRL" },
          walletVersion: 2,
        },
      });

      expect(event.eventType).toBe("WalletBalanceChanged");
      expect(event.version).toBe(1);
      expect(Object.isFrozen(event.data)).toBe(true);
      expect(() => {
        (event.data as { walletVersion: number }).walletVersion = 99;
      }).toThrow(TypeError);

      expect(event.toJSON()).toEqual({
        eventId: "evt-1",
        eventType: "WalletBalanceChanged",
        aggregateId: "wallet-1",
        correlationId: "corr-1",
        causationId: "cause-1",
        occurredAt: "2026-02-01T12:00:00.000Z",
        version: 1,
        data: event.data,
      });
    });

    it("deve instanciar WagerTransactionProcessed, WagerTransactionRejected e WagerTransactionPendingReference", () => {
      const processed = new WagerTransactionProcessed({
        eventId: "evt-2",
        aggregateId: "tx-2",
        correlationId: "corr-2",
        data: {
          transactionId: "tx-2",
          providerId: "prov-a",
          externalTransactionId: "ext-2",
          walletId: "wallet-1",
          playerId: "player-1",
          roundId: "round-1",
          gameId: "game-1",
          kind: "BET",
          money: { amount: "10.00", currency: "USD" },
          balanceAfter: { amount: "90.00", currency: "USD" },
        },
      });
      expect(processed.eventType).toBe("WagerTransactionProcessed");
      expect(processed.version).toBe(1);
      expect(processed.causationId).toBeUndefined();
      expect(processed.occurredAt).toBeInstanceOf(Date);
      expect(Object.isFrozen(processed.data)).toBe(true);

      const rejected = new WagerTransactionRejected({
        eventId: "evt-3",
        aggregateId: "tx-3",
        correlationId: "corr-3",
        data: {
          transactionId: "tx-3",
          providerId: "prov-a",
          externalTransactionId: "ext-3",
          walletId: "wallet-1",
          playerId: "player-1",
          roundId: "round-1",
          gameId: "game-1",
          kind: "BET",
          money: { amount: "500.00", currency: "USD" },
          failureCode: "INSUFFICIENT_FUNDS",
        },
      });
      expect(rejected.eventType).toBe("WagerTransactionRejected");
      expect(rejected.version).toBe(1);
      expect(rejected.toJSON().data.failureCode).toBe("INSUFFICIENT_FUNDS");

      const pendingRef = new WagerTransactionPendingReference({
        eventId: "evt-4",
        aggregateId: "tx-4",
        correlationId: "corr-4",
        data: {
          transactionId: "tx-4",
          providerId: "prov-a",
          externalTransactionId: "ext-4",
          referenceExternalTransactionId: "ext-1",
          walletId: "wallet-1",
          playerId: "player-1",
          roundId: "round-1",
          gameId: "game-1",
          kind: "REFUND",
          money: { amount: "10.00", currency: "USD" },
        },
      });
      expect(pendingRef.eventType).toBe("WagerTransactionPendingReference");
      expect(pendingRef.version).toBe(1);
      expect(pendingRef.toJSON().data.referenceExternalTransactionId).toBe("ext-1");
    });
  });

  describe("OutboxMessage", () => {
    const createSampleEvent = () =>
      new WalletBalanceChanged({
        eventId: "evt-10",
        aggregateId: "wallet-10",
        correlationId: "corr-10",
        occurredAt: new Date("2026-02-01T00:00:00.000Z"),
        data: {
          walletId: "wallet-10",
          transactionId: "tx-10",
          direction: LedgerDirection.Debit,
          money: { amount: "20.00", currency: "BRL" },
          balanceBefore: { amount: "100.00", currency: "BRL" },
          balanceAfter: { amount: "80.00", currency: "BRL" },
          walletVersion: 1,
        },
      });

    it("deve enfileirar evento com payload congelado, attempts 0 e pendente/due imediato", () => {
      const event = createSampleEvent();
      const outbox = OutboxMessage.enqueue(event);

      expect(typeof outbox.id).toBe("string");
      expect(outbox.id.length).toBeGreaterThan(0);
      expect(outbox.aggregateId).toBe("wallet-10");
      expect(outbox.eventType).toBe("WalletBalanceChanged");
      expect(outbox.occurredAt).toEqual(event.occurredAt);
      expect(outbox.attempts).toBe(0);
      expect(outbox.publishedAt).toBeUndefined();
      expect(outbox.isPending()).toBe(true);
      expect(outbox.isDue(new Date(Date.now() + 1000))).toBe(true);
      expect(Object.isFrozen(outbox.payload)).toBe(true);
      expect(() => {
        (outbox.payload as Record<string, unknown>).eventType = "OTHER";
      }).toThrow(TypeError);
    });

    it("deve avaliar isDue corretamente para publicada, sem nextAttemptAt e limites de timestamp", () => {
      const baseTime = new Date("2026-02-01T10:00:00.000Z");
      const futureTime = new Date("2026-02-01T10:00:10.000Z");

      const published = OutboxMessage.rehydrate({
        id: "ob-1",
        aggregateId: "w-1",
        eventType: "WalletBalanceChanged",
        payload: {},
        occurredAt: baseTime,
        attempts: 1,
        publishedAt: baseTime,
      });
      expect(published.isPending()).toBe(false);
      expect(published.isDue(futureTime)).toBe(false);

      const noNextAttempt = OutboxMessage.rehydrate({
        id: "ob-2",
        aggregateId: "w-1",
        eventType: "WalletBalanceChanged",
        payload: {},
        occurredAt: baseTime,
        attempts: 0,
      });
      expect(noNextAttempt.isDue(baseTime)).toBe(true);

      const scheduled = OutboxMessage.rehydrate({
        id: "ob-3",
        aggregateId: "w-1",
        eventType: "WalletBalanceChanged",
        payload: {},
        occurredAt: baseTime,
        attempts: 1,
        nextAttemptAt: futureTime,
      });
      expect(scheduled.isDue(new Date(futureTime.getTime() - 1))).toBe(false);
      expect(scheduled.isDue(futureTime)).toBe(true);
      expect(scheduled.isDue(new Date(futureTime.getTime() + 1))).toBe(true);
    });

    it("deve marcar como publicada e limpar nextAttemptAt via markPublished", () => {
      const outbox = OutboxMessage.enqueue(createSampleEvent());
      const publishedAt = new Date("2026-02-01T10:05:00.000Z");

      outbox.markPublished(publishedAt);

      expect(outbox.publishedAt).toBe(publishedAt);
      expect(outbox.nextAttemptAt).toBeUndefined();
      expect(outbox.isPending()).toBe(false);
      expect(outbox.isDue(publishedAt)).toBe(false);
    });

    it("deve aplicar backoff exponencial em scheduleRetry com teto de 60 segundos", () => {
      const outbox = OutboxMessage.enqueue(createSampleEvent());
      const now = new Date("2026-02-01T10:00:00.000Z");
      const expectedDelaysSec = [1, 2, 4, 8, 16, 32, 60, 60];

      expectedDelaysSec.forEach((expectedSec, idx) => {
        outbox.scheduleRetry(now);
        expect(outbox.attempts).toBe(idx + 1);
        expect(outbox.nextAttemptAt?.getTime()).toBe(now.getTime() + expectedSec * 1000);
      });
    });
  });
});
