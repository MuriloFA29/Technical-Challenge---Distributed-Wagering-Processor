import { EntityManager } from "@mikro-orm/postgresql";
import { v7 as uuidv7 } from "uuid";
import { Money, MoneyProps } from "../../domain/value-objects/money";
import { Wallet } from "../../domain/entities/wallet";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/entities/wager-transaction";
import {
  LedgerDirection,
  WalletLedgerEntry,
} from "../../domain/entities/wallet-ledger-entry";
import {
  WalletBalanceChanged,
} from "../../domain/events/integration-event";
import { OutboxMessage } from "../../domain/entities/outbox-message";
import { WalletAlreadyExistsError } from "../errors/application-errors";
import {
  WalletOrmEntity,
  WagerTransactionOrmEntity,
  WalletLedgerEntryOrmEntity,
  OutboxMessageOrmEntity,
} from "../../infrastructure/database/entities";

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface OpenWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export class OpenWalletUseCase {
  constructor(private readonly em: EntityManager) {}

  async execute(command: OpenWalletCommand): Promise<OpenWalletResult> {
    const initialMoney = Money.from(command.initialBalance);

    return await this.em.transactional(async (txEm) => {
      // 1. Verificar unicidade (playerId + currency)
      const existing = await txEm.findOne(WalletOrmEntity, {
        playerId: command.playerId,
        currency: initialMoney.currency,
      });

      if (existing) {
        throw new WalletAlreadyExistsError(command.playerId, initialMoney.currency);
      }

      const walletId = uuidv7();
      const wallet = Wallet.open({
        id: walletId,
        playerId: command.playerId,
        initialBalance: initialMoney,
      });

      const walletOrm = txEm.create(WalletOrmEntity, {
        id: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        balance: wallet.balance.amount,
        version: wallet.version, // Inicia em 1
        createdAt: wallet.createdAt,
        updatedAt: wallet.updatedAt,
      });
      txEm.persist(walletOrm);

      // Se initialBalance > 0, gera transação OPENING e lançamento CREDIT no ledger na mesma transação SQL
      if (initialMoney.isPositive()) {
        const transactionId = uuidv7();
        const ledgerId = uuidv7();
        const zeroMoney = Money.zero(initialMoney.currency);

        const wagerTx = WagerTransaction.create({
          id: transactionId,
          providerId: "INTERNAL",
          externalTransactionId: `OPENING-${walletId}`,
          idempotencyKey: `INTERNAL:OPENING:${walletId}`,
          payloadHash: "INTERNAL_OPENING",
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: "OPENING",
          gameId: "SYSTEM",
          kind: WagerTransactionKind.Opening,
          money: initialMoney,
        });
        wagerTx.markProcessed(undefined, initialMoney, wallet.createdAt);

        const wagerTxOrm = txEm.create(WagerTransactionOrmEntity, {
          id: wagerTx.id,
          providerId: wagerTx.providerId,
          externalTransactionId: wagerTx.externalTransactionId,
          idempotencyKey: wagerTx.idempotencyKey,
          payloadHash: wagerTx.payloadHash,
          walletId: wagerTx.walletId,
          playerId: wagerTx.playerId,
          roundId: wagerTx.roundId,
          gameId: wagerTx.gameId,
          kind: wagerTx.kind,
          amount: wagerTx.money.amount,
          currency: wagerTx.money.currency,
          status: wagerTx.status,
          observedBalance: initialMoney.amount,
          observedBalanceCurrency: initialMoney.currency,
          createdAt: wagerTx.createdAt,
          processedAt: wagerTx.processedAt,
        });
        txEm.persist(wagerTxOrm);

        const ledgerEntry = WalletLedgerEntry.create({
          id: ledgerId,
          walletId: wallet.id,
          transactionId: wagerTx.id,
          direction: LedgerDirection.Credit,
          money: initialMoney,
          balanceBefore: zeroMoney,
          balanceAfter: initialMoney,
          createdAt: wallet.createdAt,
        });

        const ledgerOrm = txEm.create(WalletLedgerEntryOrmEntity, {
          id: ledgerEntry.id,
          walletId: ledgerEntry.walletId,
          transactionId: ledgerEntry.transactionId,
          direction: ledgerEntry.direction,
          amount: ledgerEntry.money.amount,
          currency: ledgerEntry.money.currency,
          balanceBefore: ledgerEntry.balanceBefore.amount,
          balanceAfter: ledgerEntry.balanceAfter.amount,
          createdAt: ledgerEntry.createdAt,
        });
        txEm.persist(ledgerOrm);

        // Outbox event
        const balanceChangedEvent = new WalletBalanceChanged({
          eventId: uuidv7(),
          aggregateId: wallet.id,
          correlationId: `OPENING-${wallet.id}`,
          occurredAt: wallet.createdAt,
          data: {
            walletId: wallet.id,
            transactionId: wagerTx.id,
            direction: ledgerEntry.direction,
            money: initialMoney.toJSON(),
            balanceBefore: zeroMoney.toJSON(),
            balanceAfter: initialMoney.toJSON(),
            walletVersion: wallet.version,
          },
        });

        const outboxMsg = OutboxMessage.enqueue(balanceChangedEvent);
        const outboxOrm = txEm.create(OutboxMessageOrmEntity, {
          id: outboxMsg.id,
          aggregateId: outboxMsg.aggregateId,
          eventType: outboxMsg.eventType,
          payload: outboxMsg.payload as Record<string, unknown>,
          occurredAt: outboxMsg.occurredAt,
          attempts: outboxMsg.attempts,
          nextAttemptAt: outboxMsg.nextAttemptAt,
        });
        txEm.persist(outboxOrm);
      }

      await txEm.flush();

      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    });
  }
}
