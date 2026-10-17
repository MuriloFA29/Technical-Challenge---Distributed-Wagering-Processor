import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { Response } from "express";
import {
  CurrencyMismatchError,
  DomainError,
  InsufficientFundsError,
  InvalidMoneyError,
  InvalidTransactionStateError,
  ReferenceMismatchError,
  ReferenceRequirementError,
  UnbalancedLedgerEntryError,
} from "../../domain/errors/domain-errors";
import {
  IdempotencyConflictError,
  TransactionNotFoundError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from "../../application/errors/application-errors";
import { logger } from "../../infrastructure/observability/app-logger";

@Catch()
export class GlobalHttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let errorCode = "INTERNAL_SERVER_ERROR";
    let message = "An unexpected error occurred";

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      message = typeof res === "string" ? res : (res as any).message || message;
      errorCode = (res as any).error || "HTTP_ERROR";
    } else if (exception instanceof IdempotencyConflictError) {
      status = HttpStatus.CONFLICT; // 409
      errorCode = "IDEMPOTENCY_CONFLICT";
      message = exception.message;
    } else if (exception instanceof WalletAlreadyExistsError) {
      status = HttpStatus.CONFLICT; // 409
      errorCode = "WALLET_ALREADY_EXISTS";
      message = exception.message;
    } else if (
      exception instanceof WalletNotFoundError ||
      exception instanceof TransactionNotFoundError
    ) {
      status = HttpStatus.NOT_FOUND; // 404
      errorCode = "RESOURCE_NOT_FOUND";
      message = exception.message;
    } else if (
      exception instanceof InvalidMoneyError ||
      exception instanceof ReferenceRequirementError
    ) {
      status = HttpStatus.BAD_REQUEST; // 400
      errorCode = "INVALID_PAYLOAD";
      message = exception.message;
    } else if (
      exception instanceof CurrencyMismatchError ||
      exception instanceof InsufficientFundsError ||
      exception instanceof ReferenceMismatchError ||
      exception instanceof UnbalancedLedgerEntryError ||
      exception instanceof InvalidTransactionStateError
    ) {
      status = HttpStatus.UNPROCESSABLE_ENTITY; // 422
      errorCode = "BUSINESS_RULE_VIOLATION";
      message = exception.message;
    } else if (exception instanceof DomainError) {
      status = HttpStatus.UNPROCESSABLE_ENTITY;
      errorCode = "DOMAIN_ERROR";
      message = exception.message;
    } else {
      logger.error(`Exceção não tratada: ${(exception as Error)?.message}`);
    }

    response.status(status).json({
      statusCode: status,
      errorCode,
      message,
      timestamp: new Date().toISOString(),
    });
  }
}
