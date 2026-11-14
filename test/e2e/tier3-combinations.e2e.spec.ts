import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createE2eApp, E2eTestHarness } from "./helpers/e2e-app";

describe("E2E Tier 3 — Cross-Feature Combinations", () => {
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

  it("BET -> WIN -> ROLLBACK of WIN and ROLLBACK of BET should reconcile cleanly", async () => {
    const wRes = await harness.request("POST", "/wallets", {
      body: {
        playerId: "p-combo-1",
        initialBalance: { amount: "200.00", currency: "USD" },
      },
    });
    const walletId = wRes.body.id;

    // BET 50 -> 150
    await harness.request("POST", "/wagering/transactions", {
      headers: { "Idempotency-Key": "c1-bet" },
      body: {
        providerId: "provider-a",
        externalTransactionId: "ext-c1-bet",
        playerId: "p-combo-1",
        walletId,
        roundId: "r-1",
        gameId: "g-1",
        kind: "BET",
        money: { amount: "50.00", currency: "USD" },
      },
    });

    // WIN 120 -> 270
    await harness.request("POST", "/wagering/transactions", {
      headers: { "Idempotency-Key": "c1-win" },
      body: {
        providerId: "provider-a",
        externalTransactionId: "ext-c1-win",
        playerId: "p-combo-1",
        walletId,
        roundId: "r-1",
        gameId: "g-1",
        kind: "WIN",
        money: { amount: "120.00", currency: "USD" },
      },
    });

    // ROLLBACK of WIN (120) -> 150
    const rbWin = await harness.request("POST", "/wagering/transactions", {
      headers: { "Idempotency-Key": "c1-rb-win" },
      body: {
        providerId: "provider-a",
        externalTransactionId: "ext-c1-rb-win",
        playerId: "p-combo-1",
        walletId,
        roundId: "r-1",
        gameId: "g-1",
        kind: "ROLLBACK",
        money: { amount: "120.00", currency: "USD" },
        referenceExternalTransactionId: "ext-c1-win",
      },
    });
    expect(rbWin.status).toBe(200);
    expect(rbWin.body.status).toBe("PROCESSED");
    expect(rbWin.body.balance).toEqual({ amount: "150.00", currency: "USD" });

    // ROLLBACK of BET (50) -> 200
    const rbBet = await harness.request("POST", "/wagering/transactions", {
      headers: { "Idempotency-Key": "c1-rb-bet" },
      body: {
        providerId: "provider-a",
        externalTransactionId: "ext-c1-rb-bet",
        playerId: "p-combo-1",
        walletId,
        roundId: "r-1",
        gameId: "g-1",
        kind: "ROLLBACK",
        money: { amount: "50.00", currency: "USD" },
        referenceExternalTransactionId: "ext-c1-bet",
      },
    });
    expect(rbBet.status).toBe(200);
    expect(rbBet.body.status).toBe("PROCESSED");
    expect(rbBet.body.balance).toEqual({ amount: "200.00", currency: "USD" });

    const walletRes = await harness.request("GET", `/wallets/${walletId}`);
    expect(walletRes.body.balance).toEqual({ amount: "200.00", currency: "USD" });

    const ledgerRes = await harness.request("GET", `/wallets/${walletId}/ledger`);
    expect(ledgerRes.body.items).toHaveLength(5);

    const recRes = await harness.request("POST", `/wallets/${walletId}/reconciliation`);
    expect(recRes.body.consistent).toBe(true);
    expect(recRes.body.difference).toEqual({ amount: "0.00", currency: "USD" });
    expect(recRes.body.checkedEntries).toBe(5);
  });

  it("BET -> REFUND -> duplicate REFUND should reject with DUPLICATE_REVERSAL and interact properly with ROLLBACK", async () => {
    const wRes = await harness.request("POST", "/wallets", {
      body: {
        playerId: "p-combo-2",
        initialBalance: { amount: "100.00", currency: "USD" },
      },
    });
    const walletId = wRes.body.id;

    // BET 40 -> 60
    await harness.request("POST", "/wagering/transactions", {
      headers: { "Idempotency-Key": "c2-bet" },
      body: {
        providerId: "provider-a",
        externalTransactionId: "ext-c2-bet",
        playerId: "p-combo-2",
        walletId,
        roundId: "r-2",
        gameId: "g-2",
        kind: "BET",
        money: { amount: "40.00", currency: "USD" },
      },
    });

    // REFUND 40 -> 100
    const ref1 = await harness.request("POST", "/wagering/transactions", {
      headers: { "Idempotency-Key": "c2-ref-1" },
      body: {
        providerId: "provider-a",
        externalTransactionId: "ext-c2-ref-1",
        playerId: "p-combo-2",
        walletId,
        roundId: "r-2",
        gameId: "g-2",
        kind: "REFUND",
        money: { amount: "40.00", currency: "USD" },
        referenceExternalTransactionId: "ext-c2-bet",
      },
    });
    expect(ref1.status).toBe(200);
    expect(ref1.body.status).toBe("PROCESSED");
    expect(ref1.body.balance).toEqual({ amount: "100.00", currency: "USD" });

    // Duplicate REFUND -> DUPLICATE_REVERSAL
    const ref2 = await harness.request("POST", "/wagering/transactions", {
      headers: { "Idempotency-Key": "c2-ref-2" },
      body: {
        providerId: "provider-a",
        externalTransactionId: "ext-c2-ref-2",
        playerId: "p-combo-2",
        walletId,
        roundId: "r-2",
        gameId: "g-2",
        kind: "REFUND",
        money: { amount: "40.00", currency: "USD" },
        referenceExternalTransactionId: "ext-c2-bet",
      },
    });
    expect(ref2.status).toBe(200);
    expect(ref2.body.status).toBe("REJECTED");
    expect(ref2.body.failureCode).toBe("DUPLICATE_REVERSAL");

    // ROLLBACK on same BET after REFUND -> REVERSAL_INSUFFICIENT_FUNDS or DUPLICATE_REVERSAL / state check
    const rbAfterRef = await harness.request("POST", "/wagering/transactions", {
      headers: { "Idempotency-Key": "c2-rb-after-ref" },
      body: {
        providerId: "provider-a",
        externalTransactionId: "ext-c2-rb-after-ref",
        playerId: "p-combo-2",
        walletId,
        roundId: "r-2",
        gameId: "g-2",
        kind: "ROLLBACK",
        money: { amount: "40.00", currency: "USD" },
        referenceExternalTransactionId: "ext-c2-bet",
      },
    });
    expect(rbAfterRef.status).toBe(200);
    // Verify wallet remains consistent regardless of whether ROLLBACK was allowed or rejected
    const recRes = await harness.request("POST", `/wallets/${walletId}/reconciliation`);
    expect(recRes.body.consistent).toBe(true);
  });

  it("Out-of-order REFUND and ROLLBACK before referenced BET should enter PENDING_REFERENCE and be queryable", async () => {
    const wRes = await harness.request("POST", "/wallets", {
      body: {
        playerId: "p-ooo",
        initialBalance: { amount: "100.00", currency: "USD" },
      },
    });
    const walletId = wRes.body.id;

    const pendingRefund = await harness.request("POST", "/wagering/transactions", {
      headers: { "Idempotency-Key": "k-ooo-refund" },
      body: {
        providerId: "provider-a",
        externalTransactionId: "ext-ooo-refund",
        playerId: "p-ooo",
        walletId,
        roundId: "r-ooo",
        gameId: "g-ooo",
        kind: "REFUND",
        money: { amount: "25.00", currency: "USD" },
        referenceExternalTransactionId: "ext-missing-bet",
      },
    });
    expect(pendingRefund.status).toBe(200);
    expect(pendingRefund.body.status).toBe("PENDING_REFERENCE");
    expect(pendingRefund.body.balance).toEqual({ amount: "100.00", currency: "USD" });

    const lookupRefund = await harness.request(
      "GET",
      `/wagering/transactions/${pendingRefund.body.transactionId}`
    );
    expect(lookupRefund.status).toBe(200);
    expect(lookupRefund.body.status).toBe("PENDING_REFERENCE");
    expect(lookupRefund.body.referenceExternalTransactionId).toBe("ext-missing-bet");

    const pendingRollback = await harness.request("POST", "/wagering/transactions", {
      headers: { "Idempotency-Key": "k-ooo-rollback" },
      body: {
        providerId: "provider-a",
        externalTransactionId: "ext-ooo-rollback",
        playerId: "p-ooo",
        walletId,
        roundId: "r-ooo",
        gameId: "g-ooo",
        kind: "ROLLBACK",
        money: { amount: "15.00", currency: "USD" },
        referenceExternalTransactionId: "ext-missing-win",
      },
    });
    expect(pendingRollback.status).toBe(200);
    expect(pendingRollback.body.status).toBe("PENDING_REFERENCE");
  });

  it("Concurrent HTTP BET requests on the same wallet should serialize safely and reconcile 100%", async () => {
    const wRes = await harness.request("POST", "/wallets", {
      body: {
        playerId: "p-concurrent",
        initialBalance: { amount: "100.00", currency: "USD" },
      },
    });
    const walletId = wRes.body.id;

    // 10 concurrent BETs of 25.00 each -> only 4 can succeed (100.00), 6 must fail with INSUFFICIENT_FUNDS
    const requests = Array.from({ length: 10 }, (_, idx) =>
      harness.request("POST", "/wagering/transactions", {
        headers: { "Idempotency-Key": `conc-bet-${idx}` },
        body: {
          providerId: "provider-a",
          externalTransactionId: `ext-conc-${idx}`,
          playerId: "p-concurrent",
          walletId,
          roundId: `r-conc-${idx}`,
          gameId: "g-conc",
          kind: "BET",
          money: { amount: "25.00", currency: "USD" },
        },
      })
    );

    const responses = await Promise.all(requests);
    const processed = responses.filter((r) => r.status === 200 && r.body.status === "PROCESSED");
    const rejected = responses.filter(
      (r) =>
        r.status === 200 &&
        r.body.status === "REJECTED" &&
        r.body.failureCode === "INSUFFICIENT_FUNDS"
    );

    expect(processed).toHaveLength(4);
    expect(rejected).toHaveLength(6);

    const walletRes = await harness.request("GET", `/wallets/${walletId}`);
    expect(walletRes.body.balance).toEqual({ amount: "0.00", currency: "USD" });

    const recRes = await harness.request("POST", `/wallets/${walletId}/reconciliation`);
    expect(recRes.status).toBe(200);
    expect(recRes.body.consistent).toBe(true);
    expect(recRes.body.difference).toEqual({ amount: "0.00", currency: "USD" });
    expect(recRes.body.storedBalance).toEqual({ amount: "0.00", currency: "USD" });
    expect(recRes.body.calculatedBalance).toEqual({ amount: "0.00", currency: "USD" });
  });

  it("Reconciliation after mixed OPENING, BET, WIN, LOSS, REFUND, ROLLBACK should ignore LOSS in ledger and reconcile", async () => {
    const wRes = await harness.request("POST", "/wallets", {
      body: {
        playerId: "p-mixed",
        initialBalance: { amount: "300.00", currency: "USD" },
      },
    });
    const walletId = wRes.body.id;

    // BET 50 -> 250
    await harness.request("POST", "/wagering/transactions", {
      headers: { "Idempotency-Key": "m-bet-1" },
      body: {
        providerId: "provider-a",
        externalTransactionId: "ext-m-bet-1",
        playerId: "p-mixed",
        walletId,
        roundId: "r-1",
        gameId: "g-1",
        kind: "BET",
        money: { amount: "50.00", currency: "USD" },
      },
    });

    // LOSS 50 -> 250 (no ledger entry)
    await harness.request("POST", "/wagering/transactions", {
      headers: { "Idempotency-Key": "m-loss-1" },
      body: {
        providerId: "provider-a",
        externalTransactionId: "ext-m-loss-1",
        playerId: "p-mixed",
        walletId,
        roundId: "r-1",
        gameId: "g-1",
        kind: "LOSS",
        money: { amount: "50.00", currency: "USD" },
      },
    });

    // BET 100 -> 150
    await harness.request("POST", "/wagering/transactions", {
      headers: { "Idempotency-Key": "m-bet-2" },
      body: {
        providerId: "provider-a",
        externalTransactionId: "ext-m-bet-2",
        playerId: "p-mixed",
        walletId,
        roundId: "r-2",
        gameId: "g-1",
        kind: "BET",
        money: { amount: "100.00", currency: "USD" },
      },
    });

    // WIN 200 -> 350
    await harness.request("POST", "/wagering/transactions", {
      headers: { "Idempotency-Key": "m-win-2" },
      body: {
        providerId: "provider-a",
        externalTransactionId: "ext-m-win-2",
        playerId: "p-mixed",
        walletId,
        roundId: "r-2",
        gameId: "g-1",
        kind: "WIN",
        money: { amount: "200.00", currency: "USD" },
      },
    });

    // REFUND of ext-m-bet-1 (50) -> 400
    await harness.request("POST", "/wagering/transactions", {
      headers: { "Idempotency-Key": "m-refund-1" },
      body: {
        providerId: "provider-a",
        externalTransactionId: "ext-m-refund-1",
        playerId: "p-mixed",
        walletId,
        roundId: "r-1",
        gameId: "g-1",
        kind: "REFUND",
        money: { amount: "50.00", currency: "USD" },
        referenceExternalTransactionId: "ext-m-bet-1",
      },
    });

    // ROLLBACK of ext-m-win-2 (200) -> 200
    await harness.request("POST", "/wagering/transactions", {
      headers: { "Idempotency-Key": "m-rb-2" },
      body: {
        providerId: "provider-a",
        externalTransactionId: "ext-m-rb-2",
        playerId: "p-mixed",
        walletId,
        roundId: "r-2",
        gameId: "g-1",
        kind: "ROLLBACK",
        money: { amount: "200.00", currency: "USD" },
        referenceExternalTransactionId: "ext-m-win-2",
      },
    });

    // 6 ledger entries: OPENING, BET1, BET2, WIN2, REFUND1, ROLLBACK2 (LOSS1 creates none)
    const recRes = await harness.request("POST", `/wallets/${walletId}/reconciliation`);
    expect(recRes.status).toBe(200);
    expect(recRes.body.consistent).toBe(true);
    expect(recRes.body.storedBalance).toEqual({ amount: "200.00", currency: "USD" });
    expect(recRes.body.calculatedBalance).toEqual({ amount: "200.00", currency: "USD" });
    expect(recRes.body.difference).toEqual({ amount: "0.00", currency: "USD" });
    expect(recRes.body.checkedEntries).toBe(6);
  });

  it("ROLLBACK of a WIN after spending funds should reject with REVERSAL_INSUFFICIENT_FUNDS and preserve balance", async () => {
    const wRes = await harness.request("POST", "/wallets", {
      body: {
        playerId: "p-rev-insuff",
        initialBalance: { amount: "10.00", currency: "USD" },
      },
    });
    const walletId = wRes.body.id;

    // WIN 50.00 -> 60.00
    const winRes = await harness.request("POST", "/wagering/transactions", {
      headers: { "Idempotency-Key": "ri-win-1" },
      body: {
        providerId: "provider-a",
        externalTransactionId: "ext-ri-win-1",
        playerId: "p-rev-insuff",
        walletId,
        roundId: "r-ri-1",
        gameId: "g-ri-1",
        kind: "WIN",
        money: { amount: "50.00", currency: "USD" },
      },
    });
    expect(winRes.status).toBe(200);
    expect(winRes.body.balance).toEqual({ amount: "60.00", currency: "USD" });

    // BET 55.00 -> 5.00
    const betRes = await harness.request("POST", "/wagering/transactions", {
      headers: { "Idempotency-Key": "ri-bet-1" },
      body: {
        providerId: "provider-a",
        externalTransactionId: "ext-ri-bet-1",
        playerId: "p-rev-insuff",
        walletId,
        roundId: "r-ri-2",
        gameId: "g-ri-1",
        kind: "BET",
        money: { amount: "55.00", currency: "USD" },
      },
    });
    expect(betRes.status).toBe(200);
    expect(betRes.body.balance).toEqual({ amount: "5.00", currency: "USD" });

    // ROLLBACK of WIN (50.00) -> REVERSAL_INSUFFICIENT_FUNDS, balance stays 5.00
    const rbRes = await harness.request("POST", "/wagering/transactions", {
      headers: { "Idempotency-Key": "ri-rb-1" },
      body: {
        providerId: "provider-a",
        externalTransactionId: "ext-ri-rb-1",
        playerId: "p-rev-insuff",
        walletId,
        roundId: "r-ri-1",
        gameId: "g-ri-1",
        kind: "ROLLBACK",
        money: { amount: "50.00", currency: "USD" },
        referenceExternalTransactionId: "ext-ri-win-1",
      },
    });
    expect(rbRes.status).toBe(200);
    expect(rbRes.body.status).toBe("REJECTED");
    expect(rbRes.body.failureCode).toBe("REVERSAL_INSUFFICIENT_FUNDS");
    expect(rbRes.body.balance).toEqual({ amount: "5.00", currency: "USD" });

    const walletGet = await harness.request("GET", `/wallets/${walletId}`);
    expect(walletGet.body.balance).toEqual({ amount: "5.00", currency: "USD" });
  });
});
