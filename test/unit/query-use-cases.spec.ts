import { beforeEach, describe, expect, it } from "bun:test";
import {
  TransactionNotFoundError,
  WalletNotFoundError,
} from "../../src/application/errors/application-errors";
import { GetTransactionUseCase } from "../../src/application/use-cases/get-transaction.use-case";
import { GetWalletUseCase } from "../../src/application/use-cases/get-wallet.use-case";
import { GetWalletLedgerUseCase } from "../../src/application/use-cases/get-wallet-ledger.use-case";
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/entities/wager-transaction";
import { LedgerDirection } from "../../src/domain/entities/wallet-ledger-entry";
import {
  WagerTransactionOrmEntity,
  WalletLedgerEntryOrmEntity,
  WalletOrmEntity,
} from "../../src/infrastructure/database/entities";
import { InMemoryTestEntityManager } from "../helpers/mock-entity-manager";

function createLocalLedgerEm(wallets: WalletOrmEntity[], entries: WalletLedgerEntryOrmEntity[]) {
  const capturedLimits: number[] = [];

  const em = {
    findOne: async (entityClass: unknown, filter: Record<string, unknown>) => {
      if (entityClass === WalletOrmEntity) {
        return wallets.find((w) => w.id === filter.id) ?? null;
      }
      return null;
    },
    createQueryBuilder: (_entityClass: unknown, _alias: string) => {
      let filtered = [...entries];
      let limitValue: number | undefined;

      const qb = {
        where: (cond: { walletId?: string }) => {
          if (cond.walletId !== undefined) {
            filtered = filtered.filter((e) => e.walletId === cond.walletId);
          }
          return qb;
        },
        andWhere: (_clause: string, params: unknown[]) => {
          const cursorDate = params[0] as Date;
          const cursorId = params[2] as string;
          const cursorMs = cursorDate.getTime();
          filtered = filtered.filter((e) => {
            const entryMs = e.createdAt.getTime();
            return entryMs < cursorMs || (entryMs === cursorMs && e.id < cursorId);
          });
          return qb;
        },
        orderBy: (_order: Record<string, "ASC" | "DESC">) => {
          filtered.sort((a, b) => {
            const timeDiff = b.createdAt.getTime() - a.createdAt.getTime();
            if (timeDiff !== 0) return timeDiff;
            return b.id.localeCompare(a.id);
          });
          return qb;
        },
        limit: (n: number) => {
          capturedLimits.push(n);
          limitValue = n;
          return qb;
        },
        getResultList: async () => {
          if (limitValue !== undefined) {
            return filtered.slice(0, limitValue);
          }
          return filtered;
        },
      };

      return qb;
    },
  };

  return { em, capturedLimits };
}

