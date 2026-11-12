import { describe, expect, it } from "bun:test";
import { LockMode } from "@mikro-orm/postgresql";
import { ArgumentsHost, ForbiddenException } from "@nestjs/common";
import { InvalidTransactionKindError } from "../../src/application/errors/application-errors";
import { GetWalletLedgerUseCase } from "../../src/application/use-cases/get-wallet-ledger.use-case";
import { OpenWalletUseCase } from "../../src/application/use-cases/open-wallet.use-case";
import { ProcessWagerTransactionUseCase } from "../../src/application/use-cases/process-wager-transaction.use-case";
import { ReconcileWalletUseCase } from "../../src/application/use-cases/reconcile-wallet.use-case";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/entities/wager-transaction";
import { WalletOrmEntity } from "../../src/infrastructure/database/entities";
import { WageringController } from "../../src/presentation/controllers/wagering.controller";
import { GlobalHttpExceptionFilter } from "../../src/presentation/filters/http-exception.filter";
import { AuthGuard } from "../../src/presentation/guards/auth.guard";
import { InMemoryTestEntityManager } from "../helpers/mock-entity-manager";

describe("M2 Core Domain & Presentation Fixes", () => {
  describe("GetWalletLedgerUseCase limit sanitization", () => {
    const createLedgerEm = () => {
      const capturedLimits: number[] = [];
      const em = {
        findOne: async () => ({ id: "wallet-1", playerId: "player-1", currency: "BRL" }),
        createQueryBuilder: () => {
          const qb = {
            where: () => qb,
            andWhere: () => qb,
            orderBy: () => qb,
            limit: (n: number) => {
              capturedLimits.push(n);
              return qb;
            },
            getResultList: async () => [],
          };
          return qb;
        },
      };
      return { em, capturedLimits };
    };

    it("deve usar fallback 50 quando limit é NaN ou Infinity, e clamp [1, 100] para inteiros finitos", async () => {
      const { em, capturedLimits } = createLedgerEm();
      const useCase = new GetWalletLedgerUseCase(em as any);

      await useCase.execute({ walletId: "wallet-1", limit: Number.NaN });
      await useCase.execute({ walletId: "wallet-1", limit: Number.POSITIVE_INFINITY });
      await useCase.execute({ walletId: "wallet-1", limit: 0 });
      await useCase.execute({ walletId: "wallet-1", limit: 500 });
      await useCase.execute({ walletId: "wallet-1", limit: 10.7 });

      // qb.limit recebe (limit + 1) para detecção de hasMore
      expect(capturedLimits).toEqual([51, 51, 2, 101, 11]);
    });
  });

  describe("ProcessWagerTransactionUseCase", () => {
    it("deve lançar InvalidTransactionKindError quando kind é OPENING", async () => {
      const em = new InMemoryTestEntityManager();
      const useCase = new ProcessWagerTransactionUseCase(em as any);

      await expect(
        useCase.execute({
          providerId: "provider-a",
          externalTransactionId: "ext-opening-1",
          idempotencyKey: "provider-a:ext-opening-1",
          playerId: "player-1",
          walletId: "wallet-1",
          roundId: "round-1",
          gameId: "game-1",
          kind: WagerTransactionKind.Opening,
          money: { amount: "100.00", currency: "BRL" },
        })
      ).rejects.toThrow(InvalidTransactionKindError);
    });

    it("deve executar SET LOCAL lock_timeout = '5000ms' antes de adquirir lock pessimista quando getConnection() existir", async () => {
      const executedSql: string[] = [];
      const lockModesUsed: (LockMode | undefined)[] = [];

      const walletOrm = new WalletOrmEntity();
      walletOrm.id = "wallet-lock-test";
      walletOrm.playerId = "player-1";
      walletOrm.currency = "BRL";
      walletOrm.balance = "100.00";
      walletOrm.version = 1;
      walletOrm.createdAt = new Date();
      walletOrm.updatedAt = new Date();

      const fakeTxEm = {
        getConnection: () => ({
          execute: async (sql: string) => {
            executedSql.push(sql);
            return [];
          },
        }),
        findOne: async (
          entityClass: unknown,
          _filter: unknown,
          options?: { lockMode?: LockMode }
        ) => {
          if (entityClass === WalletOrmEntity) {
            lockModesUsed.push(options?.lockMode);
            return walletOrm;
          }
          return null;
        },
        create: (_entityClass: unknown, data: Record<string, unknown>) => data,
        persist: () => {},
        flush: async () => {},
      };

      const fakeEm = {
        transactional: async <T>(cb: (txEm: typeof fakeTxEm) => Promise<T>) => cb(fakeTxEm),
      };

      const useCase = new ProcessWagerTransactionUseCase(fakeEm as any);
      const result = await useCase.execute({
        providerId: "provider-a",
        externalTransactionId: "ext-bet-1",
        idempotencyKey: "provider-a:ext-bet-1",
        playerId: "player-1",
        walletId: "wallet-lock-test",
        roundId: "round-1",
        gameId: "game-1",
        kind: WagerTransactionKind.Bet,
        money: { amount: "25.00", currency: "BRL" },
      });

      expect(result.status).toBe(WagerTransactionStatus.Processed);
      expect(result.balance.amount).toBe("75.00");
      expect(executedSql).toContain("SET LOCAL lock_timeout = '5000ms'");
      expect(lockModesUsed).toEqual([LockMode.PESSIMISTIC_WRITE]);
    });
  });

  describe("GlobalHttpExceptionFilter", () => {
    const createMockHost = () => {
      let capturedStatus = 0;
      let capturedBody: Record<string, unknown> = {};
      const response = {
        status: (code: number) => {
          capturedStatus = code;
          return response;
        },
        json: (body: Record<string, unknown>) => {
          capturedBody = body;
          return response;
        },
      };
      const host = {
        switchToHttp: () => ({
          getResponse: () => response,
        }),
      } as unknown as ArgumentsHost;

      return {
        host,
        getStatus: () => capturedStatus,
        getBody: () => capturedBody,
      };
    };

    it("deve mapear InvalidTransactionKindError para HTTP 400", () => {
      const filter = new GlobalHttpExceptionFilter();
      const mock = createMockHost();

      filter.catch(new InvalidTransactionKindError(WagerTransactionKind.Opening), mock.host);

      expect(mock.getStatus()).toBe(400);
      expect(mock.getBody().statusCode).toBe(400);
      expect(mock.getBody().errorCode).toBe("INVALID_TRANSACTION_KIND");
    });

    it("deve mapear ForbiddenException para HTTP 403", () => {
      const filter = new GlobalHttpExceptionFilter();
      const mock = createMockHost();

      filter.catch(new ForbiddenException("Provider identity mismatch"), mock.host);

      expect(mock.getStatus()).toBe(403);
      expect(mock.getBody().statusCode).toBe(403);
      expect(mock.getBody().message).toBe("Provider identity mismatch");
    });
  });

  describe("ReconcileWalletUseCase", () => {
    it("deve usar transactional com PESSIMISTIC_READ e agregação SQL SUM/COUNT quando getConnection() existir", async () => {
      let sqlCalled = false;
      let lockModeUsed: LockMode | undefined;

      const walletOrm = new WalletOrmEntity();
      walletOrm.id = "wallet-sql-1";
      walletOrm.playerId = "player-1";
      walletOrm.currency = "BRL";
      walletOrm.balance = "150.00";
      walletOrm.version = 3;
      walletOrm.createdAt = new Date();
      walletOrm.updatedAt = new Date();

      const fakeTxEm = {
        findOne: async (
          _entityClass: unknown,
          _filter: unknown,
          options?: { lockMode?: LockMode }
        ) => {
          lockModeUsed = options?.lockMode;
          return walletOrm;
        },
        getConnection: () => ({
          execute: async (sql: string, params: unknown[]) => {
            sqlCalled = true;
            expect(sql).toContain("SUM");
            expect(sql).toContain("COUNT");
            expect(sql).toContain("wallet_ledger_entries");
            expect(params).toEqual(["wallet-sql-1"]);
            return [{ netBalance: "150.00", checkedEntries: 4 }];
          },
        }),
      };

      const fakeEm = {
        transactional: async <T>(cb: (txEm: typeof fakeTxEm) => Promise<T>) => cb(fakeTxEm),
      };

      const useCase = new ReconcileWalletUseCase(fakeEm as any);
      const result = await useCase.execute("wallet-sql-1");

      expect(sqlCalled).toBe(true);
      expect(lockModeUsed).toBe(LockMode.PESSIMISTIC_READ);
      expect(result.consistent).toBe(true);
      expect(result.calculatedBalance.amount).toBe("150.00");
      expect(result.checkedEntries).toBe(4);
    });

    it("deve funcionar corretamente via fallback em memória com InMemoryTestEntityManager", async () => {
      const em = new InMemoryTestEntityManager();
      const openWallet = new OpenWalletUseCase(em as any);
      const processWager = new ProcessWagerTransactionUseCase(em as any);
      const reconcile = new ReconcileWalletUseCase(em as any);

      const wallet = await openWallet.execute({
        playerId: "player-mem",
        initialBalance: { amount: "200.00", currency: "BRL" },
      });

      await processWager.execute({
        providerId: "provider-a",
        externalTransactionId: "bet-mem-1",
        idempotencyKey: "provider-a:bet-mem-1",
        playerId: "player-mem",
        walletId: wallet.id,
        roundId: "r-1",
        gameId: "g-1",
        kind: WagerTransactionKind.Bet,
        money: { amount: "50.00", currency: "BRL" },
      });

      const result = await reconcile.execute(wallet.id);
      expect(result.consistent).toBe(true);
      expect(result.storedBalance.amount).toBe("150.00");
      expect(result.calculatedBalance.amount).toBe("150.00");
      expect(result.checkedEntries).toBe(2);
    });
  });

  describe("WageringController & AuthGuard provider identity enforcement", () => {
    it("AuthGuard deve normalizar x-provider-id quando recebido como string[]", () => {
      const guard = new AuthGuard();
      const request: {
        url: string;
        headers: Record<string, string | string[]>;
        providerIdentity?: unknown;
      } = {
        url: "/wagering/transactions",
        headers: { "x-provider-id": ["provider-b", "provider-c"] },
      };

      const context = {
        switchToHttp: () => ({
          getRequest: () => request,
        }),
      } as any;

      expect(guard.canActivate(context)).toBe(true);
      expect(request.providerIdentity).toEqual({
        providerId: "provider-b",
        authenticated: true,
      });
    });

    it("WageringController deve rejeitar com ForbiddenException quando providerIdentity diverge do body.providerId", async () => {
      const mockProcessUseCase = {
        execute: async () => ({
          transactionId: "tx-1",
          status: WagerTransactionStatus.Processed,
          balance: { amount: "100.00", currency: "BRL" },
          idempotentReplay: false,
        }),
      };
      const mockGetUseCase = {
        executeById: async () => ({}),
        executeByExternalId: async () => ({}),
      };

      const controller = new WageringController(mockProcessUseCase as any, mockGetUseCase as any);

      await expect(
        controller.submitTransaction(
          "key-1",
          {
            providerId: "provider-b",
            externalTransactionId: "ext-1",
            playerId: "player-1",
            walletId: "wallet-1",
            roundId: "round-1",
            gameId: "game-1",
            kind: WagerTransactionKind.Bet,
            money: { amount: "10.00", currency: "BRL" },
          },
          { providerIdentity: { providerId: "provider-a", authenticated: true } } as any
        )
      ).rejects.toThrow(ForbiddenException);
    });

    it("WageringController deve permitir quando providerIdentity corresponde ao body.providerId", async () => {
      const mockProcessUseCase = {
        execute: async () => ({
          transactionId: "tx-1",
          status: WagerTransactionStatus.Processed,
          balance: { amount: "90.00", currency: "BRL" },
          idempotentReplay: false,
        }),
      };
      const mockGetUseCase = {
        executeById: async () => ({}),
        executeByExternalId: async () => ({}),
      };

      const controller = new WageringController(mockProcessUseCase as any, mockGetUseCase as any);

      const result = await controller.submitTransaction(
        "key-1",
        {
          providerId: "provider-a",
          externalTransactionId: "ext-1",
          playerId: "player-1",
          walletId: "wallet-1",
          roundId: "round-1",
          gameId: "game-1",
          kind: WagerTransactionKind.Bet,
          money: { amount: "10.00", currency: "BRL" },
        },
        { providerIdentity: { providerId: "provider-a", authenticated: true } } as any
      );

      expect(result.status).toBe(WagerTransactionStatus.Processed);
      expect(result.balance.amount).toBe("90.00");
    });
  });
});
