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
import {
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from "@nestjs/swagger";
import { GetTransactionUseCase } from "../../application/use-cases/get-transaction.use-case";
import { ProcessWagerTransactionUseCase } from "../../application/use-cases/process-wager-transaction.use-case";
import { logFinancialEvent } from "../../infrastructure/observability/app-logger";
import { TransactionDetailResponseDto, TransactionResultResponseDto } from "../dto/responses.dto";
import { SubmitTransactionDto } from "../dto/submit-transaction.dto";
import { ProviderIdentity } from "../guards/auth.guard";
import type { CorrelatedRequest } from "../middleware/correlation-id.middleware";

export { SubmitTransactionDto };

@ApiTags("Wagering")
@ApiSecurity("x-provider-id")
@Controller()
export class WageringController {
  constructor(
    private readonly processWagerTxUseCase: ProcessWagerTransactionUseCase,
    private readonly getTxUseCase: GetTransactionUseCase
  ) {}

  @Post("wagering/transactions")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Submit a wagering transaction (BET, WIN, LOSS, REFUND, ROLLBACK)" })
  @ApiHeader({
    name: "idempotency-key",
    required: false,
    description: "Optional idempotency key (defaults to providerId:externalTransactionId)",
  })
  @ApiResponse({
    status: 200,
    description: "Transaction processed, pending reference, or business-rejected",
    type: TransactionResultResponseDto,
  })
  @ApiResponse({ status: 400, description: "Invalid request payload or transaction kind" })
  @ApiResponse({ status: 403, description: "Provider identity mismatch" })
  @ApiResponse({ status: 404, description: "Wallet not found" })
  @ApiResponse({
    status: 409,
    description: "Idempotency conflict (different payload for same key)",
  })
  async submitTransaction(
    @Headers("idempotency-key") idempotencyKeyHeader: string,
    @Body() body: SubmitTransactionDto,
    @Req() request?: CorrelatedRequest & { providerIdentity?: ProviderIdentity }
  ) {
    if (
      request?.providerIdentity?.providerId &&
      request.providerIdentity.providerId !== body.providerId
    ) {
      throw new ForbiddenException("Provider identity does not match body providerId");
    }

    const trimmedIdempotencyKey =
      typeof idempotencyKeyHeader === "string" ? idempotencyKeyHeader.trim() : "";
    const idempotencyKey =
      trimmedIdempotencyKey.length > 0
        ? trimmedIdempotencyKey
        : `${body.providerId}:${body.externalTransactionId}`;

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
      correlationId: request?.correlationId || idempotencyKey,
      transactionId: result.transactionId,
      walletId: body.walletId,
      providerId: body.providerId,
      status: result.status,
      failureCode: result.failureCode,
    });

    return result;
  }

  @Get("wagering/transactions/:transactionId")
  @ApiOperation({ summary: "Retrieve a wagering transaction by internal ID" })
  @ApiParam({ name: "transactionId", description: "Internal transaction UUID" })
  @ApiResponse({
    status: 200,
    description: "Transaction found",
    type: TransactionDetailResponseDto,
  })
  @ApiResponse({ status: 404, description: "Transaction not found" })
  async getTransactionById(@Param("transactionId") transactionId: string) {
    return await this.getTxUseCase.executeById(transactionId);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  @ApiOperation({ summary: "Retrieve a wagering transaction by provider and external ID" })
  @ApiParam({ name: "providerId", description: "Game provider identifier" })
  @ApiParam({ name: "externalTransactionId", description: "External transaction ID" })
  @ApiResponse({
    status: 200,
    description: "Transaction found",
    type: TransactionDetailResponseDto,
  })
  @ApiResponse({ status: 403, description: "Provider identity mismatch" })
  @ApiResponse({ status: 404, description: "Transaction not found" })
  async getTransactionByExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
    @Req() request?: CorrelatedRequest & { providerIdentity?: ProviderIdentity }
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
