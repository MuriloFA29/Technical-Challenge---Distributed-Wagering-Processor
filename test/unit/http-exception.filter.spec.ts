import { describe, expect, it } from "bun:test";
import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import {
  ApplicationError,
  IdempotencyConflictError,
  InvalidTransactionKindError,
  TransactionNotFoundError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from "../../src/application/errors/application-errors";
import {
  CurrencyMismatchError,
  DomainError,
  DuplicateReversalError,
  InsufficientFundsError,
  InvalidMoneyError,
  InvalidTransactionStateError,
  ReferenceMismatchError,
  ReferenceRequirementError,
  UnbalancedLedgerEntryError,
} from "../../src/domain/errors/domain-errors";
import { GlobalHttpExceptionFilter } from "../../src/presentation/filters/http-exception.filter";

function createMockHost() {
  let capturedStatus = 0;
  let capturedBody: Record<string, unknown> = {};

  const response = {
    status: (code: number) => {
      capturedStatus = code;
      return response;
    },
    json: (body: Record<string, unknown>) => {
      capturedBody = body;
      return response;
    },
  };

  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;

  return {
    host,
    getStatus: () => capturedStatus,
    getBody: () => capturedBody,
  };
}

describe("GlobalHttpExceptionFilter", () => {
  const filter = new GlobalHttpExceptionFilter();

  it("deve mapear HttpException com resposta em string", () => {
    const { host, getStatus, getBody } = createMockHost();
    filter.catch(new HttpException("Acesso negado", HttpStatus.FORBIDDEN), host);

    expect(getStatus()).toBe(403);
    expect(getBody().statusCode).toBe(403);
    expect(getBody().errorCode).toBe("HTTP_ERROR");
    expect(getBody().message).toBe("Acesso negado");
    expect(Number.isNaN(Date.parse(String(getBody().timestamp)))).toBe(false);
  });

  it("deve mapear HttpException com objeto contendo message string e error", () => {
    const { host, getStatus, getBody } = createMockHost();
    filter.catch(new ForbiddenException("Recurso bloqueado"), host);

    expect(getStatus()).toBe(403);
    expect(getBody().errorCode).toBe("Forbidden");
    expect(getBody().message).toBe("Recurso bloqueado");
  });

  it("deve mapear HttpException com array de mensagens de validação para VALIDATION_ERROR", () => {
    const { host, getStatus, getBody } = createMockHost();
    filter.catch(new BadRequestException(["walletId inválido", "amount deve ser positivo"]), host);

    expect(getStatus()).toBe(400);
    expect(getBody().errorCode).toBe("VALIDATION_ERROR");
    expect(getBody().message).toBe("walletId inválido; amount deve ser positivo");
  });

  it("deve manter mensagem e errorCode padrão quando objeto HttpException não tem message/error string", () => {
    const { host, getStatus, getBody } = createMockHost();
    filter.catch(new HttpException({ detail: 123 }, HttpStatus.BAD_REQUEST), host);

    expect(getStatus()).toBe(400);
    expect(getBody().errorCode).toBe("HTTP_ERROR");
    expect(getBody().message).toBe("An unexpected error occurred");
  });

  it("deve mapear erros de conflito 409 (IdempotencyConflictError e WalletAlreadyExistsError)", () => {
    const mock1 = createMockHost();
    filter.catch(new IdempotencyConflictError("key-1"), mock1.host);
    expect(mock1.getStatus()).toBe(409);
    expect(mock1.getBody().errorCode).toBe("IDEMPOTENCY_CONFLICT");

    const mock2 = createMockHost();
    filter.catch(new WalletAlreadyExistsError("player-1", "BRL"), mock2.host);
    expect(mock2.getStatus()).toBe(409);
    expect(mock2.getBody().errorCode).toBe("WALLET_ALREADY_EXISTS");
  });

  it("deve mapear erros 404 (WalletNotFoundError e TransactionNotFoundError)", () => {
    const mock1 = createMockHost();
    filter.catch(new WalletNotFoundError("w-1"), mock1.host);
    expect(mock1.getStatus()).toBe(404);
    expect(mock1.getBody().errorCode).toBe("RESOURCE_NOT_FOUND");
    expect(mock1.getBody().message).toBe("Wallet w-1 not found");

    const mock2 = createMockHost();
    filter.catch(new TransactionNotFoundError("tx-1"), mock2.host);
    expect(mock2.getStatus()).toBe(404);
    expect(mock2.getBody().errorCode).toBe("RESOURCE_NOT_FOUND");
    expect(mock2.getBody().message).toBe("Transaction tx-1 not found");
  });

  it("deve mapear erros 400 (InvalidTransactionKindError, InvalidMoneyError, ReferenceRequirementError)", () => {
    const mock1 = createMockHost();
    filter.catch(new InvalidTransactionKindError("OPENING"), mock1.host);
    expect(mock1.getStatus()).toBe(400);
    expect(mock1.getBody().errorCode).toBe("INVALID_TRANSACTION_KIND");

    const mock2 = createMockHost();
    filter.catch(new InvalidMoneyError("negative"), mock2.host);
    expect(mock2.getStatus()).toBe(400);
    expect(mock2.getBody().errorCode).toBe("INVALID_PAYLOAD");

    const mock3 = createMockHost();
    filter.catch(new ReferenceRequirementError("REFUND"), mock3.host);
    expect(mock3.getStatus()).toBe(400);
    expect(mock3.getBody().errorCode).toBe("INVALID_PAYLOAD");
  });

  it("deve mapear violações de regra de negócio 422 para BUSINESS_RULE_VIOLATION", () => {
    const businessErrors = [
      new CurrencyMismatchError("BRL", "USD"),
      new InsufficientFundsError("10.00", "50.00"),
      new ReferenceMismatchError("player mismatch"),
      new UnbalancedLedgerEntryError("debit != credit"),
      new InvalidTransactionStateError("PROCESSED", "REJECTED"),
    ];

    for (const err of businessErrors) {
      const { host, getStatus, getBody } = createMockHost();
      filter.catch(err, host);
      expect(getStatus()).toBe(422);
      expect(getBody().errorCode).toBe("BUSINESS_RULE_VIOLATION");
      expect(getBody().message).toBe(err.message);
    }
  });

  it("deve mapear DuplicateReversalError e DomainError genérico para 422 DOMAIN_ERROR", () => {
    const mock1 = createMockHost();
    const dupErr = new DuplicateReversalError("ref-1", "REFUND");
    filter.catch(dupErr, mock1.host);
    expect(mock1.getStatus()).toBe(422);
    expect(mock1.getBody().errorCode).toBe("DOMAIN_ERROR");
    expect(mock1.getBody().message).toBe(dupErr.message);

    const mock2 = createMockHost();
    const baseDomainErr = new DomainError("regra de domínio genérica");
    filter.catch(baseDomainErr, mock2.host);
    expect(mock2.getStatus()).toBe(422);
    expect(mock2.getBody().errorCode).toBe("DOMAIN_ERROR");
    expect(mock2.getBody().message).toBe("regra de domínio genérica");
  });

  it("deve mapear ApplicationError não listado, Error desconhecido e valores não-Error para 500", () => {
    const unknownValues: unknown[] = [
      new ApplicationError("erro de aplicação sem mapeamento"),
      new Error("falha inesperada de banco"),
      "string error",
      null,
      42,
    ];

    for (const err of unknownValues) {
      const { host, getStatus, getBody } = createMockHost();
      filter.catch(err, host);
      expect(getStatus()).toBe(500);
      expect(getBody().statusCode).toBe(500);
      expect(getBody().errorCode).toBe("INTERNAL_SERVER_ERROR");
      expect(getBody().message).toBe("An unexpected error occurred");
    }
  });
});
