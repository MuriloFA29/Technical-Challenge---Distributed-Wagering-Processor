import { beforeEach, describe, expect, it } from "bun:test";
import { InMemoryTestEntityManager } from "../helpers/mock-entity-manager";
import { OpenWalletUseCase } from "../../src/application/use-cases/open-wallet.use-case";
import { ProcessWagerTransactionUseCase } from "../../src/application/use-cases/process-wager-transaction.use-case";
import { ReconcileWalletUseCase } from "../../src/application/use-cases/reconcile-wallet.use-case";
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/entities/wager-transaction";
import { Money } from "../../src/domain/value-objects/money";
import { LedgerDirection } from "../../src/domain/entities/wallet-ledger-entry";

describe("Real Concurrency & Resilience Tests (Seção 13 do README)", () => {
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

  // Cenário Obrigatório 1 (Seção 8): Duas apostas de 80.00 BRL disputando saldo de 100.00 BRL em paralelo absoluto
  it("Cenário Seção 8: Saldo inicial 100.00 BRL, 2 apostas paralelas de 80.00 BRL -> exatamente 1 aceita e 1 rejeitada", async () => {
    const wallet = await openWalletUseCase.execute({
      playerId: "p-race-1",
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    // Disparar simultaneamente em paralelo absoluto
    const req1 = processWagerUseCase.execute({
      providerId: "prov-a",
      externalTransactionId: "race-tx-1",
      idempotencyKey: "prov-a:race-tx-1",
      playerId: "p-race-1",
      walletId: wallet.id,
      roundId: "round-race",
      gameId: "game-1",
      kind: WagerTransactionKind.Bet,
      money: { amount: "80.00", currency: "BRL" },
    });

    const req2 = processWagerUseCase.execute({
      providerId: "prov-a",
      externalTransactionId: "race-tx-2",
      idempotencyKey: "prov-a:race-tx-2",
      playerId: "p-race-1",
      walletId: wallet.id,
      roundId: "round-race",
      gameId: "game-1",
      kind: WagerTransactionKind.Bet,
      money: { amount: "80.00", currency: "BRL" },
    });

    const [res1, res2] = await Promise.all([req1, req2]);

    const statuses = [res1.status, res2.status];
    expect(statuses).toContain(WagerTransactionStatus.Processed);
    expect(statuses).toContain(WagerTransactionStatus.Rejected);

    // O rejeitado deve ter o failureCode correto
    const rejected = res1.status === WagerTransactionStatus.Rejected ? res1 : res2;
    expect(rejected.failureCode).toBe(FailureCode.InsufficientFunds);

    // Saldo final deve ser exatamente 20.00 BRL
    const currentWallet = em.wallets.get(wallet.id);
    expect(currentWallet?.balance).toBe("20.00");

    // Invariante: exatamente 1 lançamento de débito no ledger além da abertura
    const ledgerDebits = Array.from(em.ledgerEntries.values()).filter(
      (l) => l.walletId === wallet.id && l.direction === LedgerDirection.Debit
    );
    expect(ledgerDebits.length).toBe(1);
    expect(ledgerDebits[0].amount).toBe("80.00");

    // Reconciliação contábil 100% consistente
    const rec = await reconcileWalletUseCase.execute(wallet.id);
    expect(rec.consistent).toBe(true);
    expect(rec.storedBalance.amount).toBe("20.00");
    expect(rec.calculatedBalance.amount).toBe("20.00");
  });

  // Cenário Obrigatório 2: A mesma aposta enviada 50 vezes em paralelo -> 1 único débito
  it("Cenário 50 Requisições Simultâneas da mesma aposta -> exatamente 1 débito e 49 replays idempotentes", async () => {
    const wallet = await openWalletUseCase.execute({
      playerId: "p-storm-50",
      initialBalance: { amount: "1000.00", currency: "BRL" },
    });

    const singleIdempotencyKey = "key-mass-replay-50";
    const externalTxId = "tx-mass-50";

    const promises = Array.from({ length: 50 }).map(() =>
      processWagerUseCase.execute({
        providerId: "prov-mass",
        externalTransactionId: externalTxId,
        idempotencyKey: singleIdempotencyKey,
        playerId: "p-storm-50",
        walletId: wallet.id,
        roundId: "round-mass",
        gameId: "game-fast",
        kind: WagerTransactionKind.Bet,
        money: { amount: "10.00", currency: "BRL" },
      })
    );

    const results = await Promise.all(promises);

    // Todas as 50 respostas devem ter status PROCESSED
    expect(results.every((r) => r.status === WagerTransactionStatus.Processed)).toBe(true);

    // Exatamente 1 deve ser idempotentReplay: false e 49 devem ser idempotentReplay: true
    const originalCount = results.filter((r) => r.idempotentReplay === false).length;
    const replayCount = results.filter((r) => r.idempotentReplay === true).length;

    expect(originalCount).toBe(1);
    expect(replayCount).toBe(49);

    // Saldo final deve ter diminuído apenas 10.00 (de 1000.00 para 990.00)
    const currentWallet = em.wallets.get(wallet.id);
    expect(currentWallet?.balance).toBe("990.00");

    // Ledger deve conter apenas 1 débito
    const debits = Array.from(em.ledgerEntries.values()).filter(
      (l) => l.walletId === wallet.id && l.direction === LedgerDirection.Debit
    );
    expect(debits.length).toBe(1);
  });

  // Cenário Obrigatório 3: Wallets distintas processadas em paralelo simultaneamente
  it("Cenário Wallets Distintas: Múltiplas carteiras processando em paralelo sem contenção", async () => {
    const w1 = await openWalletUseCase.execute({ playerId: "p-dist-1", initialBalance: { amount: "100.00", currency: "BRL" } });
    const w2 = await openWalletUseCase.execute({ playerId: "p-dist-2", initialBalance: { amount: "200.00", currency: "BRL" } });
    const w3 = await openWalletUseCase.execute({ playerId: "p-dist-3", initialBalance: { amount: "300.00", currency: "BRL" } });

    await Promise.all([
      processWagerUseCase.execute({
        providerId: "prov-a", externalTransactionId: "tx-w1", idempotencyKey: "k-w1",
        playerId: "p-dist-1", walletId: w1.id, roundId: "r-1", gameId: "g-1",
        kind: WagerTransactionKind.Bet, money: { amount: "50.00", currency: "BRL" },
      }),
      processWagerUseCase.execute({
        providerId: "prov-a", externalTransactionId: "tx-w2", idempotencyKey: "k-w2",
        playerId: "p-dist-2", walletId: w2.id, roundId: "r-2", gameId: "g-1",
        kind: WagerTransactionKind.Bet, money: { amount: "100.00", currency: "BRL" },
      }),
      processWagerUseCase.execute({
        providerId: "prov-a", externalTransactionId: "tx-w3", idempotencyKey: "k-w3",
        playerId: "p-dist-3", walletId: w3.id, roundId: "r-3", gameId: "g-1",
        kind: WagerTransactionKind.Win, money: { amount: "150.00", currency: "BRL" },
      }),
    ]);

    expect(em.wallets.get(w1.id)?.balance).toBe("50.00");
    expect(em.wallets.get(w2.id)?.balance).toBe("100.00");
    expect(em.wallets.get(w3.id)?.balance).toBe("450.00");
  });

  // Cenário Obrigatório 4: Inbox Deduplication / Simulação de Worker Morto pós-commit e antes do ack SQS
  it("Cenário SQS Redelivery / Inbox: Re-entrega de mensagem do SQS reconhece Inbox e não duplica efeitos", async () => {
    const wallet = await openWalletUseCase.execute({
      playerId: "p-inbox",
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const sqsMessageId = "sqs-msg-unique-999";
    const idempotencyKey = "prov-sqs:tx-sqs-1";

    // 1. Mensagem recebida e processada pela primeira vez no SQS
    const firstDelivery = await processWagerUseCase.execute({
      providerId: "prov-sqs",
      externalTransactionId: "tx-sqs-1",
      idempotencyKey,
      playerId: "p-inbox",
      walletId: wallet.id,
      roundId: "r-sqs",
      gameId: "g-1",
      kind: WagerTransactionKind.Bet,
      money: { amount: "30.00", currency: "BRL" },
      inboxContext: {
        consumerName: "WagerSqsConsumer",
        messageId: sqsMessageId,
      },
    });

    expect(firstDelivery.status).toBe(WagerTransactionStatus.Processed);
    expect(firstDelivery.balance.amount).toBe("70.00");
    expect(firstDelivery.idempotentReplay).toBe(false);

    // 2. Simulação de Crash: o worker morreu antes de dar delete-message, SQS re-entrega a mesma mensagem!
    const redelivery = await processWagerUseCase.execute({
      providerId: "prov-sqs",
      externalTransactionId: "tx-sqs-1",
      idempotencyKey,
      playerId: "p-inbox",
      walletId: wallet.id,
      roundId: "r-sqs",
      gameId: "g-1",
      kind: WagerTransactionKind.Bet,
      money: { amount: "30.00", currency: "BRL" },
      inboxContext: {
        consumerName: "WagerSqsConsumer",
        messageId: sqsMessageId,
      },
    });

    expect(redelivery.idempotentReplay).toBe(true);
    expect(redelivery.status).toBe(WagerTransactionStatus.Processed);
    expect(redelivery.balance.amount).toBe("70.00");

    // Saldo permanece 70.00 BRL (zero débitos duplicados!)
    expect(em.wallets.get(wallet.id)?.balance).toBe("70.00");

    // Ledger contém apenas 1 débito
    const debits = Array.from(em.ledgerEntries.values()).filter(
      (l) => l.walletId === wallet.id && l.direction === LedgerDirection.Debit
    );
    expect(debits.length).toBe(1);
  });

  // Cenário Obrigatório 5: Invariante Final Global wallet.balance == soma do ledger
  it("Invariante Final: Reconstrução estrita do saldo através do somatório de lançamentos do ledger", async () => {
    const wallet = await openWalletUseCase.execute({
      playerId: "p-inv-final",
      initialBalance: { amount: "200.00", currency: "BRL" },
    });

    // Sequência de operações mistas
    await processWagerUseCase.execute({
      providerId: "prov-inv", externalTransactionId: "inv-b1", idempotencyKey: "k-inv-b1",
      playerId: "p-inv-final", walletId: wallet.id, roundId: "r-1", gameId: "g-1",
      kind: WagerTransactionKind.Bet, money: { amount: "50.00", currency: "BRL" },
    });

    await processWagerUseCase.execute({
      providerId: "prov-inv", externalTransactionId: "inv-w1", idempotencyKey: "k-inv-w1",
      playerId: "p-inv-final", walletId: wallet.id, roundId: "r-1", gameId: "g-1",
      kind: WagerTransactionKind.Win, money: { amount: "120.00", currency: "BRL" },
    });

    await processWagerUseCase.execute({
      providerId: "prov-inv", externalTransactionId: "inv-l1", idempotencyKey: "k-inv-l1",
      playerId: "p-inv-final", walletId: wallet.id, roundId: "r-1", gameId: "g-1",
      kind: WagerTransactionKind.Loss, money: { amount: "0.00", currency: "BRL" },
    });

    const rec = await reconcileWalletUseCase.execute(wallet.id);
    expect(rec.consistent).toBe(true);
    expect(rec.storedBalance.amount).toBe("270.00");
    expect(rec.calculatedBalance.amount).toBe("270.00");
    expect(rec.difference.amount).toBe("0.00");
  });
});
