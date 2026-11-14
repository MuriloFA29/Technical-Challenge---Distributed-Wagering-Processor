import { BadRequestException, CanActivate, ExecutionContext, Injectable } from "@nestjs/common";

export interface ProviderIdentity {
  providerId: string;
  authenticated: boolean;
}

/**
 * Ponto de extensão explícito para autenticação de provedores e jogadores (conforme Seção 2 do README).
 * Em ambiente de teste/demonstração opera como no-op seguro ou validação por chave de API/header.
 * O desenho da arquitetura OIDC/Keycloak é documentado no ARCHITECTURE.md.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();

    // Endpoints de health, métricas e documentação OpenAPI são abertos
    const path = request.url || "";
    if (
      path.startsWith("/health") ||
      path.startsWith("/metrics") ||
      path === "/docs" ||
      path.startsWith("/docs/") ||
      path.startsWith("/docs-json")
    ) {
      return true;
    }

    // Identidade do provedor injetada no request
    const rawHeader = request.headers["x-provider-id"];
    const providerHeader = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    if (
      typeof providerHeader === "string" &&
      providerHeader.length > 0 &&
      providerHeader.trim().length === 0
    ) {
      throw new BadRequestException("X-Provider-Id header cannot be whitespace-only");
    }

    const normalizedProvider =
      typeof providerHeader === "string" && providerHeader.trim().length > 0
        ? providerHeader.trim()
        : "provider-a";

    request.providerIdentity = {
      providerId: normalizedProvider,
      authenticated: true,
    };

    return true;
  }
}
