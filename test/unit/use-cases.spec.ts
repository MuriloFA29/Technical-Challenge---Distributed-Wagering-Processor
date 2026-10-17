import { beforeEach, describe, expect, it } from "bun:test";
import { InMemoryTestEntityManager } from "../helpers/mock-entity-manager";
import { OpenWalletUseCase } from "../../src/application/use-cases/open-wallet.use-case";
import { ProcessWagerTransactionUseCase } from "../../src/application/use-cases/process-wager-transaction.use-case";
import { ReconcileWalletUseCase } from "../../src/application/use-cases/reconcile-wallet.use-case";
import {
  IdempotencyConflictError,
  WalletAlreadyExistsError,
} from "../../src/application/errors/application-errors";
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/entities/wager-transaction";
import { LedgerDirection } from "../../src/domain/entities/wallet-ledger-entry";

describe("Application Layer & Use Cases", () => {
  let em: InMemoryTestEntityManager;
  let openWalletUseCase: OpenWalletUseCase;
  let processWagerUseCase: ProcessWagerTransactionUseCase;
  let reconcileWalletUseCase: ReconcileWalletUseCase;

  beforeEach(() => {
    em = new InMemoryTestEntityManager();
    openWalletUseCase = new OpenWalletUseCase(em as any);
    processWagerUseCase = new ProcessWagerTransactionUseCase(em as any);
    reconcileWalletUseCase = new ReconcileWalletUseCase(em as any);
  });

  describe("OpenWalletUseCase", () => {
    it("deve abrir wallet com saldo inicial zero e version 1 sem criar ledger", async () => {
      const result = await openWalletUseCase.execute({
        playerId: "player-zero",
        initialBalance: { amount: "0.00", currency: "BRL" },
      });

      expect(result.id).toBeDefined();
      expect(result.playerId).toBe("player-zero");
      expect(result.balance.amount).toBe("0.00");
      expect(result.version).toBe(1);

      // Não deve gerar ledger nem transação OPENING para saldo 0.00
      expect(em.ledgerEntries.size).toBe(0);
      expect(em.transactions.size).toBe(0);
    });

    it("deve abrir wallet com saldo inicial positivo gerando transação OPENING e ledger CREDIT", async () => {
      const result = await openWalletUseCase.execute({
        playerId: "player-1",
        initialBalance: { amount: "500.00", currency: "BRL" },
      });

      expect(result.balance.amount).toBe("500.00");
      expect(result.version).toBe(1);

      // Deve ter criado 1 transação OPENING e 1 lançamento CREDIT no ledger
      expect(em.transactions.size).toBe(1);
      const openingTx = Array.from(em.transactions.values())[0];
      expect(openingTx.kind).toBe(WagerTransactionKind.Opening);
      expect(openingTx.status).toBe(WagerTransactionStatus.Processed);
      expect(openingTx.observedBalance).toBe("500.00");

      expect(em.ledgerEntries.size).toBe(1);
      const ledgerEntry = Array.from(em.ledgerEntries.values())[0];
      expect(ledgerEntry.direction).toBe(LedgerDirection.Credit);
      expect(ledgerEntry.amount).toBe("500.00");
      expect(ledgerEntry.balanceBefore).toBe("0.00");
      expect(ledgerEntry.balanceAfter).toBe("500.00");
    });

    it("deve lançar WalletAlreadyExistsError ao tentar abrir wallet duplicada para mesmo jogador e moeda", async () => {
      await openWalletUseCase.execute({
        playerId: "player-dup",
        initialBalance: { amount: "100.00", currency: "BRL" },
      });

      expect(
        openWalletUseCase.execute({
          playerId: "player-dup",
          initialBalance: { amount: "200.00", currency: "BRL" },
        })
      ).rejects.toThrow(WalletAlreadyExistsError);
    });
  });

  describe("ProcessWagerTransactionUseCase", () => {
    let walletId: string;

    beforeEach(async () => {
      const w = await openWalletUseCase.execute({
        playerId: "player-wager",
        initialBalance: { amount: "100.00", currency: "BRL" },
      });
      walletId = w.id;
    });

    it("deve processar uma aposta BET debitando o saldo e incrementando a version", async () => {
      const result = await processWagerUseCase.execute({
        providerId: "prov-a",
        externalTransactionId: "tx-1",
        idempotencyKey: "prov-a:tx-1",
        playerId: "player-wager",
        walletId,
        roundId: "r-1",
        gameId: "g-1",
        kind: WagerTransactionKind.Bet,
        money: { amount: "30.00", currency: "BRL" },
      });

      expect(result.status).toBe(WagerTransactionStatus.Processed);
      expect(result.balance.amount).toBe("70.00");
      expect(result.idempotentReplay).toBe(false);

      const wallet = em.wallets.get(walletId);
      expect(wallet?.balance).toBe("70.00");
      expect(wallet?.version).toBe(2); // Incrementou version
    });

    it("deve realizar replay idempotente retornando o saldo observado original mesmo após outras apostas", async () => {
      // 1. Primeira aposta de 30.00 (saldo vai para 70.00)
      const res1 = await processWagerUseCase.execute({
        providerId: "prov-a",
        externalTransactionId: "tx-original",
        idempotencyKey: "key-original",
        playerId: "player-wager",
        walletId,
        roundId: "r-1",
        gameId: "g-1",
        kind: WagerTransactionKind.Bet,
        money: { amount: "30.00", currency: "BRL" },
      });
      expect(res1.balance.amount).toBe("70.00");
      expect(res1.idempotentReplay).toBe(false);

      // 2. Segunda aposta diferente de 20.00 (saldo vai para 50.00)
      await processWagerUseCase.execute({
        providerId: "prov-a",
        externalTransactionId: "tx-different",
        idempotencyKey: "key-different",
        playerId: "player-wager",
        walletId,
        roundId: "r-2",
        gameId: "g-1",
        kind: WagerTransactionKind.Bet,
        money: { amount: "20.00", currency: "BRL" },
      });

      const currentWallet = em.wallets.get(walletId);
      expect(currentWallet?.balance).toBe("50.00");

      // 3. Replay da primeira aposta -> DEVE RETORNAR 70.00 (saldo observado original) e não 50.00!
      const replay = await processWagerUseCase.execute({
        providerId: "prov-a",
        externalTransactionId: "tx-original",
        idempotencyKey: "key-original",
        playerId: "player-wager",
        walletId,
        roundId: "r-1",
        gameId: "g-1",
        kind: WagerTransactionKind.Bet,
        money: { amount: "30.00", currency: "BRL" },
      });

      expect(replay.idempotentReplay).toBe(true);
      expect(replay.status).toBe(WagerTransactionStatus.Processed);
      expect(replay.balance.amount).toBe("70.00"); // Regra 7, Seção 7 cumprida!
    });

    it("deve lançar IdempotencyConflictError se a mesma chave for enviada com payload diferente", async () => {
      await processWagerUseCase.execute({
        providerId: "prov-a",
        externalTransactionId: "tx-conf",
        idempotencyKey: "key-conflict",
        playerId: "player-wager",
        walletId,
        roundId: "r-1",
        gameId: "g-1",
        kind: WagerTransactionKind.Bet,
        money: { amount: "20.00", currency: "BRL" },
      });

      // Mesma idempotencyKey enviada com valor de 50.00 em vez de 20.00
      expect(
        processWagerUseCase.execute({
          providerId: "prov-a",
          externalTransactionId: "tx-conf",
          idempotencyKey: "key-conflict",
          playerId: "player-wager",
          walletId,
          roundId: "r-1",
          gameId: "g-1",
          kind: WagerTransactionKind.Bet,
          money: { amount: "50.00", currency: "BRL" },
        })
      ).rejects.toThrow(IdempotencyConflictError);
    });

    it("deve bloquear submissão de transação OPENING externa", async () => {
      expect(
        processWagerUseCase.execute({
          providerId: "prov-a",
          externalTransactionId: "tx-op",
          idempotencyKey: "key-op",
          playerId: "player-wager",
          walletId,
          roundId: "r-1",
          gameId: "g-1",
          kind: WagerTransactionKind.Opening,
          money: { amount: "100.00", currency: "BRL" },
        })
      ).rejects.toThrow("OPENING transaction kind is internal");
    });

    it("deve rejeitar BET por saldo insuficiente sem mover saldo nem incrementar version", async () => {
      const res = await processWagerUseCase.execute({
        providerId: "prov-a",
        externalTransactionId: "tx-over",
        idempotencyKey: "key-over",
        playerId: "player-wager",
        walletId,
        roundId: "r-1",
        gameId: "g-1",
        kind: WagerTransactionKind.Bet,
        money: { amount: "150.00", currency: "BRL" }, // Saldo é 100.00
      });

      expect(res.status).toBe(WagerTransactionStatus.Rejected);
      expect(res.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(res.balance.amount).toBe("100.00");

      const wallet = em.wallets.get(walletId);
      expect(wallet?.balance).toBe("100.00");
      expect(wallet?.version).toBe(1); // Version não incrementa em rejeição!
    });

    it("transação LOSS deve ser PROCESSED mas não mover saldo nem gerar ledger", async () => {
      const initialLedgerCount = em.ledgerEntries.size;

      const res = await processWagerUseCase.execute({
        providerId: "prov-a",
        externalTransactionId: "tx-loss",
        idempotencyKey: "key-loss",
        playerId: "player-wager",
        walletId,
        roundId: "r-1",
        gameId: "g-1",
        kind: WagerTransactionKind.Loss,
        money: { amount: "0.00", currency: "BRL" },
      });

      expect(res.status).toBe(WagerTransactionStatus.Processed);
      expect(res.balance.amount).toBe("100.00");

      const wallet = em.wallets.get(walletId);
      expect(wallet?.balance).toBe("100.00");
      expect(wallet?.version).toBe(1); // Version inalterada
      expect(em.ledgerEntries.size).toBe(initialLedgerCount); // Sem novos lançamentos no ledger
    });

    it("deve processar REFUND referenciando uma BET existente com sucesso", async () => {
      // 1. Criar BET de 40.00
      await processWagerUseCase.execute({
        providerId: "prov-a",
        externalTransactionId: "bet-to-refund",
        idempotencyKey: "key-bet-ref",
        playerId: "player-wager",
        walletId,
        roundId: "r-10",
        gameId: "g-1",
        kind: WagerTransactionKind.Bet,
        money: { amount: "40.00", currency: "BRL" },
      });

      expect(em.wallets.get(walletId)?.balance).toBe("60.00");

      // 2. Executar REFUND
      const refundRes = await processWagerUseCase.execute({
        providerId: "prov-a",
        externalTransactionId: "refund-tx-1",
        idempotencyKey: "key-refund-1",
        playerId: "player-wager",
        walletId,
        roundId: "r-10",
        gameId: "g-1",
        kind: WagerTransactionKind.Refund,
        money: { amount: "40.00", currency: "BRL" },
        referenceExternalTransactionId: "bet-to-refund",
      });

      expect(refundRes.status).toBe(WagerTransactionStatus.Processed);
      expect(refundRes.balance.amount).toBe("100.00");
      expect(em.wallets.get(walletId)?.balance).toBe("100.00");
    });

    it("deve rejeitar ROLLBACK com REVERSAL_INSUFFICIENT_FUNDS se a reversão de crédito produzir saldo negativo", async () => {
      // 1. Registrar WIN de 200.00 (saldo vai para 300.00)
      await processWagerUseCase.execute({
        providerId: "prov-a",
        externalTransactionId: "win-to-rollback",
        idempotencyKey: "key-win-rb",
        playerId: "player-wager",
        walletId,
        roundId: "r-win",
        gameId: "g-1",
        kind: WagerTransactionKind.Win,
        money: { amount: "200.00", currency: "BRL" },
      });
      expect(em.wallets.get(walletId)?.balance).toBe("300.00");

      // 2. Jogador gasta 250.00 em apostas (saldo cai para 50.00)
      await processWagerUseCase.execute({
        providerId: "prov-a",
        externalTransactionId: "bet-spend",
        idempotencyKey: "key-spend",
        playerId: "player-wager",
        walletId,
        roundId: "r-spend",
        gameId: "g-1",
        kind: WagerTransactionKind.Bet,
        money: { amount: "250.00", currency: "BRL" },
      });
      expect(em.wallets.get(walletId)?.balance).toBe("50.00");

      // 3. Provedor envia ROLLBACK do WIN de 200.00 (mas o jogador só tem 50.00 de saldo!)
      const rollbackRes = await processWagerUseCase.execute({
        providerId: "prov-a",
        externalTransactionId: "rb-win-fail",
        idempotencyKey: "key-rb-win-fail",
        playerId: "player-wager",
        walletId,
        roundId: "r-win",
        gameId: "g-1",
        kind: WagerTransactionKind.Rollback,
        money: { amount: "200.00", currency: "BRL" },
        referenceExternalTransactionId: "win-to-rollback",
      });

      expect(rollbackRes.status).toBe(WagerTransactionStatus.Rejected);
      expect(rollbackRes.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
      expect(rollbackRes.balance.amount).toBe("50.00"); // Saldo protegido
    });

    it("deve marcar PENDING_REFERENCE se a referência ainda não chegou", async () => {
      const res = await processWagerUseCase.execute({
        providerId: "prov-a",
        externalTransactionId: "refund-early",
        idempotencyKey: "key-refund-early",
        playerId: "player-wager",
        walletId,
        roundId: "r-early",
        gameId: "g-1",
        kind: WagerTransactionKind.Refund,
        money: { amount: "50.00", currency: "BRL" },
        referenceExternalTransactionId: "bet-that-has-not-arrived-yet",
      });

      expect(res.status).toBe(WagerTransactionStatus.PendingReference);
      expect(res.balance.amount).toBe("100.00"); // Saldo intacto
    });
  });

  describe("ReconcileWalletUseCase", () => {
    it("deve confirmar consistência contábil de 100% entre storedBalance e soma dos lançamentos do ledger", async () => {
      // 1. Abrir wallet com 100.00
      const w = await openWalletUseCase.execute({
        playerId: "p-rec",
        initialBalance: { amount: "100.00", currency: "BRL" },
      });

      // 2. Aposta de 40.00 (saldo 60.00)
      await processWagerUseCase.execute({
        providerId: "prov-a",
        externalTransactionId: "b-1",
        idempotencyKey: "k-b1",
        playerId: "p-rec",
        walletId: w.id,
        roundId: "r-1",
        gameId: "g-1",
        kind: WagerTransactionKind.Bet,
        money: { amount: "40.00", currency: "BRL" },
      });

      // 3. Vitória de 80.00 (saldo 140.00)
      await processWagerUseCase.execute({
        providerId: "prov-a",
        externalTransactionId: "w-1",
        idempotencyKey: "k-w1",
        playerId: "p-rec",
        walletId: w.id,
        roundId: "r-1",
        gameId: "g-1",
        kind: WagerTransactionKind.Win,
        money: { amount: "80.00", currency: "BRL" },
      });

      // 4. Reconciliar
      const rec = await reconcileWalletUseCase.execute(w.id);

      expect(rec.consistent).toBe(true);
      expect(rec.storedBalance.amount).toBe("140.00");
      expect(rec.calculatedBalance.amount).toBe("140.00");
      expect(rec.difference.amount).toBe("0.00");
      expect(rec.checkedEntries).toBe(3); // OPENING, BET, WIN
    });
  });
});
