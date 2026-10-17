import { EntityManager } from "@mikro-orm/postgresql";
import { WalletNotFoundError } from "../errors/application-errors";
import { WalletOrmEntity, WalletLedgerEntryOrmEntity } from "../../infrastructure/database/entities";
import { decodeCursor, encodeCursor } from "../utils/cursor-pagination";
import { LedgerDirection } from "../../domain/entities/wallet-ledger-entry";
import { MoneyProps } from "../../domain/value-objects/money";

export interface GetWalletLedgerQuery {
  walletId: string;
  cursor?: string;
  limit?: number;
}

export interface LedgerItemDto {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: Date;
}

export interface GetWalletLedgerResult {
  items: LedgerItemDto[];
  nextCursor?: string;
  hasMore: boolean;
}

export class GetWalletLedgerUseCase {
  constructor(private readonly em: EntityManager) {}

  async execute(query: GetWalletLedgerQuery): Promise<GetWalletLedgerResult> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);

    const walletExists = await this.em.findOne(WalletOrmEntity, { id: query.walletId });
    if (!walletExists) {
      throw new WalletNotFoundError(query.walletId);
    }

    const decoded = decodeCursor(query.cursor);

    const qb = this.em
      .createQueryBuilder(WalletLedgerEntryOrmEntity, "l")
      .where({ walletId: query.walletId });

    if (decoded) {
      const cursorDate = new Date(decoded.createdAt);
      qb.andWhere(
        "(l.created_at < ? OR (l.created_at = ? AND l.id < ?))",
        [cursorDate, cursorDate, decoded.id]
      );
    }

    qb.orderBy({ createdAt: "DESC", id: "DESC" });
    qb.limit(limit + 1);

    const results = await qb.getResultList();
    const hasMore = results.length > limit;
    const itemsToReturn = hasMore ? results.slice(0, limit) : results;

    let nextCursor: string | undefined = undefined;
    if (hasMore && itemsToReturn.length > 0) {
      const last = itemsToReturn[itemsToReturn.length - 1];
      nextCursor = encodeCursor({
        createdAt: last.createdAt.toISOString(),
        id: last.id,
      });
    }

    return {
      items: itemsToReturn.map((item) => ({
        id: item.id,
        transactionId: item.transactionId,
        direction: item.direction,
        money: { amount: item.amount, currency: item.currency },
        balanceBefore: { amount: item.balanceBefore, currency: item.currency },
        balanceAfter: { amount: item.balanceAfter, currency: item.currency },
        createdAt: item.createdAt,
      })),
      nextCursor,
      hasMore,
    };
  }
}
