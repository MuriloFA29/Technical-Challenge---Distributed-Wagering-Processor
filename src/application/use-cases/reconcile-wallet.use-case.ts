import { EntityManager, LockMode } from "@mikro-orm/postgresql";
import { LedgerDirection } from "../../domain/entities/wallet-ledger-entry";
import { Money, MoneyProps } from "../../domain/value-objects/money";
import {
  WalletLedgerEntryOrmEntity,
  WalletOrmEntity,
} from "../../infrastructure/database/entities";
import { WalletNotFoundError } from "../errors/application-errors";

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
    return await this.em.transactional(async (txEm) => {
      const wallet = await txEm.findOne(
        WalletOrmEntity,
        { id: walletId },
        { lockMode: LockMode.PESSIMISTIC_READ }
      );

      if (!wallet) {
        throw new WalletNotFoundError(walletId);
      }

      const currency = wallet.currency;
      const storedBalance = Money.from({ amount: wallet.balance, currency });

      let calculatedBalance: Money;
      let checkedEntries: number;

      if (typeof txEm.getConnection === "function") {
        const rows = await txEm
          .getConnection()
          .execute<{ netBalance: string; checkedEntries: number }[]>(
            `SELECT
             COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount WHEN direction = 'DEBIT' THEN -amount ELSE 0 END), 0.00)::text AS "netBalance",
             COUNT(*)::int AS "checkedEntries"
           FROM wallet_ledger_entries
           WHERE wallet_id = ?`,
            [walletId]
          );

        const row = rows[0] ?? { netBalance: "0.00", checkedEntries: 0 };
        calculatedBalance = Money.from({ amount: row.netBalance, currency });
        checkedEntries = Number(row.checkedEntries ?? 0);
      } else {
        // Fallback para EntityManager em memória nos testes unitários e de concorrência
        const ledgerEntries = await txEm.find(
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

        calculatedBalance = runningBalance;
        checkedEntries = ledgerEntries.length;
      }

      const difference = storedBalance.subtract(calculatedBalance);
      const isConsistent = difference.isZero();

      return {
        walletId: wallet.id,
        storedBalance: storedBalance.toJSON(),
        calculatedBalance: calculatedBalance.toJSON(),
        difference: difference.toJSON(),
        consistent: isConsistent,
        checkedEntries,
      };
    });
  }
}
