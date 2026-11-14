import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createE2eApp, E2eTestHarness } from "./helpers/e2e-app";

describe("E2E Tier 1 — Feature Coverage (Happy Paths)", () => {
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

  it("POST /wallets should open a wallet with zero initial balance (201)", async () => {
    const res = await harness.request("POST", "/wallets", {
      body: {
        playerId: "player-zero-1",
        initialBalance: { amount: "0.00", currency: "USD" },
      },
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeString();
    expect(res.body.playerId).toBe("player-zero-1");
    expect(res.body.balance).toEqual({ amount: "0.00", currency: "USD" });
    expect(res.body.version).toBe(1);

    const ledgerRes = await harness.request("GET", `/wallets/${res.body.id}/ledger`);
    expect(ledgerRes.status).toBe(200);
    expect(ledgerRes.body.items).toEqual([]);
    expect(ledgerRes.body.hasMore).toBe(false);
  });

  it("POST /wallets should open a wallet with positive initial balance and record OPENING ledger entry (201)", async () => {
    const res = await harness.request("POST", "/wallets", {
      body: {
        playerId: "player-pos-1",
        initialBalance: { amount: "250.50", currency: "USD" },
      },
    });

    expect(res.status).toBe(201);
    expect(res.body.balance).toEqual({ amount: "250.50", currency: "USD" });
    expect(res.body.version).toBe(1);

    const ledgerRes = await harness.request("GET", `/wallets/${res.body.id}/ledger`);
    expect(ledgerRes.status).toBe(200);
    expect(ledgerRes.body.items).toHaveLength(1);
    expect(ledgerRes.body.items[0].direction).toBe("CREDIT");
    expect(ledgerRes.body.items[0].money).toEqual({ amount: "250.50", currency: "USD" });
    expect(ledgerRes.body.items[0].balanceBefore).toEqual({ amount: "0.00", currency: "USD" });
    expect(ledgerRes.body.items[0].balanceAfter).toEqual({ amount: "250.50", currency: "USD" });
  });

  it("GET /wallets/:walletId should return wallet details (200)", async () => {
    const createRes = await harness.request("POST", "/wallets", {
      body: {
        playerId: "player-get-1",
        initialBalance: { amount: "100.00", currency: "EUR" },
      },
    });
    const walletId = createRes.body.id;

    const getRes = await harness.request("GET", `/wallets/${walletId}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.id).toBe(walletId);
    expect(getRes.body.playerId).toBe("player-get-1");
    expect(getRes.body.balance).toEqual({ amount: "100.00", currency: "EUR" });
    expect(getRes.body.version).toBe(1);
  });

  it("POST /wallets/:walletId/reconciliation should verify 100% balance consistency (200)", async () => {
    const createRes = await harness.request("POST", "/wallets", {
      body: {
        playerId: "player-rec-1",
        initialBalance: { amount: "500.00", currency: "USD" },
      },
    });
    const walletId = createRes.body.id;

    await harness.request("POST", "/wagering/transactions", {
      headers: { "Idempotency-Key": "rec-bet-1" },
      body: {
        providerId: "provider-a",
        externalTransactionId: "ext-rec-bet-1",
        playerId: "player-rec-1",
        walletId,
        roundId: "round-1",
        gameId: "slot-1",
        kind: "BET",
        money: { amount: "120.00", currency: "USD" },
      },
    });

    const recRes = await harness.request("POST", `/wallets/${walletId}/reconciliation`);
    expect(recRes.status).toBe(200);
    expect(recRes.body.walletId).toBe(walletId);
    expect(recRes.body.storedBalance).toEqual({ amount: "380.00", currency: "USD" });
    expect(recRes.body.calculatedBalance).toEqual({ amount: "380.00", currency: "USD" });
    expect(recRes.body.difference).toEqual({ amount: "0.00", currency: "USD" });
    expect(recRes.body.consistent).toBe(true);
    expect(recRes.body.checkedEntries).toBe(2);
  });

  it("POST /wagering/transactions should process BET, WIN, LOSS, REFUND, and ROLLBACK (200)", async () => {
    const createRes = await harness.request("POST", "/wallets", {
      body: {
        playerId: "player-tx-1",
        initialBalance: { amount: "100.00", currency: "USD" },
      },
    });
    const walletId = createRes.body.id;

    // 1. BET 30.00 -> 70.00
    const betRes = await harness.request("POST", "/wagering/transactions", {
      headers: { "Idempotency-Key": "k-bet-1" },
      body: {
        providerId: "provider-a",
        externalTransactionId: "ext-bet-1",
        playerId: "player-tx-1",
        walletId,
        roundId: "r-1",
        gameId: "g-1",
        kind: "BET",
        money: { amount: "30.00", currency: "USD" },
      },
    });
    expect(betRes.status).toBe(200);
    expect(betRes.body.status).toBe("PROCESSED");
    expect(betRes.body.balance).toEqual({ amount: "70.00", currency: "USD" });
    expect(betRes.body.idempotentReplay).toBe(false);

    // 2. WIN 50.00 -> 120.00
    const winRes = await harness.request("POST", "/wagering/transactions", {
      headers: { "Idempotency-Key": "k-win-1" },
      body: {
        providerId: "provider-a",
        externalTransactionId: "ext-win-1",
        playerId: "player-tx-1",
        walletId,
        roundId: "r-1",
        gameId: "g-1",
        kind: "WIN",
        money: { amount: "50.00", currency: "USD" },
      },
    });
    expect(winRes.status).toBe(200);
    expect(winRes.body.status).toBe("PROCESSED");
    expect(winRes.body.balance).toEqual({ amount: "120.00", currency: "USD" });

    // 3. LOSS 10.00 -> 120.00 (no balance change)
    const lossRes = await harness.request("POST", "/wagering/transactions", {
      headers: { "Idempotency-Key": "k-loss-1" },
      body: {
        providerId: "provider-a",
        externalTransactionId: "ext-loss-1",
        playerId: "player-tx-1",
        walletId,
        roundId: "r-2",
        gameId: "g-1",
        kind: "LOSS",
        money: { amount: "10.00", currency: "USD" },
      },
    });
    expect(lossRes.status).toBe(200);
    expect(lossRes.body.status).toBe("PROCESSED");
    expect(lossRes.body.balance).toEqual({ amount: "120.00", currency: "USD" });

    // 4. REFUND of ext-bet-1 (30.00) -> 150.00
    const refundRes = await harness.request("POST", "/wagering/transactions", {
      headers: { "Idempotency-Key": "k-refund-1" },
      body: {
        providerId: "provider-a",
        externalTransactionId: "ext-refund-1",
        playerId: "player-tx-1",
        walletId,
        roundId: "r-1",
        gameId: "g-1",
        kind: "REFUND",
        money: { amount: "30.00", currency: "USD" },
        referenceExternalTransactionId: "ext-bet-1",
      },
    });
    expect(refundRes.status).toBe(200);
    expect(refundRes.body.status).toBe("PROCESSED");
    expect(refundRes.body.balance).toEqual({ amount: "150.00", currency: "USD" });

    // 5. ROLLBACK of ext-win-1 (50.00) -> 100.00
    const rollbackRes = await harness.request("POST", "/wagering/transactions", {
      headers: { "Idempotency-Key": "k-rollback-1" },
      body: {
        providerId: "provider-a",
        externalTransactionId: "ext-rollback-1",
        playerId: "player-tx-1",
        walletId,
        roundId: "r-1",
        gameId: "g-1",
        kind: "ROLLBACK",
        money: { amount: "50.00", currency: "USD" },
        referenceExternalTransactionId: "ext-win-1",
      },
    });
    expect(rollbackRes.status).toBe(200);
    expect(rollbackRes.body.status).toBe("PROCESSED");
    expect(rollbackRes.body.balance).toEqual({ amount: "100.00", currency: "USD" });
  });

  it("GET /wagering/transactions/:transactionId and GET /providers/:providerId/wagering/transactions/:externalTransactionId should return transaction details (200)", async () => {
    const createRes = await harness.request("POST", "/wallets", {
      body: {
        playerId: "player-lookup-1",
        initialBalance: { amount: "100.00", currency: "USD" },
      },
    });
    const walletId = createRes.body.id;

    const betRes = await harness.request("POST", "/wagering/transactions", {
      headers: { "Idempotency-Key": "k-lookup-1" },
      body: {
        providerId: "provider-a",
        externalTransactionId: "ext-lookup-1",
        playerId: "player-lookup-1",
        walletId,
        roundId: "round-lookup",
        gameId: "game-lookup",
        kind: "BET",
        money: { amount: "25.00", currency: "USD" },
      },
    });
    const txId = betRes.body.transactionId;

    const byIdRes = await harness.request("GET", `/wagering/transactions/${txId}`);
    expect(byIdRes.status).toBe(200);
    expect(byIdRes.body.id).toBe(txId);
    expect(byIdRes.body.providerId).toBe("provider-a");
    expect(byIdRes.body.externalTransactionId).toBe("ext-lookup-1");
    expect(byIdRes.body.status).toBe("PROCESSED");
    expect(byIdRes.body.money).toEqual({ amount: "25.00", currency: "USD" });

    const byExtRes = await harness.request(
      "GET",
      "/providers/provider-a/wagering/transactions/ext-lookup-1"
    );
    expect(byExtRes.status).toBe(200);
    expect(byExtRes.body.id).toBe(txId);
    expect(byExtRes.body.externalTransactionId).toBe("ext-lookup-1");
  });

  it("GET /health/live, GET /health/ready, and GET /metrics should return operational status and Prometheus metrics (200)", async () => {
    const liveRes = await harness.request("GET", "/health/live");
    expect(liveRes.status).toBe(200);
    expect(liveRes.body.status).toBe("UP");
    expect(liveRes.body.timestamp).toBeString();

    const readyRes = await harness.request("GET", "/health/ready");
    expect(readyRes.status).toBe(200);
    expect(readyRes.body.status).toBe("UP");
    expect(readyRes.body.database).toBe("UP");
    expect(readyRes.body.sqs).toBe("UP");

    const metricsRes = await harness.request("GET", "/metrics");
    expect(metricsRes.status).toBe(200);
    expect(metricsRes.headers.get("content-type")).toContain("text/plain");
    expect(metricsRes.text).toContain("wagering_transactions_total");
    expect(metricsRes.text).toContain("wagering_outbox_lag_messages");
  });
});
