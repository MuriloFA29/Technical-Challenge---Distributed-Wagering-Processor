import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createE2eApp, E2eTestHarness } from "./helpers/e2e-app";

describe("E2E Tier 2 — Boundaries & Corner Cases", () => {
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

  describe("Wallet Creation & Money Boundaries", () => {
    it("should return 422 for negative initialBalance", async () => {
      const res = await harness.request("POST", "/wallets", {
        body: {
          playerId: "p-neg",
          initialBalance: { amount: "-10.00", currency: "USD" },
        },
      });
      expect(res.status).toBe(422);
      expect(res.body.errorCode).toBe("BUSINESS_RULE_VIOLATION");
    });

    it("should return 400 for >2 decimal places, invalid currency length, and malformed amount strings", async () => {
      const tooManyDecimals = await harness.request("POST", "/wallets", {
        body: {
          playerId: "p-dec",
          initialBalance: { amount: "10.123", currency: "USD" },
        },
      });
      expect(tooManyDecimals.status).toBe(400);

      const badCurrency = await harness.request("POST", "/wallets", {
        body: {
          playerId: "p-cur",
          initialBalance: { amount: "10.00", currency: "US" },
        },
      });
      expect(badCurrency.status).toBe(400);

      const alphaAmount = await harness.request("POST", "/wallets", {
        body: {
          playerId: "p-abc",
          initialBalance: { amount: "abc", currency: "USD" },
        },
      });
      expect(alphaAmount.status).toBe(400);

      const sciAmount = await harness.request("POST", "/wallets", {
        body: {
          playerId: "p-sci",
          initialBalance: { amount: "1e2", currency: "USD" },
        },
      });
      expect(sciAmount.status).toBe(400);
    });

    it("should return 409 when creating a duplicate wallet for same (playerId, currency)", async () => {
      const first = await harness.request("POST", "/wallets", {
        body: {
          playerId: "p-dup",
          initialBalance: { amount: "50.00", currency: "USD" },
        },
      });
      expect(first.status).toBe(201);

      const second = await harness.request("POST", "/wallets", {
        body: {
          playerId: "p-dup",
          initialBalance: { amount: "10.00", currency: "USD" },
        },
      });
      expect(second.status).toBe(409);
      expect(second.body.errorCode).toBe("WALLET_ALREADY_EXISTS");
    });

    it("should allow zero-amount BET on a zero-balance wallet", async () => {
      const wRes = await harness.request("POST", "/wallets", {
        body: {
          playerId: "p-zero-bet",
          initialBalance: { amount: "0.00", currency: "USD" },
        },
      });
      const walletId = wRes.body.id;

      const betRes = await harness.request("POST", "/wagering/transactions", {
        headers: { "Idempotency-Key": "k-zero-bet" },
        body: {
          providerId: "provider-a",
          externalTransactionId: "ext-zero-bet",
          playerId: "p-zero-bet",
          walletId,
          roundId: "r-z",
          gameId: "g-z",
          kind: "BET",
          money: { amount: "0.00", currency: "USD" },
        },
      });
      expect(betRes.status).toBe(200);
      expect(betRes.body.status).toBe("PROCESSED");
      expect(betRes.body.balance).toEqual({ amount: "0.00", currency: "USD" });
    });
  });

  describe("Resource Not Found (404) & Request Validation (400/409)", () => {
    it("should return 404 for non-existent walletId, transactionId, and externalTransactionId", async () => {
      const wGet = await harness.request("GET", "/wallets/non-existent-wallet");
      expect(wGet.status).toBe(404);

      const wLedger = await harness.request("GET", "/wallets/non-existent-wallet/ledger");
      expect(wLedger.status).toBe(404);

      const wRec = await harness.request("POST", "/wallets/non-existent-wallet/reconciliation");
      expect(wRec.status).toBe(404);

      const txPost = await harness.request("POST", "/wagering/transactions", {
        headers: { "Idempotency-Key": "k-missing-wallet" },
        body: {
          providerId: "provider-a",
          externalTransactionId: "ext-missing-wallet",
          playerId: "p-1",
          walletId: "non-existent-wallet",
          roundId: "r-1",
          gameId: "g-1",
          kind: "BET",
          money: { amount: "10.00", currency: "USD" },
        },
      });
      expect(txPost.status).toBe(404);

      const txGet = await harness.request("GET", "/wagering/transactions/non-existent-tx");
      expect(txGet.status).toBe(404);

      const extGet = await harness.request(
        "GET",
        "/providers/provider-a/wagering/transactions/non-existent-ext"
      );
      expect(extGet.status).toBe(404);
    });

    it("should return 400 when REFUND or ROLLBACK is missing referenceExternalTransactionId", async () => {
      const wRes = await harness.request("POST", "/wallets", {
        body: {
          playerId: "p-ref-req",
          initialBalance: { amount: "100.00", currency: "USD" },
        },
      });
      const walletId = wRes.body.id;

      const refundRes = await harness.request("POST", "/wagering/transactions", {
        headers: { "Idempotency-Key": "k-no-ref-1" },
        body: {
          providerId: "provider-a",
          externalTransactionId: "ext-no-ref-1",
          playerId: "p-ref-req",
          walletId,
          roundId: "r-1",
          gameId: "g-1",
          kind: "REFUND",
          money: { amount: "10.00", currency: "USD" },
        },
      });
      expect(refundRes.status).toBe(400);

      const rollbackRes = await harness.request("POST", "/wagering/transactions", {
        headers: { "Idempotency-Key": "k-no-ref-2" },
        body: {
          providerId: "provider-a",
          externalTransactionId: "ext-no-ref-2",
          playerId: "p-ref-req",
          walletId,
          roundId: "r-1",
          gameId: "g-1",
          kind: "ROLLBACK",
          money: { amount: "10.00", currency: "USD" },
        },
      });
      expect(rollbackRes.status).toBe(400);
    });

    it("should return 409 on Idempotency-Key conflict with different payload", async () => {
      const wRes = await harness.request("POST", "/wallets", {
        body: {
          playerId: "p-idem-conf",
          initialBalance: { amount: "100.00", currency: "USD" },
        },
      });
      const walletId = wRes.body.id;

      const first = await harness.request("POST", "/wagering/transactions", {
        headers: { "Idempotency-Key": "shared-idem-key" },
        body: {
          providerId: "provider-a",
          externalTransactionId: "ext-idem-1",
          playerId: "p-idem-conf",
          walletId,
          roundId: "r-1",
          gameId: "g-1",
          kind: "BET",
          money: { amount: "10.00", currency: "USD" },
        },
      });
      expect(first.status).toBe(200);

      const conflict = await harness.request("POST", "/wagering/transactions", {
        headers: { "Idempotency-Key": "shared-idem-key" },
        body: {
          providerId: "provider-a",
          externalTransactionId: "ext-idem-1",
          playerId: "p-idem-conf",
          walletId,
          roundId: "r-1",
          gameId: "g-1",
          kind: "BET",
          money: { amount: "20.00", currency: "USD" },
        },
      });
      expect(conflict.status).toBe(409);
      expect(conflict.body.errorCode).toBe("IDEMPOTENCY_CONFLICT");
    });
  });

  describe("Business Rejections (200 REJECTED with failureCode)", () => {
    it("should reject INSUFFICIENT_FUNDS, CURRENCY_MISMATCH, INVALID_PAYLOAD, REFERENCE_MISMATCH, and INVALID_REFERENCE_TYPE", async () => {
      const wRes = await harness.request("POST", "/wallets", {
        body: {
          playerId: "p-biz-rej",
          initialBalance: { amount: "50.00", currency: "USD" },
        },
      });
      const walletId = wRes.body.id;

      // INSUFFICIENT_FUNDS
      const insuff = await harness.request("POST", "/wagering/transactions", {
        headers: { "Idempotency-Key": "k-insuff" },
        body: {
          providerId: "provider-a",
          externalTransactionId: "ext-insuff",
          playerId: "p-biz-rej",
          walletId,
          roundId: "r-1",
          gameId: "g-1",
          kind: "BET",
          money: { amount: "60.00", currency: "USD" },
        },
      });
      expect(insuff.status).toBe(200);
      expect(insuff.body.status).toBe("REJECTED");
      expect(insuff.body.failureCode).toBe("INSUFFICIENT_FUNDS");

      // CURRENCY_MISMATCH
      const curr = await harness.request("POST", "/wagering/transactions", {
        headers: { "Idempotency-Key": "k-curr" },
        body: {
          providerId: "provider-a",
          externalTransactionId: "ext-curr",
          playerId: "p-biz-rej",
          walletId,
          roundId: "r-1",
          gameId: "g-1",
          kind: "BET",
          money: { amount: "10.00", currency: "EUR" },
        },
      });
      expect(curr.status).toBe(200);
      expect(curr.body.status).toBe("REJECTED");
      expect(curr.body.failureCode).toBe("CURRENCY_MISMATCH");

      // INVALID_PAYLOAD (wrong playerId)
      const wrongPlayer = await harness.request("POST", "/wagering/transactions", {
        headers: { "Idempotency-Key": "k-wrong-player" },
        body: {
          providerId: "provider-a",
          externalTransactionId: "ext-wrong-player",
          playerId: "other-player",
          walletId,
          roundId: "r-1",
          gameId: "g-1",
          kind: "BET",
          money: { amount: "10.00", currency: "USD" },
        },
      });
      expect(wrongPlayer.status).toBe(200);
      expect(wrongPlayer.body.status).toBe("REJECTED");
      expect(wrongPlayer.body.failureCode).toBe("INVALID_PAYLOAD");

      // Place valid BET (10.00) and WIN (20.00) for reference tests
      await harness.request("POST", "/wagering/transactions", {
        headers: { "Idempotency-Key": "k-valid-bet" },
        body: {
          providerId: "provider-a",
          externalTransactionId: "ext-valid-bet",
          playerId: "p-biz-rej",
          walletId,
          roundId: "r-1",
          gameId: "g-1",
          kind: "BET",
          money: { amount: "10.00", currency: "USD" },
        },
      });
      await harness.request("POST", "/wagering/transactions", {
        headers: { "Idempotency-Key": "k-valid-win" },
        body: {
          providerId: "provider-a",
          externalTransactionId: "ext-valid-win",
          playerId: "p-biz-rej",
          walletId,
          roundId: "r-1",
          gameId: "g-1",
          kind: "WIN",
          money: { amount: "20.00", currency: "USD" },
        },
      });

      // REFERENCE_MISMATCH (wrong amount on REFUND)
      const refMismatch = await harness.request("POST", "/wagering/transactions", {
        headers: { "Idempotency-Key": "k-ref-mismatch" },
        body: {
          providerId: "provider-a",
          externalTransactionId: "ext-ref-mismatch",
          playerId: "p-biz-rej",
          walletId,
          roundId: "r-1",
          gameId: "g-1",
          kind: "REFUND",
          money: { amount: "15.00", currency: "USD" },
          referenceExternalTransactionId: "ext-valid-bet",
        },
      });
      expect(refMismatch.status).toBe(200);
      expect(refMismatch.body.status).toBe("REJECTED");
      expect(refMismatch.body.failureCode).toBe("REFERENCE_MISMATCH");

      // INVALID_REFERENCE_TYPE (REFUND on a WIN)
      const invalidRefType = await harness.request("POST", "/wagering/transactions", {
        headers: { "Idempotency-Key": "k-invalid-ref-type" },
        body: {
          providerId: "provider-a",
          externalTransactionId: "ext-invalid-ref-type",
          playerId: "p-biz-rej",
          walletId,
          roundId: "r-1",
          gameId: "g-1",
          kind: "REFUND",
          money: { amount: "20.00", currency: "USD" },
          referenceExternalTransactionId: "ext-valid-win",
        },
      });
      expect(invalidRefType.status).toBe(200);
      expect(invalidRefType.body.status).toBe("REJECTED");
      expect(invalidRefType.body.failureCode).toBe("INVALID_REFERENCE_TYPE");
    });
  });

  describe("Ledger Pagination Bounds & Health 503", () => {
    it("should clamp limit bounds (0->1, 999->100), ignore malformed cursor, and paginate without duplicates/omissions", async () => {
      const wRes = await harness.request("POST", "/wallets", {
        body: {
          playerId: "p-pag",
          initialBalance: { amount: "100.00", currency: "USD" },
        },
      });
      const walletId = wRes.body.id;

      // Create 4 more ledger entries (total 5 including OPENING)
      for (let i = 1; i <= 4; i++) {
        await harness.request("POST", "/wagering/transactions", {
          headers: { "Idempotency-Key": `k-pag-${i}` },
          body: {
            providerId: "provider-a",
            externalTransactionId: `ext-pag-${i}`,
            playerId: "p-pag",
            walletId,
            roundId: `r-${i}`,
            gameId: "g-1",
            kind: "BET",
            money: { amount: "1.00", currency: "USD" },
          },
        });
      }

      // limit=0 clamps to 1
      const lim0 = await harness.request("GET", `/wallets/${walletId}/ledger?limit=0`);
      expect(lim0.status).toBe(200);
      expect(lim0.body.items).toHaveLength(1);
      expect(lim0.body.hasMore).toBe(true);

      // limit=999 clamps to 100 and returns all 5
      const lim999 = await harness.request("GET", `/wallets/${walletId}/ledger?limit=999`);
      expect(lim999.status).toBe(200);
      expect(lim999.body.items).toHaveLength(5);
      expect(lim999.body.hasMore).toBe(false);

      // Malformed cursor falls back gracefully to first page
      const badCursor = await harness.request(
        "GET",
        `/wallets/${walletId}/ledger?limit=2&cursor=not-valid-base64!!!`
      );
      expect(badCursor.status).toBe(200);
      expect(badCursor.body.items).toHaveLength(2);
      expect(badCursor.body.hasMore).toBe(true);

      // Full cursor traversal with limit=2 (2 + 2 + 1 = 5 unique items)
      const seenIds = new Set<string>();
      let cursor: string | undefined;
      let pages = 0;
      do {
        const query = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : "?limit=2";
        const page = await harness.request("GET", `/wallets/${walletId}/ledger${query}`);
        expect(page.status).toBe(200);
        for (const item of page.body.items) {
          expect(seenIds.has(item.id)).toBe(false);
          seenIds.add(item.id);
        }
        cursor = page.body.nextCursor;
        pages++;
      } while (cursor);

      expect(pages).toBe(3);
      expect(seenIds.size).toBe(5);
    });

    it("GET /health/ready should return 503 when DB or SQS is down", async () => {
      harness.em.dbHealthy = false;
      const dbDown = await harness.request("GET", "/health/ready");
      expect(dbDown.status).toBe(503);
      expect(dbDown.body.statusCode).toBe(503);

      harness.em.dbHealthy = true;
      harness.sqsClient.sqsHealthy = false;
      const sqsDown = await harness.request("GET", "/health/ready");
      expect(sqsDown.status).toBe(503);
      expect(sqsDown.body.statusCode).toBe(503);
    });
  });

  describe("External Kind & Idempotency-Key Header Fallbacks", () => {
    it("should reject external submission of kind OPENING and leave wallet ledger untouched", async () => {
      const wRes = await harness.request("POST", "/wallets", {
        body: {
          playerId: "p-opening-ext",
          initialBalance: { amount: "50.00", currency: "USD" },
        },
      });
      const walletId = wRes.body.id;

      const openingRes = await harness.request("POST", "/wagering/transactions", {
        headers: { "Idempotency-Key": "k-ext-opening" },
        body: {
          providerId: "provider-a",
          externalTransactionId: "ext-opening-1",
          playerId: "p-opening-ext",
          walletId,
          roundId: "r-open",
          gameId: "g-open",
          kind: "OPENING",
          money: { amount: "100.00", currency: "USD" },
        },
      });

      expect(openingRes.status).toBeGreaterThanOrEqual(400);
      expect(openingRes.body.errorCode).toBeTruthy();

      const walletGet = await harness.request("GET", `/wallets/${walletId}`);
      expect(walletGet.body.balance).toEqual({ amount: "50.00", currency: "USD" });

      const ledgerGet = await harness.request("GET", `/wallets/${walletId}/ledger`);
      expect(ledgerGet.body.items).toHaveLength(1);
    });

    it("should fall back to providerId:externalTransactionId when Idempotency-Key header is omitted and replay idempotently", async () => {
      const wRes = await harness.request("POST", "/wallets", {
        body: {
          playerId: "p-no-idem-hdr",
          initialBalance: { amount: "100.00", currency: "USD" },
        },
      });
      const walletId = wRes.body.id;

      const payload = {
        providerId: "provider-a",
        externalTransactionId: "ext-no-hdr-1",
        playerId: "p-no-idem-hdr",
        walletId,
        roundId: "r-no-hdr",
        gameId: "g-no-hdr",
        kind: "BET",
        money: { amount: "30.00", currency: "USD" },
      };

      const first = await harness.request("POST", "/wagering/transactions", {
        body: payload,
      });
      expect(first.status).toBe(200);
      expect(first.body.status).toBe("PROCESSED");
      expect(first.body.idempotentReplay).toBe(false);
      expect(first.body.balance).toEqual({ amount: "70.00", currency: "USD" });

      const retry = await harness.request("POST", "/wagering/transactions", {
        body: payload,
      });
      expect(retry.status).toBe(200);
      expect(retry.body.status).toBe("PROCESSED");
      expect(retry.body.idempotentReplay).toBe(true);
      expect(retry.body.transactionId).toBe(first.body.transactionId);
      expect(retry.body.balance).toEqual({ amount: "70.00", currency: "USD" });
    });
  });
});