describe("Query Use Cases", () => {
  describe("GetWalletUseCase", () => {
    let em: InMemoryTestEntityManager;
    let useCase: GetWalletUseCase;

    beforeEach(() => {
      em = new InMemoryTestEntityManager();
      useCase = new GetWalletUseCase(em as any);
    });

    it("deve retornar a carteira mapeada quando encontrada", async () => {
      const createdAt = new Date("2026-01-01T10:00:00.000Z");
      const updatedAt = new Date("2026-01-01T11:00:00.000Z");
      const wallet = Object.assign(new WalletOrmEntity(), {
        id: "wallet-1",
        playerId: "player-1",
        balance: "250.50",
        currency: "BRL",
        version: 3,
        createdAt,
        updatedAt,
      });
      em.wallets.set(wallet.id, wallet);

      const result = await useCase.execute("wallet-1");

      expect(result).toEqual({
        id: "wallet-1",
        playerId: "player-1",
        balance: { amount: "250.50", currency: "BRL" },
        version: 3,
        createdAt,
        updatedAt,
      });
    });

    it("deve lançar WalletNotFoundError quando a carteira não existir", async () => {
      await expect(useCase.execute("missing-wallet")).rejects.toBeInstanceOf(WalletNotFoundError);
      await expect(useCase.execute("missing-wallet")).rejects.toThrow(
        "Wallet missing-wallet not found"
      );
    });
  });

  describe("GetTransactionUseCase", () => {
    let em: InMemoryTestEntityManager;
    let useCase: GetTransactionUseCase;

    beforeEach(() => {
      em = new InMemoryTestEntityManager();
      useCase = new GetTransactionUseCase(em as any);
    });

    it("deve buscar transação por ID e mapear todos os campos do DTO sem expor campos internos", async () => {
      const createdAt = new Date("2026-01-02T10:00:00.000Z");
      const processedAt = new Date("2026-01-02T10:00:01.000Z");
      const tx = Object.assign(new WagerTransactionOrmEntity(), {
        id: "tx-1",
        providerId: "prov-1",
        externalTransactionId: "ext-1",
        idempotencyKey: "prov-1:ext-1",
        payloadHash: "secret-hash",
        walletId: "wallet-1",
        playerId: "player-1",
        roundId: "round-1",
        gameId: "game-1",
        kind: WagerTransactionKind.Refund,
        amount: "50.00",
        currency: "USD",
        status: WagerTransactionStatus.Rejected,
        referenceExternalTransactionId: "ext-0",
        referenceTransactionId: "tx-0",
        failureCode: FailureCode.InsufficientFunds,
        observedBalance: "100.00",
        observedBalanceCurrency: "USD",
        createdAt,
        processedAt,
      });
      em.transactions.set(tx.id, tx);

      const dto = await useCase.executeById("tx-1");

      expect(dto).toEqual({
        id: "tx-1",
        providerId: "prov-1",
        externalTransactionId: "ext-1",
        idempotencyKey: "prov-1:ext-1",
        walletId: "wallet-1",
        playerId: "player-1",
        roundId: "round-1",
        gameId: "game-1",
        kind: WagerTransactionKind.Refund,
        money: { amount: "50.00", currency: "USD" },
        status: WagerTransactionStatus.Rejected,
        referenceExternalTransactionId: "ext-0",
        referenceTransactionId: "tx-0",
        failureCode: FailureCode.InsufficientFunds,
        createdAt,
        processedAt,
      });
      expect("payloadHash" in dto).toBe(false);
      expect("observedBalance" in dto).toBe(false);
      expect("observedBalanceCurrency" in dto).toBe(false);
    });

    it("deve lançar TransactionNotFoundError quando executeById não encontrar a transação", async () => {
      await expect(useCase.executeById("tx-missing")).rejects.toBeInstanceOf(
        TransactionNotFoundError
      );
      await expect(useCase.executeById("tx-missing")).rejects.toThrow(
        "Transaction tx-missing not found"
      );
    });

    it("deve buscar transação por providerId e externalTransactionId", async () => {
      const tx = Object.assign(new WagerTransactionOrmEntity(), {
        id: "tx-2",
        providerId: "prov-a",
        externalTransactionId: "ext-2",
        idempotencyKey: "prov-a:ext-2",
        payloadHash: "hash-2",
        walletId: "wallet-2",
        playerId: "player-2",
        roundId: "round-2",
        gameId: "game-2",
        kind: WagerTransactionKind.Bet,
        amount: "25.00",
        currency: "BRL",
        status: WagerTransactionStatus.Processed,
        createdAt: new Date("2026-01-03T10:00:00.000Z"),
      });
      em.transactions.set(tx.id, tx);

      const dto = await useCase.executeByExternalId("prov-a", "ext-2");
      expect(dto.id).toBe("tx-2");
      expect(dto.money).toEqual({ amount: "25.00", currency: "BRL" });
      expect(dto.processedAt).toBeUndefined();
      expect(dto.failureCode).toBeUndefined();
    });

    it("deve lançar TransactionNotFoundError quando executeByExternalId não encontrar", async () => {
      await expect(useCase.executeByExternalId("prov-a", "ext-missing")).rejects.toBeInstanceOf(
        TransactionNotFoundError
      );
      await expect(useCase.executeByExternalId("prov-a", "ext-missing")).rejects.toThrow(
        "Transaction prov-a:ext-missing not found"
      );
    });
  });

  describe("GetWalletLedgerUseCase", () => {
    const makeWallet = (id = "wallet-1"): WalletOrmEntity =>
      Object.assign(new WalletOrmEntity(), {
        id,
        playerId: "player-1",
        balance: "100.00",
        currency: "BRL",
        version: 1,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      });

    const makeEntry = (
      id: string,
      createdAtIso: string,
      overrides: Partial<WalletLedgerEntryOrmEntity> = {}
    ): WalletLedgerEntryOrmEntity =>
      Object.assign(new WalletLedgerEntryOrmEntity(), {
        id,
        walletId: "wallet-1",
        transactionId: `tx-${id}`,
        direction: LedgerDirection.Credit,
        amount: "10.00",
        currency: "BRL",
        balanceBefore: "0.00",
        balanceAfter: "10.00",
        createdAt: new Date(createdAtIso),
        ...overrides,
      });

    it("deve lançar WalletNotFoundError se a carteira não existir", async () => {
      const { em } = createLocalLedgerEm([], []);
      const useCase = new GetWalletLedgerUseCase(em as any);

      await expect(useCase.execute({ walletId: "missing" })).rejects.toBeInstanceOf(
        WalletNotFoundError
      );
    });

    it("deve retornar lista vazia quando não houver lançamentos", async () => {
      const { em } = createLocalLedgerEm([makeWallet()], []);
      const useCase = new GetWalletLedgerUseCase(em as any);

      const result = await useCase.execute({ walletId: "wallet-1" });

      expect(result).toEqual({
        items: [],
        hasMore: false,
        nextCursor: undefined,
      });
    });

    it("deve normalizar e limitar o parâmetro limit entre 1 e 100 com fallback 50", async () => {
      const { em, capturedLimits } = createLocalLedgerEm([makeWallet()], []);
      const useCase = new GetWalletLedgerUseCase(em as any);

      await useCase.execute({ walletId: "wallet-1" });
      await useCase.execute({ walletId: "wallet-1", limit: Number.NaN });
      await useCase.execute({ walletId: "wallet-1", limit: Number.POSITIVE_INFINITY });
      await useCase.execute({ walletId: "wallet-1", limit: Number.NEGATIVE_INFINITY });
      await useCase.execute({ walletId: "wallet-1", limit: 0 });
      await useCase.execute({ walletId: "wallet-1", limit: -15 });
      await useCase.execute({ walletId: "wallet-1", limit: 0.5 });
      await useCase.execute({ walletId: "wallet-1", limit: 101 });
      await useCase.execute({ walletId: "wallet-1", limit: 10.9 });

      expect(capturedLimits).toEqual([51, 51, 51, 51, 2, 2, 2, 101, 11]);
    });

    it("deve paginar corretamente com cursor, hasMore e ordenação DESC incluindo desempate por id", async () => {
      const entries = [
        makeEntry("01950000-0000-7000-8000-000000000001", "2026-01-01T10:00:00.000Z"),
        makeEntry("01950000-0000-7000-8000-000000000002", "2026-01-01T11:00:00.000Z"),
        makeEntry("01950000-0000-7000-8000-000000000003", "2026-01-01T11:00:00.000Z"),
        makeEntry("01950000-0000-7000-8000-000000000004", "2026-01-01T12:00:00.000Z", {
          direction: LedgerDirection.Debit,
          amount: "20.00",
          balanceBefore: "100.00",
          balanceAfter: "80.00",
        }),
      ];

      const { em } = createLocalLedgerEm([makeWallet()], entries);
      const useCase = new GetWalletLedgerUseCase(em as any);

      const page1 = await useCase.execute({ walletId: "wallet-1", limit: 2 });
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).toBeDefined();
      expect(page1.items.map((i) => i.id)).toEqual([
        "01950000-0000-7000-8000-000000000004",
        "01950000-0000-7000-8000-000000000003",
      ]);
      expect(page1.items[0]?.money).toEqual({ amount: "20.00", currency: "BRL" });
      expect(page1.items[0]?.balanceBefore).toEqual({ amount: "100.00", currency: "BRL" });
      expect(page1.items[0]?.balanceAfter).toEqual({ amount: "80.00", currency: "BRL" });

      const page2 = await useCase.execute({
        walletId: "wallet-1",
        limit: 2,
        cursor: page1.nextCursor,
      });
      expect(page2.hasMore).toBe(false);
      expect(page2.nextCursor).toBeUndefined();
      expect(page2.items.map((i) => i.id)).toEqual([
        "01950000-0000-7000-8000-000000000002",
        "01950000-0000-7000-8000-000000000001",
      ]);
    });

    it("deve ignorar cursor inválido e retornar a primeira página sem erro", async () => {
      const entries = [
        makeEntry("id-1", "2026-01-01T10:00:00.000Z"),
        makeEntry("id-2", "2026-01-01T11:00:00.000Z"),
      ];
      const { em } = createLocalLedgerEm([makeWallet()], entries);
      const useCase = new GetWalletLedgerUseCase(em as any);

      const result = await useCase.execute({
        walletId: "wallet-1",
        cursor: "invalid-base64-cursor",
      });

      expect(result.items.map((i) => i.id)).toEqual(["id-2", "id-1"]);
      expect(result.hasMore).toBe(false);
    });
  });
});
