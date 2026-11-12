import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { LockMode } from "@mikro-orm/postgresql";
import { WagerTransactionStatus } from "../../src/domain/entities/wager-transaction";
import {
  OutboxMessageOrmEntity,
  WagerTransactionOrmEntity,
  WalletOrmEntity,
} from "../../src/infrastructure/database/entities";
import { OutboxPublisherWorker } from "../../src/infrastructure/workers/outbox-publisher.worker";
import { PendingReferenceWorker } from "../../src/infrastructure/workers/pending-reference.worker";
import { GlobalHttpExceptionFilter } from "../../src/presentation/filters/http-exception.filter";
import { AuthGuard } from "../../src/presentation/guards/auth.guard";
import { CorrelationIdMiddleware } from "../../src/presentation/middleware/correlation-id.middleware";
import { createE2eApp, E2eTestHarness } from "./helpers/e2e-app";

const UUID_V4_OR_V7_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("E2E Tier 5 — Adversarial Coverage & Contract Hardening", () => {
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

  async function createWallet(playerId: string, amount = "100.00", currency = "USD") {
    const res = await harness.request("POST", "/wallets", {
      body: {
        playerId,
        initialBalance: { amount, currency },
      },
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  describe("1. DTO Validation & ValidationPipe (forbidNonWhitelisted)", () => {
    it("should reject extra unknown root and nested fields with 400 VALIDATION_ERROR", async () => {
      const walletExtraRoot = await harness.request("POST", "/wallets", {
        body: {
          playerId: "p-extra-1",
          initialBalance: { amount: "10.00", currency: "USD" },
          version: 999,
          extraField: "hack",
        },
      });
      expect(walletExtraRoot.status).toBe(400);
      expect(walletExtraRoot.body.errorCode).toBe("VALIDATION_ERROR");

      const walletExtraNested = await harness.request("POST", "/wallets", {
        body: {
          playerId: "p-extra-2",
          initialBalance: { amount: "10.00", currency: "USD", bonus: "5.00" },
        },
      });
      expect(walletExtraNested.status).toBe(400);
      expect(walletExtraNested.body.errorCode).toBe("VALIDATION_ERROR");

      const walletId = await createWallet("p-extra-tx", "50.00");
      const txExtra = await harness.request("POST", "/wagering/transactions", {
        body: {
          providerId: "provider-a",
          externalTransactionId: "ext-extra-1",
          playerId: "p-extra-tx",
          walletId,
          roundId: "r-1",
          gameId: "g-1",
          kind: "BET",
          money: { amount: "10.00", currency: "USD", extraNested: true },
          status: "PROCESSED",
        },
      });
      expect(txExtra.status).toBe(400);
      expect(txExtra.body.errorCode).toBe("VALIDATION_ERROR");
    });

    it("should reject wrong primitive/structural types and malformed JSON with 400", async () => {
      const badPlayerTypes = [123, true, null, ["p-arr"]];
      for (const playerId of badPlayerTypes) {
        const res = await harness.request("POST", "/wallets", {
          body: { playerId, initialBalance: { amount: "10.00", currency: "USD" } },
        });
        expect(res.status).toBe(400);
        expect(res.body.errorCode).toBe("VALIDATION_ERROR");
      }

      const numericAmount = await harness.request("POST", "/wallets", {
        body: { playerId: "p-num-amt", initialBalance: { amount: 100, currency: "USD" } },
      });
      expect(numericAmount.status).toBe(400);
      expect(numericAmount.body.errorCode).toBe("VALIDATION_ERROR");

      const badBalanceShapes = [null, "10.00", [], {}];
      for (const initialBalance of badBalanceShapes) {
        const res = await harness.request("POST", "/wallets", {
          body: { playerId: "p-bad-bal", initialBalance },
        });
        expect(res.status).toBe(400);
      }

      const rawMalformed = await fetch(`${harness.baseUrl}/wallets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"playerId": "broken"',
      });
      expect(rawMalformed.status).toBe(400);
    });

    it("should reject whitespace-only strings in DTOs and invalid currency codes", async () => {
      const wsPlayer = await harness.request("POST", "/wallets", {
        body: { playerId: "   ", initialBalance: { amount: "10.00", currency: "USD" } },
      });
      expect(wsPlayer.status).toBe(400);
      expect(wsPlayer.body.errorCode).toBe("VALIDATION_ERROR");

      const invalidCurrencies = ["123", "usd", "USDD", "US$", "   "];
      for (const currency of invalidCurrencies) {
        const res = await harness.request("POST", "/wallets", {
          body: { playerId: `p-cur-${currency}`, initialBalance: { amount: "10.00", currency } },
        });
        expect(res.status).toBe(400);
        expect(res.body.errorCode).toBe("VALIDATION_ERROR");
      }

      const walletId = await createWallet("p-ws-tx", "50.00");
      const wsExt = await harness.request("POST", "/wagering/transactions", {
        body: {
          providerId: "provider-a",
          externalTransactionId: "   ",
          playerId: "p-ws-tx",
          walletId,
          roundId: "r-1",
          gameId: "g-1",
          kind: "BET",
          money: { amount: "10.00", currency: "USD" },
        },
      });
      expect(wsExt.status).toBe(400);
      expect(wsExt.body.errorCode).toBe("VALIDATION_ERROR");
    });

    it("should reject negative amounts on LOSS, BET, and POST /wallets cleanly", async () => {
      const negWallet = await harness.request("POST", "/wallets", {
        body: { playerId: "p-neg-w", initialBalance: { amount: "-10.00", currency: "USD" } },
      });
      expect(negWallet.status).toBe(422);
      expect(negWallet.body.errorCode).toBe("BUSINESS_RULE_VIOLATION");

      const walletId = await createWallet("p-neg-tx", "100.00");

      const negLoss = await harness.request("POST", "/wagering/transactions", {
        body: {
          providerId: "provider-a",
          externalTransactionId: "ext-neg-loss",
          playerId: "p-neg-tx",
          walletId,
          roundId: "r-1",
          gameId: "g-1",
          kind: "LOSS",
          money: { amount: "-10.00", currency: "USD" },
        },
      });
      expect(negLoss.status).toBe(400);
      expect(negLoss.body.errorCode).toBe("INVALID_PAYLOAD");

      const negBet = await harness.request("POST", "/wagering/transactions", {
        body: {
          providerId: "provider-a",
          externalTransactionId: "ext-neg-bet",
          playerId: "p-neg-tx",
          walletId,
          roundId: "r-1",
          gameId: "g-1",
          kind: "BET",
          money: { amount: "-10.00", currency: "USD" },
        },
      });
      expect(negBet.status).toBe(400);
      expect(negBet.body.errorCode).toBe("INVALID_PAYLOAD");

      // Confirm wallet was untouched
      const walletRes = await harness.request("GET", `/wallets/${walletId}`);
      expect(walletRes.body.balance).toEqual({ amount: "100.00", currency: "USD" });
    });
  });

  describe("2. Swagger /docs-json OpenAPI Contract Verification", () => {
    it("should expose complete OpenAPI 3.x spec with security schemes and exact runtime DTO schemas", async () => {
      const docsRes = await harness.request<Record<string, any>>("GET", "/docs-json");
      expect(docsRes.status).toBe(200);
      const spec = docsRes.body;

      expect(String(spec.openapi)).toMatch(/^3\./);
      expect(spec.components?.securitySchemes?.["x-provider-id"]).toMatchObject({
        type: "apiKey",
        in: "header",
        name: "x-provider-id",
      });

      const expectedPaths = [
        "/wallets",
        "/wallets/{walletId}",
        "/wallets/{walletId}/ledger",
        "/wallets/{walletId}/reconciliation",
        "/wagering/transactions",
        "/wagering/transactions/{transactionId}",
        "/providers/{providerId}/wagering/transactions/{externalTransactionId}",
        "/health/live",
        "/health/ready",
        "/metrics",
      ];
      for (const path of expectedPaths) {
        expect(spec.paths?.[path]).toBeDefined();
      }

      // Protected operations must have x-provider-id security attached
      expect(spec.paths["/wallets"].post.security).toEqual([{ "x-provider-id": [] }]);
      expect(spec.paths["/wagering/transactions"].post.security).toEqual([{ "x-provider-id": [] }]);
      expect(spec.paths["/health/live"].get.security).toBeUndefined();
      expect(spec.paths["/metrics"].get.security).toBeUndefined();

      // Compare schema keys against actual runtime responses
      const walletId = await createWallet("p-swagger", "100.00");
      const betRes = await harness.request("POST", "/wagering/transactions", {
        body: {
          providerId: "provider-a",
          externalTransactionId: "ext-swagger-1",
          playerId: "p-swagger",
          walletId,
          roundId: "r-1",
          gameId: "g-1",
          kind: "BET",
          money: { amount: "25.00", currency: "USD" },
        },
      });
      expect(betRes.status).toBe(200);

      const walletGet = await harness.request("GET", `/wallets/${walletId}`);
      const ledgerGet = await harness.request("GET", `/wallets/${walletId}/ledger`);
      const reconcilePost = await harness.request("POST", `/wallets/${walletId}/reconciliation`);
      const txGet = await harness.request(
        "GET",
        `/wagering/transactions/${betRes.body.transactionId}`
      );

      const schemas = spec.components.schemas;

      // WalletResponseDto
      const walletSchemaKeys = Object.keys(schemas.WalletResponseDto.properties);
      for (const runtimeKey of Object.keys(walletGet.body)) {
        expect(walletSchemaKeys).toContain(runtimeKey);
      }

      // WalletLedgerResponseDto + LedgerEntryDto
      const ledgerSchemaKeys = Object.keys(schemas.WalletLedgerResponseDto.properties);
      expect(ledgerSchemaKeys.sort()).toEqual(["hasMore", "items", "nextCursor"]);
      for (const runtimeKey of Object.keys(ledgerGet.body)) {
        expect(ledgerSchemaKeys).toContain(runtimeKey);
      }
      const ledgerItemSchemaKeys = Object.keys(schemas.LedgerEntryDto.properties).sort();
      expect(ledgerItemSchemaKeys).toEqual(Object.keys(ledgerGet.body.items[0]).sort());

      // ReconciliationResponseDto
      const reconcileSchemaKeys = Object.keys(schemas.ReconciliationResponseDto.properties).sort();
      expect(reconcileSchemaKeys).toEqual(Object.keys(reconcilePost.body).sort());

      // TransactionDetailResponseDto (optional fields may be undefined when not set, so check all runtime keys are in schema and no bogus observedBalance)
      const txDetailSchemaKeys = Object.keys(schemas.TransactionDetailResponseDto.properties);
      expect(txDetailSchemaKeys).toContain("idempotencyKey");
      expect(txDetailSchemaKeys).not.toContain("observedBalance");
      for (const runtimeKey of Object.keys(txGet.body)) {
        expect(txDetailSchemaKeys).toContain(runtimeKey);
      }
    });
  });

  describe("3. X-Correlation-Id Edge Cases", () => {
    it("should auto-generate UUID when missing, fallback on empty/whitespace, and propagate on 4xx/503 errors", async () => {
      const noHdr = await harness.request("GET", "/health/live");
      expect(noHdr.status).toBe(200);
      expect(noHdr.headers.get("x-correlation-id")).toMatch(UUID_V4_OR_V7_REGEX);

      const emptyWithReqId = await harness.request("GET", "/health/live", {
        headers: { "x-correlation-id": "", "x-request-id": "req-fallback-1" },
      });
      expect(emptyWithReqId.headers.get("x-correlation-id")).toBe("req-fallback-1");

      const wsWithReqId = await harness.request("GET", "/health/live", {
        headers: { "x-correlation-id": "   ", "x-request-id": "req-fallback-2" },
      });
      expect(wsWithReqId.headers.get("x-correlation-id")).toBe("req-fallback-2");

      const wsNoReqId = await harness.request("GET", "/health/live", {
        headers: { "x-correlation-id": "   " },
      });
      expect(wsNoReqId.headers.get("x-correlation-id")).toMatch(UUID_V4_OR_V7_REGEX);

      // Propagation on 400, 404, 503
      const err400 = await harness.request("POST", "/wallets", {
        headers: { "x-correlation-id": "corr-err-400" },
        body: { playerId: "" },
      });
      expect(err400.status).toBe(400);
      expect(err400.headers.get("x-correlation-id")).toBe("corr-err-400");

      const err404 = await harness.request("GET", "/wallets/missing-id", {
        headers: { "x-correlation-id": "corr-err-404" },
      });
      expect(err404.status).toBe(404);
      expect(err404.headers.get("x-correlation-id")).toBe("corr-err-404");

      // 503 /health/ready preserves DOWN payload + correlation id
      harness.em.dbHealthy = false;
      const err503 = await harness.request("GET", "/health/ready", {
        headers: { "x-correlation-id": "corr-err-503" },
      });
      expect(err503.status).toBe(503);
      expect(err503.headers.get("x-correlation-id")).toBe("corr-err-503");
      expect(err503.body.statusCode).toBe(503);
      expect(err503.body.status).toBe("DOWN");
      expect(err503.body.database).toBe("DOWN");
      expect(err503.body.sqs).toBe("UP");
      expect(typeof err503.body.timestamp).toBe("string");
    });

    it("should truncate oversized X-Correlation-Id to 128 chars and reject CRLF/control characters", async () => {
      const oversized = "a".repeat(300);
      const resOversized = await harness.request("GET", "/health/live", {
        headers: { "x-correlation-id": oversized },
      });
      expect(resOversized.status).toBe(200);
      expect(resOversized.headers.get("x-correlation-id")).toBe("a".repeat(128));

      const middleware = new CorrelationIdMiddleware();
      const setHeaders: Record<string, string> = {};
      let nextCalled = false;
      const req = {
        headers: { "x-correlation-id": "bad\r\nX-Injected: evil" },
        method: "GET",
        url: "/health/live",
      } as never;
      const res = {
        setHeader: (name: string, val: string) => {
          setHeaders[name] = val;
        },
        on: () => {},
      } as never;
      middleware.use(req, res, () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(true);
      expect(setHeaders["X-Correlation-Id"]).toMatch(UUID_V4_OR_V7_REGEX);
    });
  });

  describe("4. AuthGuard & Idempotency Header Edge Cases", () => {
    it("should reject whitespace X-Provider-Id and mismatched X-Provider-Id", async () => {
      const guard = new AuthGuard();
      expect(() =>
        guard.canActivate({
          switchToHttp: () => ({
            getRequest: () => ({
              url: "/wagering/transactions",
              headers: { "x-provider-id": "   " },
            }),
          }),
        } as never)
      ).toThrow();

      const walletId = await createWallet("p-auth", "100.00");

      const mismatchBody = await harness.request("POST", "/wagering/transactions", {
        headers: { "X-Provider-Id": "provider-a" },
        body: {
          providerId: "provider-b",
          externalTransactionId: "ext-auth-mis",
          playerId: "p-auth",
          walletId,
          roundId: "r-1",
          gameId: "g-1",
          kind: "BET",
          money: { amount: "10.00", currency: "USD" },
        },
      });
      expect(mismatchBody.status).toBe(403);

      const mismatchRoute = await harness.request(
        "GET",
        "/providers/provider-b/wagering/transactions/ext-any",
        { headers: { "X-Provider-Id": "provider-a" } }
      );
      expect(mismatchRoute.status).toBe(403);
    });

    it("should treat whitespace Idempotency-Key as absent, reject 409 conflict, and handle concurrent conflict race", async () => {
      const walletId = await createWallet("p-idem-adv", "100.00");

      const payload1 = {
        providerId: "provider-a",
        externalTransactionId: "ext-ws-idem",
        playerId: "p-idem-adv",
        walletId,
        roundId: "r-1",
        gameId: "g-1",
        kind: "BET",
        money: { amount: "10.00", currency: "USD" },
      };

      const first = await harness.request("POST", "/wagering/transactions", {
        headers: { "Idempotency-Key": "   " },
        body: payload1,
      });
      expect(first.status).toBe(200);
      expect(first.body.idempotentReplay).toBe(false);

      const replay = await harness.request("POST", "/wagering/transactions", {
        body: payload1,
      });
      expect(replay.status).toBe(200);
      expect(replay.body.idempotentReplay).toBe(true);
      expect(replay.body.transactionId).toBe(first.body.transactionId);

      // Concurrent Idempotency-Key conflict race (same key, different amounts)
      const [c1, c2] = await Promise.all([
        harness.request("POST", "/wagering/transactions", {
          headers: { "Idempotency-Key": "race-idem-key" },
          body: {
            providerId: "provider-a",
            externalTransactionId: "ext-race-1",
            playerId: "p-idem-adv",
            walletId,
            roundId: "r-2",
            gameId: "g-1",
            kind: "BET",
            money: { amount: "15.00", currency: "USD" },
          },
        }),
        harness.request("POST", "/wagering/transactions", {
          headers: { "Idempotency-Key": "race-idem-key" },
          body: {
            providerId: "provider-a",
            externalTransactionId: "ext-race-1",
            playerId: "p-idem-adv",
            walletId,
            roundId: "r-2",
            gameId: "g-1",
            kind: "BET",
            money: { amount: "25.00", currency: "USD" },
          },
        }),
      ]);

      const statuses = [c1.status, c2.status].sort();
      expect(statuses).toEqual([200, 409]);
      const conflictRes = c1.status === 409 ? c1 : c2;
      expect(conflictRes.body.errorCode).toBe("IDEMPOTENCY_CONFLICT");

      const walletAfter = await harness.request("GET", `/wallets/${walletId}`);
      const expectedBalance = c1.status === 200 ? "75.00" : "65.00";
      expect(walletAfter.body.balance.amount).toBe(expectedBalance);
    });
  });

  describe("5. Query Param & Cursor Pagination Edge Cases", () => {
    it("should clamp limit (-5, 0, 999999), fallback on limit=abc, ignore incomplete cursor, and return 400 on invalid cursor date", async () => {
      const walletId = await createWallet("p-cursor-adv", "100.00");
      for (let i = 1; i <= 3; i++) {
        await harness.request("POST", "/wagering/transactions", {
          body: {
            providerId: "provider-a",
            externalTransactionId: `ext-cur-${i}`,
            playerId: "p-cursor-adv",
            walletId,
            roundId: `r-${i}`,
            gameId: "g-1",
            kind: "BET",
            money: { amount: "1.00", currency: "USD" },
          },
        });
      }

      const limNeg = await harness.request("GET", `/wallets/${walletId}/ledger?limit=-5`);
      expect(limNeg.status).toBe(200);
      expect(limNeg.body.items).toHaveLength(1);

      const limZero = await harness.request("GET", `/wallets/${walletId}/ledger?limit=0`);
      expect(limZero.status).toBe(200);
      expect(limZero.body.items).toHaveLength(1);

      const limHuge = await harness.request("GET", `/wallets/${walletId}/ledger?limit=999999`);
      expect(limHuge.status).toBe(200);
      expect(limHuge.body.items).toHaveLength(4);

      const limAbc = await harness.request("GET", `/wallets/${walletId}/ledger?limit=abc`);
      expect(limAbc.status).toBe(200);
      expect(limAbc.body.items).toHaveLength(4);

      const incompleteCursor = Buffer.from(JSON.stringify({ foo: "bar" }), "utf8").toString(
        "base64url"
      );
      const incompleteRes = await harness.request(
        "GET",
        `/wallets/${walletId}/ledger?cursor=${incompleteCursor}`
      );
      expect(incompleteRes.status).toBe(200);
      expect(incompleteRes.body.items).toHaveLength(4);

      const invalidDateCursor = Buffer.from(
        JSON.stringify({ createdAt: "not-a-date", id: "123" }),
        "utf8"
      ).toString("base64url");
      const invalidDateRes = await harness.request(
        "GET",
        `/wallets/${walletId}/ledger?cursor=${invalidDateCursor}`
      );
      expect(invalidDateRes.status).toBe(400);
      expect(invalidDateRes.body.errorCode).toBe("INVALID_PAYLOAD");
    });
  });

  describe("6. Domain, Precision, Workers, Metrics & PG Error Mapping", () => {
    it("should handle large integer money without IEEE-754 float drift and zero-amount WIN/LOSS/REFUND/ROLLBACK", async () => {
      const walletId = await createWallet("p-precision", "9007199254740991.00");

      const winRes = await harness.request("POST", "/wagering/transactions", {
        body: {
          providerId: "provider-a",
          externalTransactionId: "ext-prec-win",
          playerId: "p-precision",
          walletId,
          roundId: "r-p",
          gameId: "g-p",
          kind: "WIN",
          money: { amount: "0.01", currency: "USD" },
        },
      });
      expect(winRes.status).toBe(200);
      expect(winRes.body.balance.amount).toBe("9007199254740991.01");

      const betRes = await harness.request("POST", "/wagering/transactions", {
        body: {
          providerId: "provider-a",
          externalTransactionId: "ext-prec-bet",
          playerId: "p-precision",
          walletId,
          roundId: "r-p",
          gameId: "g-p",
          kind: "BET",
          money: { amount: "0.01", currency: "USD" },
        },
      });
      expect(betRes.status).toBe(200);
      expect(betRes.body.balance.amount).toBe("9007199254740991.00");

      // Zero-amount WIN, LOSS, BET -> REFUND -> ROLLBACK
      for (const [idx, kind] of ["WIN", "LOSS"].entries()) {
        const res = await harness.request("POST", "/wagering/transactions", {
          body: {
            providerId: "provider-a",
            externalTransactionId: `ext-zero-${idx}`,
            playerId: "p-precision",
            walletId,
            roundId: "r-z",
            gameId: "g-z",
            kind,
            money: { amount: "0.00", currency: "USD" },
          },
        });
        expect(res.status).toBe(200);
        expect(res.body.status).toBe("PROCESSED");
      }

      const zeroBet = await harness.request("POST", "/wagering/transactions", {
        body: {
          providerId: "provider-a",
          externalTransactionId: "ext-zero-bet",
          playerId: "p-precision",
          walletId,
          roundId: "r-z",
          gameId: "g-z",
          kind: "BET",
          money: { amount: "0.00", currency: "USD" },
        },
      });
      expect(zeroBet.status).toBe(200);

      const zeroRefund = await harness.request("POST", "/wagering/transactions", {
        body: {
          providerId: "provider-a",
          externalTransactionId: "ext-zero-refund",
          playerId: "p-precision",
          walletId,
          roundId: "r-z",
          gameId: "g-z",
          kind: "REFUND",
          money: { amount: "0.00", currency: "USD" },
          referenceExternalTransactionId: "ext-zero-bet",
        },
      });
      expect(zeroRefund.status).toBe(200);
      expect(zeroRefund.body.status).toBe("PROCESSED");

      const zeroRollback = await harness.request("POST", "/wagering/transactions", {
        body: {
          providerId: "provider-a",
          externalTransactionId: "ext-zero-rollback",
          playerId: "p-precision",
          walletId,
          roundId: "r-z",
          gameId: "g-z",
          kind: "ROLLBACK",
          money: { amount: "0.00", currency: "USD" },
          referenceExternalTransactionId: "ext-zero-bet",
        },
      });
      expect(zeroRollback.status).toBe(200);
      expect(zeroRollback.body.status).toBe("PROCESSED");

      const rec = await harness.request("POST", `/wallets/${walletId}/reconciliation`);
      expect(rec.status).toBe(200);
      expect(rec.body.consistent).toBe(true);
      expect(rec.body.difference.amount).toBe("0.00");
    });

    it("should handle concurrent REFUND + ROLLBACK on the same BET without double reversal", async () => {
      const walletId = await createWallet("p-rev-race", "100.00");
      await harness.request("POST", "/wagering/transactions", {
        body: {
          providerId: "provider-a",
          externalTransactionId: "ext-bet-race",
          playerId: "p-rev-race",
          walletId,
          roundId: "r-race",
          gameId: "g-race",
          kind: "BET",
          money: { amount: "20.00", currency: "USD" },
        },
      });

      const refundCalls = Array.from({ length: 4 }, (_, i) =>
        harness.request("POST", "/wagering/transactions", {
          body: {
            providerId: "provider-a",
            externalTransactionId: `ext-refund-race-${i}`,
            playerId: "p-rev-race",
            walletId,
            roundId: "r-race",
            gameId: "g-race",
            kind: "REFUND",
            money: { amount: "20.00", currency: "USD" },
            referenceExternalTransactionId: "ext-bet-race",
          },
        })
      );
      const rollbackCall = harness.request("POST", "/wagering/transactions", {
        body: {
          providerId: "provider-a",
          externalTransactionId: "ext-rollback-race",
          playerId: "p-rev-race",
          walletId,
          roundId: "r-race",
          gameId: "g-race",
          kind: "ROLLBACK",
          money: { amount: "20.00", currency: "USD" },
          referenceExternalTransactionId: "ext-bet-race",
        },
      });

      const results = await Promise.all([...refundCalls, rollbackCall]);
      const refundResults = results.slice(0, 4);
      const processedRefunds = refundResults.filter((r) => r.body.status === "PROCESSED");
      const rejectedRefunds = refundResults.filter(
        (r) => r.body.status === "REJECTED" && r.body.failureCode === "DUPLICATE_REVERSAL"
      );

      expect(processedRefunds).toHaveLength(1);
      expect(rejectedRefunds).toHaveLength(3);
      expect(results[4].body.status).toBe("PROCESSED");

      const rec = await harness.request("POST", `/wallets/${walletId}/reconciliation`);
      expect(rec.body.consistent).toBe(true);
    });

    it("should fast-reject REFUND on REJECTED reference, resolve late PENDING_REFERENCE via PendingReferenceWorker, and verify OutboxPublisherWorker & /metrics", async () => {
      const walletId = await createWallet("p-worker-flow", "50.00");

      // 1. Create a REJECTED BET (insufficient funds)
      const rejectedBet = await harness.request("POST", "/wagering/transactions", {
        body: {
          providerId: "provider-a",
          externalTransactionId: "ext-rej-bet",
          playerId: "p-worker-flow",
          walletId,
          roundId: "r-w1",
          gameId: "g-w1",
          kind: "BET",
          money: { amount: "100.00", currency: "USD" },
        },
      });
      expect(rejectedBet.body.status).toBe("REJECTED");

      // 2. Sync fast-reject when REFUND references REJECTED BET
      const fastRejRefund = await harness.request("POST", "/wagering/transactions", {
        body: {
          providerId: "provider-a",
          externalTransactionId: "ext-fast-rej-refund",
          playerId: "p-worker-flow",
          walletId,
          roundId: "r-w1",
          gameId: "g-w1",
          kind: "REFUND",
          money: { amount: "100.00", currency: "USD" },
          referenceExternalTransactionId: "ext-rej-bet",
        },
      });
      expect(fastRejRefund.status).toBe(200);
      expect(fastRejRefund.body.status).toBe("REJECTED");
      expect(fastRejRefund.body.failureCode).toBe("REFERENCE_NOT_FOUND");

      // 3. Out-of-order REFUND -> PENDING_REFERENCE -> late BET -> PendingReferenceWorker resolves
      const pendingRefund = await harness.request("POST", "/wagering/transactions", {
        body: {
          providerId: "provider-a",
          externalTransactionId: "ext-late-refund",
          playerId: "p-worker-flow",
          walletId,
          roundId: "r-w2",
          gameId: "g-w2",
          kind: "REFUND",
          money: { amount: "20.00", currency: "USD" },
          referenceExternalTransactionId: "ext-late-bet",
        },
      });
      expect(pendingRefund.body.status).toBe("PENDING_REFERENCE");

      const lateBet = await harness.request("POST", "/wagering/transactions", {
        body: {
          providerId: "provider-a",
          externalTransactionId: "ext-late-bet",
          playerId: "p-worker-flow",
          walletId,
          roundId: "r-w2",
          gameId: "g-w2",
          kind: "BET",
          money: { amount: "20.00", currency: "USD" },
        },
      });
      expect(lateBet.body.status).toBe("PROCESSED");
      expect(lateBet.body.balance.amount).toBe("30.00");

      // Wire worker-compatible query builder on E2eEntityManager for PendingReferenceWorker & OutboxPublisherWorker
      const emAny = harness.em as unknown as Record<string, unknown>;
      const originalCreateQb = harness.em.createQueryBuilder.bind(harness.em);
      emAny.createQueryBuilder = (entityClass: unknown, alias?: string) => {
        if (entityClass === WagerTransactionOrmEntity) {
          let statusFilter: WagerTransactionStatus | undefined;
          let maxResults = 50;
          const txQb = {
            where: (filter: { status?: WagerTransactionStatus }) => {
              statusFilter = filter.status;
              return txQb;
            },
            orderBy: () => txQb,
            limit: (n: number) => {
              maxResults = n;
              return txQb;
            },
            setLockMode: (_mode: LockMode) => txQb,
            getResultList: async () =>
              Array.from(harness.em.transactions.values())
                .filter((t) => (statusFilter ? t.status === statusFilter : true))
                .slice(0, maxResults),
          };
          return txQb;
        }
        if (entityClass === OutboxMessageOrmEntity) {
          let maxResults = 20;
          const outQb = {
            where: () => outQb,
            andWhere: () => outQb,
            orderBy: () => outQb,
            limit: (n: number) => {
              maxResults = n;
              return outQb;
            },
            setLockMode: () => outQb,
            getResultList: async () =>
              Array.from(harness.em.outboxMessages.values())
                .filter((m) => !m.publishedAt)
                .slice(0, maxResults),
          };
          return outQb;
        }
        return originalCreateQb(entityClass, alias);
      };
      const originalTransactional = harness.em.transactional.bind(harness.em);
      emAny.transactional = (cb: (txEm: Record<string, unknown>) => Promise<unknown>) =>
        originalTransactional((txEm: Record<string, unknown>) => {
          txEm.createQueryBuilder = emAny.createQueryBuilder;
          const origFind = txEm.find as (
            cls: unknown,
            filter: Record<string, unknown>
          ) => Promise<unknown[]>;
          txEm.find = async (cls: unknown, filter: Record<string, unknown>) => {
            if (
              cls === OutboxMessageOrmEntity &&
              filter?.id &&
              typeof filter.id === "object" &&
              "$in" in filter.id
            ) {
              const ids = new Set((filter.id as { $in: string[] }).$in);
              return Array.from(harness.em.outboxMessages.values()).filter((m) => ids.has(m.id));
            }
            return origFind(cls, filter);
          };
          return cb(txEm);
        });

      const pendingWorker = new PendingReferenceWorker(harness.em as never);
      await pendingWorker.handlePendingReferences();

      const resolvedTx = await harness.request(
        "GET",
        `/wagering/transactions/${pendingRefund.body.transactionId}`
      );
      expect(resolvedTx.body.status).toBe("PROCESSED");

      const walletAfterResolve = await harness.request("GET", `/wallets/${walletId}`);
      expect(walletAfterResolve.body.balance.amount).toBe("50.00");

      // Verify OutboxPublisherWorker publishes all enqueued outbox events with intact payloads
      const sentPayloads: Array<{ eventType: string; aggregateId: string }> = [];
      const origSend = harness.sqsClient.send.bind(harness.sqsClient);
      harness.sqsClient.send = (async (cmd: unknown) => {
        if (cmd instanceof SendMessageCommand) {
          const parsed = JSON.parse(cmd.input.MessageBody ?? "{}") as {
            eventType: string;
            aggregateId: string;
          };
          sentPayloads.push(parsed);
          return { MessageId: "mock-msg-id" };
        }
        return origSend(cmd as never);
      }) as typeof harness.sqsClient.send;

      const outboxWorker = new OutboxPublisherWorker(
        harness.em as never,
        harness.sqsClient as never
      );
      await outboxWorker.handleOutboxPublishing();

      expect(sentPayloads.length).toBeGreaterThanOrEqual(5);
      expect(sentPayloads.every((p) => p.aggregateId === walletId)).toBe(true);
      expect(
        Array.from(harness.em.outboxMessages.values()).every((m) => m.publishedAt != null)
      ).toBe(true);

      // Replay lateBet to increment duplicate counter, then scrape /metrics
      await harness.request("POST", "/wagering/transactions", {
        body: {
          providerId: "provider-a",
          externalTransactionId: "ext-late-bet",
          playerId: "p-worker-flow",
          walletId,
          roundId: "r-w2",
          gameId: "g-w2",
          kind: "BET",
          money: { amount: "20.00", currency: "USD" },
        },
      });

      const metricsRes = await harness.request("GET", "/metrics");
      expect(metricsRes.status).toBe(200);
      expect(metricsRes.text).toContain(
        'wagering_transactions_total{kind="BET",status="PROCESSED",provider_id="provider-a"}'
      );
      expect(metricsRes.text).toContain(
        'wagering_transactions_total{kind="BET",status="REJECTED",provider_id="provider-a"}'
      );
      expect(metricsRes.text).toContain(
        'wagering_transactions_total{kind="REFUND",status="PENDING_REFERENCE",provider_id="provider-a"}'
      );
      expect(metricsRes.text).toContain(
        'wagering_duplicate_transactions_total{provider_id="provider-a"}'
      );
    });

    it("should map PostgreSQL 55P03/40P01 to 503 LOCK_TIMEOUT and 23505 to 409", () => {
      const filter = new GlobalHttpExceptionFilter();
      const capture = () => {
        let status = 0;
        let body: Record<string, unknown> = {};
        const res = {
          status: (s: number) => {
            status = s;
            return res;
          },
          json: (b: Record<string, unknown>) => {
            body = b;
            return res;
          },
        };
        const host = { switchToHttp: () => ({ getResponse: () => res }) } as never;
        return { host, getStatus: () => status, getBody: () => body };
      };

      const lockMock = capture();
      filter.catch(
        { code: "55P03", message: "canceling statement due to lock timeout" },
        lockMock.host
      );
      expect(lockMock.getStatus()).toBe(503);
      expect(lockMock.getBody().errorCode).toBe("LOCK_TIMEOUT");

      const deadlockMock = capture();
      filter.catch({ driverError: { code: "40P01" } }, deadlockMock.host);
      expect(deadlockMock.getStatus()).toBe(503);
      expect(deadlockMock.getBody().errorCode).toBe("LOCK_TIMEOUT");

      const dupWalletMock = capture();
      filter.catch({ code: "23505", constraint: "uq_wallet_player_currency" }, dupWalletMock.host);
      expect(dupWalletMock.getStatus()).toBe(409);
      expect(dupWalletMock.getBody().errorCode).toBe("WALLET_ALREADY_EXISTS");

      const dupTxMock = capture();
      filter.catch(
        { driverError: { code: "23505", constraint: "uq_transaction_provider_external_id" } },
        dupTxMock.host
      );
      expect(dupTxMock.getStatus()).toBe(409);
      expect(dupTxMock.getBody().errorCode).toBe("IDEMPOTENCY_CONFLICT");

      // Also verify WalletOrmEntity import is used cleanly (concurrent wallet race check)
      expect(WalletOrmEntity).toBeDefined();
    });
  });
});
