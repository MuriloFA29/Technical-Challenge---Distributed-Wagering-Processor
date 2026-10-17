import { LockMode } from "@mikro-orm/postgresql";
import {
  WalletOrmEntity,
  WagerTransactionOrmEntity,
  WalletLedgerEntryOrmEntity,
  InboxMessageOrmEntity,
  OutboxMessageOrmEntity,
} from "../../src/infrastructure/database/entities";

/**
 * Mutex para simular pessimistic locking (SELECT FOR UPDATE) no nível de walletId.
 */
class Mutex {
  private queue: (() => void)[] = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.locked = true;
        resolve(() => this.release());
      });
    });
  }

  private release() {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      next?.();
    } else {
      this.locked = false;
    }
  }
}

/**
 * EntityManager em memória com Identity Map e Unit of Work que simula transações ACID,
 * locks pessimistas por walletId e persistência relacional.
 */
export class InMemoryTestEntityManager {
  public wallets = new Map<string, WalletOrmEntity>();
  public transactions = new Map<string, WagerTransactionOrmEntity>();
  public ledgerEntries = new Map<string, WalletLedgerEntryOrmEntity>();
  public inboxMessages = new Map<string, InboxMessageOrmEntity>();
  public outboxMessages = new Map<string, OutboxMessageOrmEntity>();

  private walletMutexes = new Map<string, Mutex>();

  private getMutex(walletId: string): Mutex {
    let m = this.walletMutexes.get(walletId);
    if (!m) {
      m = new Mutex();
      this.walletMutexes.set(walletId, m);
    }
    return m;
  }

  async transactional<T>(cb: (em: any) => Promise<T>): Promise<T> {
    const uncommittedPersists: any[] = [];
    const managedEntities: any[] = [];
    let acquiredReleases: (() => void)[] = [];

    const txEm = {
      findOne: async (entityClass: any, filter: any, options?: { lockMode?: LockMode }) => {
        if (entityClass === WalletOrmEntity) {
          const id = typeof filter === "string" ? filter : filter.id;
          if (id) {
            if (options?.lockMode === LockMode.PESSIMISTIC_WRITE) {
              const release = await this.getMutex(id).acquire();
              acquiredReleases.push(release);
            }
            const found = this.wallets.get(id);
            if (found) {
              managedEntities.push(found);
              return found;
            }
            return null;
          }
          if (filter.playerId && filter.currency) {
            for (const w of this.wallets.values()) {
              if (w.playerId === filter.playerId && w.currency === filter.currency) {
                managedEntities.push(w);
                return w;
              }
            }
          }
          return null;
        }

        if (entityClass === WagerTransactionOrmEntity) {
          if (filter.id) {
            const found = this.transactions.get(filter.id);
            if (found) managedEntities.push(found);
            return found ?? null;
          }
          if (filter.providerId && filter.idempotencyKey) {
            for (const tx of this.transactions.values()) {
              if (tx.providerId === filter.providerId && tx.idempotencyKey === filter.idempotencyKey) {
                managedEntities.push(tx);
                return tx;
              }
            }
          }
          if (filter.providerId && filter.externalTransactionId) {
            for (const tx of this.transactions.values()) {
              if (
                tx.providerId === filter.providerId &&
                tx.externalTransactionId === filter.externalTransactionId &&
                (!filter.status || tx.status === filter.status)
              ) {
                managedEntities.push(tx);
                return tx;
              }
            }
          }
          if (filter.referenceTransactionId && filter.kind) {
            for (const tx of this.transactions.values()) {
              if (
                tx.referenceTransactionId === filter.referenceTransactionId &&
                tx.kind === filter.kind &&
                (!filter.status || tx.status === filter.status)
              ) {
                managedEntities.push(tx);
                return tx;
              }
            }
          }
          return null;
        }

        if (entityClass === InboxMessageOrmEntity) {
          const key = `${filter.consumerName}:${filter.messageId}`;
          const found = this.inboxMessages.get(key);
          if (found) managedEntities.push(found);
          return found ?? null;
        }

        return null;
      },

      find: async (entityClass: any, filter: any, options?: any) => {
        if (entityClass === WalletLedgerEntryOrmEntity) {
          const results: WalletLedgerEntryOrmEntity[] = [];
          for (const l of this.ledgerEntries.values()) {
            if (l.walletId === filter.walletId) {
              results.push(l);
            }
          }
          results.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
          return results;
        }
        if (entityClass === WagerTransactionOrmEntity) {
          const results: WagerTransactionOrmEntity[] = [];
          for (const tx of this.transactions.values()) {
            if (!filter.status || tx.status === filter.status) {
              results.push(tx);
            }
          }
          return results;
        }
        return [];
      },

      create: (_entityClass: any, data: any) => {
        return { ...data };
      },

      persist: (entity: any) => {
        uncommittedPersists.push(entity);
      },

      flush: async () => {
        for (const item of uncommittedPersists) {
          if ("balance" in item && "playerId" in item) {
            this.wallets.set(item.id, item);
          } else if ("idempotencyKey" in item) {
            this.transactions.set(item.id, item);
          } else if ("balanceBefore" in item && "balanceAfter" in item) {
            this.ledgerEntries.set(item.id, item);
          } else if ("consumerName" in item && "messageId" in item) {
            this.inboxMessages.set(`${item.consumerName}:${item.messageId}`, item);
          } else if ("aggregateId" in item && "eventType" in item) {
            this.outboxMessages.set(item.id, item);
          }
        }
      },
    };

    try {
      const result = await cb(txEm);
      await txEm.flush();
      return result;
    } finally {
      // Liberar os locks pessimistas adquiridos nesta transação
      for (const release of acquiredReleases) {
        release();
      }
    }
  }

  async findOne(entityClass: any, filter: any, options?: any) {
    return this.transactional(async (txEm) => txEm.findOne(entityClass, filter, options));
  }

  async find(entityClass: any, filter: any, options?: any) {
    return this.transactional(async (txEm) => txEm.find(entityClass, filter, options));
  }
}
