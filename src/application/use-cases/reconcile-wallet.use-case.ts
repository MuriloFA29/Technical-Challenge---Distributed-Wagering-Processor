import { EntityManager } from "@mikro-orm/postgresql";
import { WalletNotFoundError } from "../errors/application-errors";
import { WalletOrmEntity, WalletLedgerEntryOrmEntity } from "../../infrastructure/database/entities";
import { Money, MoneyProps } from "../../domain/value-objects/money";
import { LedgerDirection } from "../../domain/entities/wallet-ledger-entry";

export interface ReconcileWalletResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

export class ReconcileWalletUseCase {
  constructor(private readonly em: EntityManager) {}

  async execute(walletId: string): Promise<ReconcileWalletResult> {
    const wallet = await this.em.findOne(WalletOrmEntity, { id: walletId });

    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }

    const currency = wallet.currency;
    const storedBalance = Money.from({ amount: wallet.balance, currency });

    // Buscar todos os lançamentos do ledger ordenados por data crescente
    const ledgerEntries = await this.em.find(
      WalletLedgerEntryOrmEntity,
      { walletId },
      { orderBy: { createdAt: "ASC", id: "ASC" } }
    );

    let runningBalance = Money.zero(currency);

    for (const entry of ledgerEntries) {
      const entryMoney = Money.from({ amount: entry.amount, currency: entry.currency });
      if (entry.direction === LedgerDirection.Credit) {
        runningBalance = runningBalance.add(entryMoney);
      } else if (entry.direction === LedgerDirection.Debit) {
        runningBalance = runningBalance.subtract(entryMoney);
      }
    }

    const calculatedBalance = runningBalance;
    const difference = storedBalance.subtract(calculatedBalance);
    const isConsistent = difference.isZero();

    return {
      walletId: wallet.id,
      storedBalance: storedBalance.toJSON(),
      calculatedBalance: calculatedBalance.toJSON(),
      difference: difference.toJSON(),
      consistent: isConsistent,
      checkedEntries: ledgerEntries.length,
    };
  }
}
