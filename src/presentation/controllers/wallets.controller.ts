import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { OpenWalletUseCase } from "../../application/use-cases/open-wallet.use-case";
import { GetWalletUseCase } from "../../application/use-cases/get-wallet.use-case";
import { GetWalletLedgerUseCase } from "../../application/use-cases/get-wallet-ledger.use-case";
import { ReconcileWalletUseCase } from "../../application/use-cases/reconcile-wallet.use-case";
import { MoneyProps } from "../../domain/value-objects/money";

export interface CreateWalletDto {
  playerId: string;
  initialBalance: MoneyProps;
}

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
  async createWallet(@Body() body: CreateWalletDto) {
    return await this.openWalletUseCase.execute({
      playerId: body.playerId,
      initialBalance: body.initialBalance,
    });
  }

  @Get(":walletId")
  async getWallet(@Param("walletId") walletId: string) {
    return await this.getWalletUseCase.execute(walletId);
  }

  @Get(":walletId/ledger")
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
  async reconcileWallet(@Param("walletId") walletId: string) {
    return await this.reconcileWalletUseCase.execute(walletId);
  }
}
