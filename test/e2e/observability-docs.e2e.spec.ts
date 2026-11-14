import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createE2eApp, E2eTestHarness } from "./helpers/e2e-app";

describe("E2E Observability, CorrelationId, ValidationPipe & OpenAPI (/docs)", () => {
  let harness: E2eTestHarness;

  beforeAll(async () => {
    harness = await createE2eApp();
  });

  beforeEach(() => {
    harness.reset();
  });

  afterAll(async () => {
    await harness.close();
  });

  it("should generate X-Correlation-Id when missing and echo x-correlation-id when provided", async () => {
    const resAuto = await harness.request("GET", "/health/live");
    expect(resAuto.status).toBe(200);
    const autoId = resAuto.headers.get("x-correlation-id");
    expect(autoId).toBeTruthy();

    const customId = "corr-m4-trace-123";
    const resEcho = await harness.request("GET", "/health/live", {
      headers: { "x-correlation-id": customId },
    });
    expect(resEcho.status).toBe(200);
    expect(resEcho.headers.get("x-correlation-id")).toBe(customId);
  });

  it("should serve OpenAPI JSON at /docs-json and Swagger UI at /docs without auth", async () => {
    const docsJsonRes = await harness.request<Record<string, any>>("GET", "/docs-json");
    expect(docsJsonRes.status).toBe(200);
    expect(docsJsonRes.body.openapi).toBeDefined();
    expect(docsJsonRes.body.info?.title).toBe("Distributed Wagering Processor");
    expect(docsJsonRes.body.paths?.["/wallets"]).toBeDefined();
    expect(docsJsonRes.body.paths?.["/wagering/transactions"]).toBeDefined();
    expect(docsJsonRes.body.paths?.["/health/live"]).toBeDefined();
    expect(docsJsonRes.body.paths?.["/metrics"]).toBeDefined();

    const docsHtmlRes = await harness.request("GET", "/docs/");
    expect(docsHtmlRes.status).toBe(200);
    expect(docsHtmlRes.text).toContain("Swagger UI");
  });

  it("should return structured 400 VALIDATION_ERROR with joined messages from ValidationPipe", async () => {
    const res = await harness.request("POST", "/wallets", {
      body: { playerId: "", initialBalance: { amount: "abc", currency: "US" } },
    });

    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe("VALIDATION_ERROR");
    expect(typeof res.body.message).toBe("string");
    expect(res.body.message).not.toBe("An unexpected error occurred");
  });

  it("should expose populated Prometheus metrics on GET /metrics after transactions", async () => {
    const walletRes = await harness.request("POST", "/wallets", {
      body: { playerId: "p-metrics", initialBalance: { amount: "100.00", currency: "USD" } },
    });
    expect(walletRes.status).toBe(201);

    const txRes = await harness.request("POST", "/wagering/transactions", {
      body: {
        providerId: "provider-a",
        externalTransactionId: "ext-m4-1",
        playerId: "p-metrics",
        walletId: walletRes.body.id,
        roundId: "r-1",
        gameId: "g-1",
        kind: "BET",
        money: { amount: "10.00", currency: "USD" },
      },
    });
    expect(txRes.status).toBe(200);

    const metricsRes = await harness.request("GET", "/metrics");
    expect(metricsRes.status).toBe(200);
    expect(metricsRes.text).toContain(
      'wagering_transactions_total{kind="BET",status="PROCESSED",provider_id="provider-a"}'
    );
    expect(metricsRes.text).toContain(
      'wagering_transaction_duration_seconds_count{kind="BET",status="PROCESSED"}'
    );
  });
});
