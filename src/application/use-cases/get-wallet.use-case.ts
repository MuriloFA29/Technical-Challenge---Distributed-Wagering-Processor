import { EntityManager } from "@mikro-orm/postgresql";
import { MoneyProps } from "../../domain/value-objects/money";
import { WalletOrmEntity } from "../../infrastructure/database/entities";
import { WalletNotFoundError } from "../errors/application-errors";

export interface GetWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class GetWalletUseCase {
  constructor(private readonly em: EntityManager) {}

  async execute(walletId: string): Promise<GetWalletResult> {
    const wallet = await this.em.findOne(WalletOrmEntity, { id: walletId });

    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: {
        amount: wallet.balance,
        currency: wallet.currency,
      },
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  }
}
