import { describe, expect, it } from "bun:test";
import { ExecutionContext } from "@nestjs/common";
import { AuthGuard, ProviderIdentity } from "../../src/presentation/guards/auth.guard";

interface MockRequest {
  url?: string;
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
  providerIdentity?: ProviderIdentity;
}

function createExecutionContext(req: MockRequest): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
  } as unknown as ExecutionContext;
}

describe("AuthGuard", () => {
  const guard = new AuthGuard();

  it("deve liberar endpoints públicos sem injetar providerIdentity", () => {
    const publicUrls = [
      "/health",
      "/health/ready",
      "/health?verbose=true",
      "/metrics",
      "/metrics/prom",
      "/docs",
      "/docs/",
      "/docs/index.html",
      "/docs-json",
      "/docs-json?v=1",
    ];

    for (const url of publicUrls) {
      const req: MockRequest = {
        url,
        headers: { "x-provider-id": "prov-x" },
      };

      const allowed = guard.canActivate(createExecutionContext(req));
      expect(allowed).toBe(true);
      expect(req.providerIdentity).toBeUndefined();
    }
  });

  it("deve injetar providerIdentity em rotas protegidas e prefixos similares não públicos", () => {
    const protectedUrls = ["/wallets", "/transactions/123", "/docs2", "/docs-yaml", ""];

    for (const url of protectedUrls) {
      const req: MockRequest = {
        url,
        headers: { "x-provider-id": "prov-custom" },
      };

      const allowed = guard.canActivate(createExecutionContext(req));
      expect(allowed).toBe(true);
      expect(req.providerIdentity).toEqual({
        providerId: "prov-custom",
        authenticated: true,
      });
    }
  });

  it("deve extrair o primeiro elemento quando x-provider-id for array", () => {
    const req: MockRequest = {
      url: "/transactions",
      headers: { "x-provider-id": ["prov-first", "prov-second"] },
    };

    expect(guard.canActivate(createExecutionContext(req))).toBe(true);
    expect(req.providerIdentity).toEqual({
      providerId: "prov-first",
      authenticated: true,
    });
  });

  it("deve usar fallback provider-a quando x-provider-id estiver ausente ou vazio", () => {
    const cases: Array<Record<string, string | string[] | undefined>> = [
      {},
      { "x-provider-id": "" },
      { "x-provider-id": [""] },
    ];

    for (const headers of cases) {
      const req: MockRequest = {
        url: "/wallets/w-1",
        headers,
      };

      expect(guard.canActivate(createExecutionContext(req))).toBe(true);
      expect(req.providerIdentity).toEqual({
        providerId: "provider-a",
        authenticated: true,
      });
    }
  });

  it("deve usar request.url em vez de request.originalUrl para checagem de rota pública", () => {
    const protectedReq: MockRequest = {
      url: "/wallets",
      originalUrl: "/health",
      headers: { "x-provider-id": "prov-url" },
    };
    expect(guard.canActivate(createExecutionContext(protectedReq))).toBe(true);
    expect(protectedReq.providerIdentity).toEqual({
      providerId: "prov-url",
      authenticated: true,
    });

    const publicReq: MockRequest = {
      url: "/health",
      originalUrl: "/api/v1/health",
      headers: { "x-provider-id": "prov-url" },
    };
    expect(guard.canActivate(createExecutionContext(publicReq))).toBe(true);
    expect(publicReq.providerIdentity).toBeUndefined();
  });
});
