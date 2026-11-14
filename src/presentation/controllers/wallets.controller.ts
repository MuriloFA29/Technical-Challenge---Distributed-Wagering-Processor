import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from "@nestjs/common";
import {
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from "@nestjs/swagger";
import { GetWalletUseCase } from "../../application/use-cases/get-wallet.use-case";
import { GetWalletLedgerUseCase } from "../../application/use-cases/get-wallet-ledger.use-case";
import { OpenWalletUseCase } from "../../application/use-cases/open-wallet.use-case";
import { ReconcileWalletUseCase } from "../../application/use-cases/reconcile-wallet.use-case";
import { CreateWalletDto } from "../dto/create-wallet.dto";
import {
  ReconciliationResponseDto,
  WalletLedgerResponseDto,
  WalletResponseDto,
} from "../dto/responses.dto";

export { CreateWalletDto };

@ApiTags("Wallets")
@ApiSecurity("x-provider-id")
@Controller("wallets")
export class WalletsController {
  constructor(
    private readonly openWalletUseCase: OpenWalletUseCase,
    private readonly getWalletUseCase: GetWalletUseCase,
    private readonly getWalletLedgerUseCase: GetWalletLedgerUseCase,
    private readonly reconcileWalletUseCase: ReconcileWalletUseCase
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Open a new player wallet with an initial balance" })
  @ApiResponse({ status: 201, description: "Wallet created", type: WalletResponseDto })
  @ApiResponse({ status: 400, description: "Invalid request payload" })
  @ApiResponse({ status: 409, description: "Wallet already exists for player and currency" })
  @ApiResponse({ status: 422, description: "Business rule violation (e.g., negative balance)" })
  async createWallet(@Body() body: CreateWalletDto) {
    return await this.openWalletUseCase.execute({
      playerId: body.playerId,
      initialBalance: body.initialBalance,
    });
  }

  @Get(":walletId")
  @ApiOperation({ summary: "Retrieve wallet details by ID" })
  @ApiParam({ name: "walletId", description: "Wallet UUID" })
  @ApiResponse({ status: 200, description: "Wallet found", type: WalletResponseDto })
  @ApiResponse({ status: 404, description: "Wallet not found" })
  async getWallet(@Param("walletId") walletId: string) {
    return await this.getWalletUseCase.execute(walletId);
  }

  @Get(":walletId/ledger")
  @ApiOperation({ summary: "Retrieve paginated immutable ledger entries for a wallet" })
  @ApiParam({ name: "walletId", description: "Wallet UUID" })
  @ApiQuery({ name: "cursor", required: false, description: "Opaque pagination cursor" })
  @ApiQuery({
    name: "limit",
    required: false,
    description: "Page size (clamped between 1 and 100)",
  })
  @ApiResponse({ status: 200, description: "Ledger page", type: WalletLedgerResponseDto })
  @ApiResponse({ status: 404, description: "Wallet not found" })
  async getLedger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string
  ) {
    return await this.getWalletLedgerUseCase.execute({
      walletId,
      cursor,
      limit: limit ? parseInt(limit, 10) : 50,
    });
  }

  @Post(":walletId/reconciliation")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Reconcile stored wallet balance against immutable ledger history" })
  @ApiParam({ name: "walletId", description: "Wallet UUID" })
  @ApiResponse({
    status: 200,
    description: "Reconciliation report",
    type: ReconciliationResponseDto,
  })
  @ApiResponse({ status: 404, description: "Wallet not found" })
  async reconcileWallet(@Param("walletId") walletId: string) {
    return await this.reconcileWalletUseCase.execute(walletId);
  }
}
