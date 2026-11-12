import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import { GetTransactionUseCase } from "../../application/use-cases/get-transaction.use-case";
import { ProcessWagerTransactionUseCase } from "../../application/use-cases/process-wager-transaction.use-case";
import { WagerTransactionKind } from "../../domain/entities/wager-transaction";
import { MoneyProps } from "../../domain/value-objects/money";
import { logFinancialEvent } from "../../infrastructure/observability/app-logger";
import { ProviderIdentity } from "../guards/auth.guard";

export interface SubmitTransactionDto {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

@Controller()
export class WageringController {
  constructor(
    private readonly processWagerTxUseCase: ProcessWagerTransactionUseCase,
    private readonly getTxUseCase: GetTransactionUseCase
  ) {}

  @Post("wagering/transactions")
  @HttpCode(HttpStatus.OK)
  async submitTransaction(
    @Headers("idempotency-key") idempotencyKeyHeader: string,
    @Body() body: SubmitTransactionDto,
    @Req() request?: Request & { providerIdentity?: ProviderIdentity }
  ) {
    if (
      request?.providerIdentity?.providerId &&
      request.providerIdentity.providerId !== body.providerId
    ) {
      throw new ForbiddenException("Provider identity does not match body providerId");
    }

    const idempotencyKey =
      idempotencyKeyHeader || `${body.providerId}:${body.externalTransactionId}`;

    const result = await this.processWagerTxUseCase.execute({
      providerId: body.providerId,
      externalTransactionId: body.externalTransactionId,
      idempotencyKey,
      playerId: body.playerId,
      walletId: body.walletId,
      roundId: body.roundId,
      gameId: body.gameId,
      kind: body.kind,
      money: body.money,
      referenceExternalTransactionId: body.referenceExternalTransactionId,
    });

    logFinancialEvent({
      event: "TransactionSubmitted",
      correlationId: idempotencyKey,
      transactionId: result.transactionId,
      walletId: body.walletId,
      providerId: body.providerId,
      status: result.status,
      failureCode: result.failureCode,
    });

    return result;
  }

  @Get("wagering/transactions/:transactionId")
  async getTransactionById(@Param("transactionId") transactionId: string) {
    return await this.getTxUseCase.executeById(transactionId);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async getTransactionByExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
    @Req() request?: Request & { providerIdentity?: ProviderIdentity }
  ) {
    if (
      request?.providerIdentity?.providerId &&
      request.providerIdentity.providerId !== providerId
    ) {
      throw new ForbiddenException("Provider identity does not match route providerId");
    }

    return await this.getTxUseCase.executeByExternalId(providerId, externalTransactionId);
  }
}
