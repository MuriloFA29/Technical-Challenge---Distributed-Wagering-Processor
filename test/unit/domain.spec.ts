import { describe, expect, it } from "bun:test";
import {
  CurrencyMismatchError,
  DomainError,
  InsufficientFundsError,
  InvalidTransactionStateError,
  ReferenceRequirementError,
  UnbalancedLedgerEntryError,
} from "../../src/domain/errors/domain-errors";
import { Money } from "../../src/domain/value-objects/money";
import { Wallet } from "../../src/domain/entities/wallet";
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/entities/wager-transaction";
import {
  LedgerDirection,
  WalletLedgerEntry,
} from "../../src/domain/entities/wallet-ledger-entry";

describe("Domain Rules & Aggregate Invariants", () => {
  describe("Wallet Aggregate", () => {
    it("deve abrir wallet com saldo inicial e version 1", () => {
      const initialBalance = Money.from({ amount: "100.00", currency: "BRL" });
      const wallet = Wallet.open({
        id: "w-1",
        playerId: "p-1",
        initialBalance,
      });

      expect(wallet.id).toBe("w-1");
      expect(wallet.playerId).toBe("p-1");
      expect(wallet.balance.amount).toBe("100.00");
      expect(wallet.version).toBe(1);
    });

    it("deve debitar saldo e incrementar version", () => {
      const wallet = Wallet.open({
        id: "w-1",
        playerId: "p-1",
        initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
      });

      const { balanceBefore, balanceAfter, newVersion } = wallet.debit(
        Money.from({ amount: "40.00", currency: "BRL" })
      );

      expect(balanceBefore.amount).toBe("100.00");
      expect(balanceAfter.amount).toBe("60.00");
      expect(wallet.balance.amount).toBe("60.00");
      expect(newVersion).toBe(2);
      expect(wallet.version).toBe(2);
    });

    it("deve creditar saldo e incrementar version", () => {
      const wallet = Wallet.open({
        id: "w-1",
        playerId: "p-1",
        initialBalance: Money.from({ amount: "50.00", currency: "BRL" }),
      });

      const { balanceBefore, balanceAfter, newVersion } = wallet.credit(
        Money.from({ amount: "30.00", currency: "BRL" })
      );

      expect(balanceBefore.amount).toBe("50.00");
      expect(balanceAfter.amount).toBe("80.00");
      expect(wallet.balance.amount).toBe("80.00");
      expect(newVersion).toBe(2);
    });

    it("deve lançar InsufficientFundsError ao tentar debitar mais do que o saldo", () => {
      const wallet = Wallet.open({
        id: "w-1",
        playerId: "p-1",
        initialBalance: Money.from({ amount: "50.00", currency: "BRL" }),
      });

      expect(() =>
        wallet.debit(Money.from({ amount: "60.00", currency: "BRL" }))
      ).toThrow(InsufficientFundsError);

      // Saldo e version intactos
      expect(wallet.balance.amount).toBe("50.00");
      expect(wallet.version).toBe(1);
    });
  });

  describe("WalletLedgerEntry", () => {
    it("deve criar lançamento balanceado para débito", () => {
      const entry = WalletLedgerEntry.create({
        id: "l-1",
        walletId: "w-1",
        transactionId: "tx-1",
        direction: LedgerDirection.Debit,
        money: Money.from({ amount: "25.00", currency: "BRL" }),
        balanceBefore: Money.from({ amount: "100.00", currency: "BRL" }),
        balanceAfter: Money.from({ amount: "75.00", currency: "BRL" }),
      });

      expect(entry.isBalanced()).toBe(true);
    });

    it("deve criar lançamento balanceado para crédito", () => {
      const entry = WalletLedgerEntry.create({
        id: "l-2",
        walletId: "w-1",
        transactionId: "tx-2",
        direction: LedgerDirection.Credit,
        money: Money.from({ amount: "50.00", currency: "BRL" }),
        balanceBefore: Money.from({ amount: "75.00", currency: "BRL" }),
        balanceAfter: Money.from({ amount: "125.00", currency: "BRL" }),
      });

      expect(entry.isBalanced()).toBe(true);
    });

    it("deve rejeitar lançamento desbalanceado", () => {
      expect(() =>
        WalletLedgerEntry.create({
          id: "l-3",
          walletId: "w-1",
          transactionId: "tx-3",
          direction: LedgerDirection.Debit,
          money: Money.from({ amount: "20.00", currency: "BRL" }),
          balanceBefore: Money.from({ amount: "100.00", currency: "BRL" }),
          balanceAfter: Money.from({ amount: "90.00", currency: "BRL" }),
        })
      ).toThrow(UnbalancedLedgerEntryError);
    });
  });

  describe("WagerTransaction", () => {
    it("deve exigir referenceExternalTransactionId para REFUND e ROLLBACK", () => {
      expect(() =>
        WagerTransaction.create({
          id: "tx-ref-1",
          providerId: "prov-a",
          externalTransactionId: "ext-1",
          idempotencyKey: "k-1",
          payloadHash: "hash-1",
          walletId: "w-1",
          playerId: "p-1",
          roundId: "r-1",
          gameId: "g-1",
          kind: WagerTransactionKind.Refund,
          money: Money.from({ amount: "25.00", currency: "BRL" }),
        })
      ).toThrow(ReferenceRequirementError);
    });

    it("deve criar BET válida em status PENDING", () => {
      const tx = WagerTransaction.create({
        id: "tx-bet-1",
        providerId: "prov-a",
        externalTransactionId: "ext-1",
        idempotencyKey: "k-1",
        payloadHash: "hash-1",
        walletId: "w-1",
        playerId: "p-1",
        roundId: "r-1",
        gameId: "g-1",
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: "25.00", currency: "BRL" }),
      });

      expect(tx.status).toBe(WagerTransactionStatus.Pending);
      expect(tx.isTerminal()).toBe(false);
      expect(tx.affectsBalance()).toBe(true);
      expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    });

    it("LOSS não deve afetar saldo", () => {
      const tx = WagerTransaction.create({
        id: "tx-loss-1",
        providerId: "prov-a",
        externalTransactionId: "ext-2",
        idempotencyKey: "k-2",
        payloadHash: "hash-2",
        walletId: "w-1",
        playerId: "p-1",
        roundId: "r-1",
        gameId: "g-1",
        kind: WagerTransactionKind.Loss,
        money: Money.from({ amount: "0.00", currency: "BRL" }),
      });

      expect(tx.affectsBalance()).toBe(false);
    });

    it("deve bloquear transições a partir de estados terminais e armazenar observedBalance", () => {
      const tx = WagerTransaction.create({
        id: "tx-bet-2",
        providerId: "prov-a",
        externalTransactionId: "ext-3",
        idempotencyKey: "k-3",
        payloadHash: "hash-3",
        walletId: "w-1",
        playerId: "p-1",
        roundId: "r-1",
        gameId: "g-1",
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: "10.00", currency: "BRL" }),
      });

      const observed = Money.from({ amount: "90.00", currency: "BRL" });
      tx.markProcessed(undefined, observed);
      expect(tx.status).toBe(WagerTransactionStatus.Processed);
      expect(tx.isTerminal()).toBe(true);
      expect(tx.observedBalance?.amount).toBe("90.00");

      // Tentar transicionar novamente deve falhar
      expect(() => tx.reject(FailureCode.InsufficientFunds)).toThrow(
        InvalidTransactionStateError
      );
      expect(() => tx.markProcessed(undefined, observed)).toThrow(
        InvalidTransactionStateError
      );
    });
  });
});
