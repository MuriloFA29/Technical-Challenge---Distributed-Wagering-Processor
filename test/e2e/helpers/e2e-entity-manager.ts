import { WalletLedgerEntryOrmEntity } from "../../../src/infrastructure/database/entities";
import { InMemoryTestEntityManager } from "../../helpers/mock-entity-manager";

interface LedgerQueryBuilder {
  where(filter: { walletId?: string }): LedgerQueryBuilder;
  andWhere(clause: string, params: unknown[]): LedgerQueryBuilder;
  orderBy(order: Record<string, "ASC" | "DESC">): LedgerQueryBuilder;
  limit(n: number): LedgerQueryBuilder;
  getResultList(): Promise<WalletLedgerEntryOrmEntity[]>;
}

/**
 * In-memory EntityManager extended for NestJS E2E HTTP tests.
 * Implements `getConnection().execute(...)` for HealthController readiness checks
 * and `createQueryBuilder(...)` for cursor-paginated ledger queries.
 */
export class E2eEntityManager extends InMemoryTestEntityManager {
  public dbHealthy = true;

  getConnection() {
    return {
      execute: async (sql: string): Promise<unknown[]> => {
        if (!this.dbHealthy) {
          throw new Error("Simulated database connection failure");
        }
        if (sql.trim().toUpperCase().startsWith("SELECT 1")) {
          return [{ "?column?": 1 }];
        }
        return [];
      },
    };
  }

  createQueryBuilder(entityClass: unknown, _alias?: string): LedgerQueryBuilder {
    if (entityClass !== WalletLedgerEntryOrmEntity) {
      throw new Error(
        `E2eEntityManager.createQueryBuilder: unsupported entity ${String(entityClass)}`
      );
    }

    let walletIdFilter: string | undefined;
    let cursorDate: Date | undefined;
    let cursorId: string | undefined;
    let maxResults: number | undefined;

    const qb: LedgerQueryBuilder = {
      where: (filter: { walletId?: string }) => {
        walletIdFilter = filter.walletId;
        return qb;
      },
      andWhere: (_clause: string, params: unknown[]) => {
        if (params.length >= 3 && params[0] instanceof Date && typeof params[2] === "string") {
          cursorDate = params[0];
          cursorId = params[2];
        }
        return qb;
      },
      orderBy: (_order: Record<string, "ASC" | "DESC">) => {
        return qb;
      },
      limit: (n: number) => {
        maxResults = n;
        return qb;
      },
      getResultList: async () => {
        let items = Array.from(this.ledgerEntries.values());

        if (walletIdFilter !== undefined) {
          items = items.filter((entry) => entry.walletId === walletIdFilter);
        }

        if (cursorDate !== undefined && cursorId !== undefined) {
          const targetTime = cursorDate.getTime();
          const targetId = cursorId;
          items = items.filter((entry) => {
            const entryTime = entry.createdAt.getTime();
            return entryTime < targetTime || (entryTime === targetTime && entry.id < targetId);
          });
        }

        items.sort((a, b) => {
          const timeDiff = b.createdAt.getTime() - a.createdAt.getTime();
          if (timeDiff !== 0) {
            return timeDiff;
          }
          if (b.id < a.id) return -1;
          if (b.id > a.id) return 1;
          return 0;
        });

        if (maxResults !== undefined) {
          items = items.slice(0, maxResults);
        }

        return items;
      },
    };

    return qb;
  }

  reset(): void {
    this.wallets.clear();
    this.transactions.clear();
    this.ledgerEntries.clear();
    this.inboxMessages.clear();
    this.outboxMessages.clear();
    this.dbHealthy = true;
  }
}
