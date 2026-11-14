import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createE2eApp, E2eTestHarness } from "./helpers/e2e-app";

describe("E2E Tier 4 — Real-World Application Scenarios", () => {
  let harness: E2eTestHarness;

  beforeAll(async () => {
    harness = await createE2eApp();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    harness.reset();
  });

  it("Full player session lifecycle across multiple rounds/games with ledger pagination, reconciliation, and transaction lookups", async () => {
    const wRes = await harness.request("POST", "/wallets", {
      body: {
        playerId: "player-vip-42",
        initialBalance: { amount: "1000.00", currency: "USD" },
      },
    });
    expect(wRes.status).toBe(201);
    const walletId = wRes.body.id;

    const submittedTxIds: Array<{ id: string; extId: string }> = [];

    // Round 1 (Blackjack): BET 100, WIN 250 -> 1150
    const r1Bet = await harness.request("POST", "/wagering/transactions", {
      headers: { "Idempotency-Key": "vip-r1-bet" },
      body: {
        providerId: "provider-a",
        externalTransactionId: "vip-ext-r1-bet",
        playerId: "player-vip-42",
        walletId,
        roundId: "bj-101",
        gameId: "blackjack-pro",
        kind: "BET",
        money: { amount: "100.00", currency: "USD" },
      },
    });
    submittedTxIds.push({ id: r1Bet.body.transactionId, extId: "vip-ext-r1-bet" });

    const r1Win = await harness.request("POST", "/wagering/transactions", {
      headers: { "Idempotency-Key": "vip-r1-win" },
      body: {
        providerId: "provider-a",
        externalTransactionId: "vip-ext-r1-win",
        playerId: "player-vip-42",
        walletId,
        roundId: "bj-101",
        gameId: "blackjack-pro",
        kind: "WIN",
        money: { amount: "250.00", currency: "USD" },
      },
    });
    submittedTxIds.push({ id: r1Win.body.transactionId, extId: "vip-ext-r1-win" });

    // Round 2 (Roulette): BET 150, LOSS 150 -> 1000
    const r2Bet = await harness.request("POST", "/wagering/transactions", {
      headers: { "Idempotency-Key": "vip-r2-bet" },
      body: {
        providerId: "provider-a",
        externalTransactionId: "vip-ext-r2-bet",
        playerId: "player-vip-42",
        walletId,
        roundId: "roul-202",
        gameId: "european-roulette",
        kind: "BET",
        money: { amount: "150.00", currency: "USD" },
      },
    });
    submittedTxIds.push({ id: r2Bet.body.transactionId, extId: "vip-ext-r2-bet" });

    const r2Loss = await harness.request("POST", "/wagering/transactions", {
      headers: { "Idempotency-Key": "vip-r2-loss" },
      body: {
        providerId: "provider-a",
        externalTransactionId: "vip-ext-r2-loss",
        playerId: "player-vip-42",
        walletId,
        roundId: "roul-202",
        gameId: "european-roulette",
        kind: "LOSS",
        money: { amount: "150.00", currency: "USD" },
      },
    });
    submittedTxIds.push({ id: r2Loss.body.transactionId, extId: "vip-ext-r2-loss" });

    // Round 3 (Slots): BET 75, then game crash -> REFUND 75 -> 1000
    const r3Bet = await harness.request("POST", "/wagering/transactions", {
      headers: { "Idempotency-Key": "vip-r3-bet" },
      body: {
        providerId: "provider-a",
        externalTransactionId: "vip-ext-r3-bet",
        playerId: "player-vip-42",
        walletId,
        roundId: "slot-303",
        gameId: "mega-fortune",
        kind: "BET",
        money: { amount: "75.00", currency: "USD" },
      },
    });
    submittedTxIds.push({ id: r3Bet.body.transactionId, extId: "vip-ext-r3-bet" });

    const r3Refund = await harness.request("POST", "/wagering/transactions", {
      headers: { "Idempotency-Key": "vip-r3-refund" },
      body: {
        providerId: "provider-a",
        externalTransactionId: "vip-ext-r3-refund",
        playerId: "player-vip-42",
        walletId,
        roundId: "slot-303",
        gameId: "mega-fortune",
        kind: "REFUND",
        money: { amount: "75.00", currency: "USD" },
        referenceExternalTransactionId: "vip-ext-r3-bet",
      },
    });
    submittedTxIds.push({ id: r3Refund.body.transactionId, extId: "vip-ext-r3-refund" });

    // Paginate full ledger (6 entries: OPENING, r1Bet, r1Win, r2Bet, r3Bet, r3Refund) with page size 2
    const allLedgerIds: string[] = [];
    let cursor: string | undefined;
    do {
      const qs = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : "?limit=2";
      const page = await harness.request("GET", `/wallets/${walletId}/ledger${qs}`);
      expect(page.status).toBe(200);
      for (const item of page.body.items) {
        allLedgerIds.push(item.id);
      }
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(allLedgerIds).toHaveLength(6);

    // Reconcile wallet
    const recRes = await harness.request("POST", `/wallets/${walletId}/reconciliation`);
    expect(recRes.status).toBe(200);
    expect(recRes.body.consistent).toBe(true);
    expect(recRes.body.storedBalance).toEqual({ amount: "1000.00", currency: "USD" });
    expect(recRes.body.checkedEntries).toBe(6);

    // Verify every transaction via both lookup endpoints
    for (const tx of submittedTxIds) {
      const byId = await harness.request("GET", `/wagering/transactions/${tx.id}`);
      expect(byId.status).toBe(200);
      expect(byId.body.status).toBe("PROCESSED");

      const byExt = await harness.request(
        "GET",
        `/providers/provider-a/wagering/transactions/${tx.extId}`
      );
      expect(byExt.status).toBe(200);
      expect(byExt.body.id).toBe(tx.id);
    }
  });

  it("Multi-currency wallets for the same playerId (USD, EUR, BRL) with cross-currency rejection", async () => {
    const playerId = "player-multi-currency";

    const usdWallet = await harness.request("POST", "/wallets", {
      body: { playerId, initialBalance: { amount: "100.00", currency: "USD" } },
    });
    const eurWallet = await harness.request("POST", "/wallets", {
      body: { playerId, initialBalance: { amount: "200.00", currency: "EUR" } },
    });
    const brlWallet = await harness.request("POST", "/wallets", {
      body: { playerId, initialBalance: { amount: "500.00", currency: "BRL" } },
    });

    expect(usdWallet.status).toBe(201);
    expect(eurWallet.status).toBe(201);
    expect(brlWallet.status).toBe(201);

    // Valid bet on BRL wallet
    const brlBet = await harness.request("POST", "/wagering/transactions", {
      headers: { "Idempotency-Key": "mc-brl-bet" },
      body: {
        providerId: "provider-a",
        externalTransactionId: "ext-mc-brl",
        playerId,
        walletId: brlWallet.body.id,
        roundId: "r-mc-1",
        gameId: "g-mc",
        kind: "BET",
        money: { amount: "50.00", currency: "BRL" },
      },
    });
    expect(brlBet.status).toBe(200);
    expect(brlBet.body.status).toBe("PROCESSED");
    expect(brlBet.body.balance).toEqual({ amount: "450.00", currency: "BRL" });

    // Cross-currency bet (USD money against EUR wallet) -> CURRENCY_MISMATCH
    const mismatchBet = await harness.request("POST", "/wagering/transactions", {
      headers: { "Idempotency-Key": "mc-mismatch" },
      body: {
        providerId: "provider-a",
        externalTransactionId: "ext-mc-mismatch",
        playerId,
        walletId: eurWallet.body.id,
        roundId: "r-mc-2",
        gameId: "g-mc",
        kind: "BET",
        money: { amount: "25.00", currency: "USD" },
      },
    });
    expect(mismatchBet.status).toBe(200);
    expect(mismatchBet.body.status).toBe("REJECTED");
    expect(mismatchBet.body.failureCode).toBe("CURRENCY_MISMATCH");

    // EUR and USD wallets remain untouched
    const eurGet = await harness.request("GET", `/wallets/${eurWallet.body.id}`);
    expect(eurGet.body.balance).toEqual({ amount: "200.00", currency: "EUR" });
    const usdGet = await harness.request("GET", `/wallets/${usdWallet.body.id}`);
    expect(usdGet.body.balance).toEqual({ amount: "100.00", currency: "USD" });
  });

  it("High-frequency idempotent retries (concurrent and sequential) debit wallet exactly once", async () => {
    const wRes = await harness.request("POST", "/wallets", {
      body: {
        playerId: "player-retry-storm",
        initialBalance: { amount: "100.00", currency: "USD" },
      },
    });
    const walletId = wRes.body.id;

    const payload = {
      providerId: "provider-a",
      externalTransactionId: "ext-retry-storm-1",
      playerId: "player-retry-storm",
      walletId,
      roundId: "r-retry",
      gameId: "g-retry",
      kind: "BET",
      money: { amount: "35.00", currency: "USD" },
    };

    // Send 8 concurrent identical requests with the same Idempotency-Key
    const concurrentResponses = await Promise.all(
      Array.from({ length: 8 }, () =>
        harness.request("POST", "/wagering/transactions", {
          headers: { "Idempotency-Key": "retry-storm-key-1" },
          body: payload,
        })
      )
    );

    const firstProcesses = concurrentResponses.filter((r) => r.body.idempotentReplay === false);
    const replays = concurrentResponses.filter((r) => r.body.idempotentReplay === true);

    expect(firstProcesses).toHaveLength(1);
    expect(replays).toHaveLength(7);

    const canonicalTxId = firstProcesses[0].body.transactionId;
    for (const res of concurrentResponses) {
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("PROCESSED");
      expect(res.body.transactionId).toBe(canonicalTxId);
      expect(res.body.balance).toEqual({ amount: "65.00", currency: "USD" });
    }

    // Subsequent sequential retry after another transaction still returns original observed balance (65.00)
    await harness.request("POST", "/wagering/transactions", {
      headers: { "Idempotency-Key": "retry-storm-key-2" },
      body: {
        providerId: "provider-a",
        externalTransactionId: "ext-retry-storm-2",
        playerId: "player-retry-storm",
        walletId,
        roundId: "r-retry-2",
        gameId: "g-retry",
        kind: "BET",
        money: { amount: "15.00", currency: "USD" },
      },
    });

    const lateRetry = await harness.request("POST", "/wagering/transactions", {
      headers: { "Idempotency-Key": "retry-storm-key-1" },
      body: payload,
    });
    expect(lateRetry.status).toBe(200);
    expect(lateRetry.body.idempotentReplay).toBe(true);
    expect(lateRetry.body.transactionId).toBe(canonicalTxId);
    expect(lateRetry.body.balance).toEqual({ amount: "65.00", currency: "USD" });

    // Wallet balance is 50.00 (100 - 35 - 15) and reconciles
    const recRes = await harness.request("POST", `/wallets/${walletId}/reconciliation`);
    expect(recRes.body.consistent).toBe(true);
    expect(recRes.body.storedBalance).toEqual({ amount: "50.00", currency: "USD" });
  });
});
