import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";

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

    // Endpoints de health e métricas são abertos
    const path = request.url || "";
    if (path.startsWith("/health") || path.startsWith("/metrics")) {
      return true;
    }

    // Identidade do provedor injetada no request
    const providerHeader = request.headers["x-provider-id"];
    request.providerIdentity = {
      providerId: providerHeader || "provider-a",
      authenticated: true,
    };

    return true;
  }
}
