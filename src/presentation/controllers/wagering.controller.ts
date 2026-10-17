import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from "@nestjs/common";
import { ProcessWagerTransactionUseCase } from "../../application/use-cases/process-wager-transaction.use-case";
import { GetTransactionUseCase } from "../../application/use-cases/get-transaction.use-case";
import { WagerTransactionKind } from "../../domain/entities/wager-transaction";
import { MoneyProps } from "../../domain/value-objects/money";
import { logFinancialEvent } from "../../infrastructure/observability/app-logger";

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
    @Body() body: SubmitTransactionDto
  ) {
    const idempotencyKey =
      idempotencyKeyHeader || `${body.providerId}:${body.externalTransactionId}`;

    if (!idempotencyKey) {
      throw new BadRequestException("Header 'Idempotency-Key' is required");
    }

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
    @Param("externalTransactionId") externalTransactionId: string
  ) {
    return await this.getTxUseCase.executeByExternalId(
      providerId,
      externalTransactionId
    );
  }
}
