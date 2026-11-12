import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import { Response } from "express";
import {
  IdempotencyConflictError,
  InvalidCursorError,
  InvalidTransactionKindError,
  TransactionNotFoundError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from "../../application/errors/application-errors";
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
import { logger } from "../../infrastructure/observability/app-logger";

function extractPgError(exception: unknown): { code?: string; constraint?: string } {
  if (!exception || typeof exception !== "object") {
    return {};
  }
  const err = exception as {
    code?: unknown;
    constraint?: unknown;
    driverError?: { code?: unknown; constraint?: unknown };
    cause?: { code?: unknown; constraint?: unknown };
  };
  const code =
    typeof err.code === "string"
      ? err.code
      : typeof err.driverError?.code === "string"
        ? err.driverError.code
        : typeof err.cause?.code === "string"
          ? err.cause.code
          : undefined;
  const constraint =
    typeof err.constraint === "string"
      ? err.constraint
      : typeof err.driverError?.constraint === "string"
        ? err.driverError.constraint
        : typeof err.cause?.constraint === "string"
          ? err.cause.constraint
          : undefined;
  return { code, constraint };
}

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
      const resObj =
        typeof res === "object" && res !== null ? (res as Record<string, unknown>) : null;

      if (
        status === HttpStatus.SERVICE_UNAVAILABLE &&
        resObj &&
        "database" in resObj &&
        "sqs" in resObj
      ) {
        response.status(status).json({
          statusCode: status,
          ...resObj,
        });
        return;
      }

      if (typeof res === "string") {
        message = res;
      } else if (Array.isArray(resObj?.message)) {
        message = resObj.message.map((item) => String(item)).join("; ");
      } else if (typeof resObj?.message === "string") {
        message = resObj.message;
      }
      errorCode = Array.isArray(resObj?.message)
        ? "VALIDATION_ERROR"
        : typeof resObj?.error === "string"
          ? resObj.error
          : "HTTP_ERROR";
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
    } else if (exception instanceof InvalidTransactionKindError) {
      status = HttpStatus.BAD_REQUEST; // 400
      errorCode = "INVALID_TRANSACTION_KIND";
      message = exception.message;
    } else if (
      exception instanceof InvalidMoneyError ||
      exception instanceof ReferenceRequirementError ||
      exception instanceof InvalidCursorError
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
      const { code, constraint } = extractPgError(exception);
      if (code === "55P03" || code === "40P01") {
        status = HttpStatus.SERVICE_UNAVAILABLE; // 503
        errorCode = "LOCK_TIMEOUT";
        message = "Resource is temporarily locked; please retry";
      } else if (code === "23505") {
        status = HttpStatus.CONFLICT; // 409
        if (constraint?.includes("wallet")) {
          errorCode = "WALLET_ALREADY_EXISTS";
          message = "Wallet already exists for player and currency";
        } else {
          errorCode = "IDEMPOTENCY_CONFLICT";
          message = "Duplicate resource conflict";
        }
      } else {
        logger.error(`Exceção não tratada: ${(exception as Error)?.message}`);
      }
    }

    response.status(status).json({
      statusCode: status,
      errorCode,
      message,
      timestamp: new Date().toISOString(),
    });
  }
}
