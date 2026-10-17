import { EntityManager, LockMode } from "@mikro-orm/postgresql";
import { v7 as uuidv7 } from "uuid";
import { Money, MoneyProps } from "../../domain/value-objects/money";
import { Wallet } from "../../domain/entities/wallet";
import {
  FailureCode,
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
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from "../../domain/events/integration-event";
import { OutboxMessage } from "../../domain/entities/outbox-message";
import {
  IdempotencyConflictError,
  WalletNotFoundError,
} from "../errors/application-errors";
import { computeCanonicalPayloadHash } from "../utils/canonical-json";
import {
  WalletOrmEntity,
  WagerTransactionOrmEntity,
  WalletLedgerEntryOrmEntity,
  InboxMessageOrmEntity,
  OutboxMessageOrmEntity,
} from "../../infrastructure/database/entities";

export interface ProcessWagerTransactionCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  inboxContext?: {
    consumerName: string;
    messageId: string;
  };
}

export interface ProcessWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}

export class ProcessWagerTransactionUseCase {
  constructor(private readonly em: EntityManager) { }

  async execute(command: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult> {
    // 0. Bloqueio estrito de OPENING submetido externamente
    if (command.kind === WagerTransactionKind.Opening) {
      throw new Error("OPENING transaction kind is internal and cannot be submitted via API or messaging.");
    }

    const inputMoney = Money.from(command.money);

    // 1. Calcular o payloadHash canônico a partir dos dados de negócio
    const canonicalBusinessPayload = {
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: {
        amount: inputMoney.amount,
        currency: inputMoney.currency,
      },
      referenceExternalTransactionId: command.referenceExternalTransactionId ?? null,
    };
    const payloadHash = computeCanonicalPayloadHash(canonicalBusinessPayload);

    return await this.em.transactional(async (txEm) => {
      // 2. Bloqueio pessimista por walletId PRIMEIRO (unidade fundamental de concorrência)
      const walletOrm = await txEm.findOne(
        WalletOrmEntity,
        { id: command.walletId },
        { lockMode: LockMode.PESSIMISTIC_WRITE }
      );

      if (!walletOrm) {
        throw new WalletNotFoundError(command.walletId);
      }

      // 3. Tratar Inbox se veio de fila SQS (Deduplicação de mensagens)
      if (command.inboxContext) {
        const existingInbox = await txEm.findOne(InboxMessageOrmEntity, {
          consumerName: command.inboxContext.consumerName,
          messageId: command.inboxContext.messageId,
        });

        if (existingInbox && existingInbox.processedAt) {
          const existingTx = await txEm.findOne(WagerTransactionOrmEntity, {
            providerId: command.providerId,
            idempotencyKey: command.idempotencyKey,
          });

          if (existingTx) {
            return {
              transactionId: existingTx.id,
              status: existingTx.status,
              balance: {
                amount: existingTx.observedBalance ?? walletOrm.balance,
                currency: existingTx.observedBalanceCurrency ?? inputMoney.currency,
              },
              idempotentReplay: true,
              failureCode: existingTx.failureCode,
            };
          }
        }

        if (!existingInbox) {
          const inboxEntry = txEm.create(InboxMessageOrmEntity, {
            messageId: command.inboxContext.messageId,
            consumerName: command.inboxContext.consumerName,
            payloadHash,
            receivedAt: new Date(),
            processedAt: new Date(),
          });
          txEm.persist(inboxEntry);
        } else {
          existingInbox.processedAt = new Date();
        }
      }

      // 4. Checar idempotência no banco por (providerId, idempotencyKey) sob o lock da wallet
      const existingTx = await txEm.findOne(WagerTransactionOrmEntity, {
        providerId: command.providerId,
        idempotencyKey: command.idempotencyKey,
      });

      if (existingTx) {
        if (existingTx.payloadHash !== payloadHash) {
          throw new IdempotencyConflictError(command.idempotencyKey);
        }

        // Replay idêntico: Retorna EXATAMENTE o saldo observado naquele momento (Regra 7, Seção 7)
        return {
          transactionId: existingTx.id,
          status: existingTx.status,
          balance: {
            amount: existingTx.observedBalance ?? walletOrm.balance,
            currency: existingTx.observedBalanceCurrency ?? inputMoney.currency,
          },
          idempotentReplay: true,
          failureCode: existingTx.failureCode,
        };
      }

      const wallet = Wallet.rehydrate({
        id: walletOrm.id,
        playerId: walletOrm.playerId,
        currency: walletOrm.currency,
        balance: Money.from({ amount: walletOrm.balance, currency: walletOrm.currency }),
        version: walletOrm.version,
        createdAt: walletOrm.createdAt,
        updatedAt: walletOrm.updatedAt,
      });

      // Validação de moeda
      if (inputMoney.currency !== wallet.currency) {
        return this.recordRejection(
          txEm,
          command,
          payloadHash,
          wallet,
          inputMoney,
          FailureCode.CurrencyMismatch,
          wallet.balance
        );
      }

      // Validação de jogador
      if (command.playerId !== wallet.playerId) {
        return this.recordRejection(
          txEm,
          command,
          payloadHash,
          wallet,
          inputMoney,
          FailureCode.InvalidPayload,
          wallet.balance
        );
      }

      // 5. Instanciar entidade de transação de domínio
      const transactionId = uuidv7();
      const wagerTx = WagerTransaction.create({
        id: transactionId,
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash,
        walletId: command.walletId,
        playerId: command.playerId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: command.kind,
        money: inputMoney,
        referenceExternalTransactionId: command.referenceExternalTransactionId,
      });

      // 6. Resolução de referências (REFUND, ROLLBACK)
      let referenceOrm: WagerTransactionOrmEntity | null = null;
      if (wagerTx.requiresReference()) {
        referenceOrm = await txEm.findOne(WagerTransactionOrmEntity, {
          providerId: command.providerId,
          externalTransactionId: command.referenceExternalTransactionId!,
        });

        if (!referenceOrm || referenceOrm.status !== WagerTransactionStatus.Processed) {
          // Referência não existe ou ainda não foi processada -> PENDING_REFERENCE
          wagerTx.markPendingReference();

          const txOrm = txEm.create(WagerTransactionOrmEntity, {
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
            referenceExternalTransactionId: wagerTx.referenceExternalTransactionId,
            status: wagerTx.status,
            observedBalance: wallet.balance.amount,
            observedBalanceCurrency: wallet.balance.currency,
            createdAt: wagerTx.createdAt,
          });
          txEm.persist(txOrm);

          // Evento de integração
          const pendingRefEvent = new WagerTransactionPendingReference({
            eventId: uuidv7(),
            aggregateId: wallet.id,
            correlationId: wagerTx.idempotencyKey,
            occurredAt: wagerTx.createdAt,
            data: {
              transactionId: wagerTx.id,
              providerId: wagerTx.providerId,
              externalTransactionId: wagerTx.externalTransactionId,
              referenceExternalTransactionId: command.referenceExternalTransactionId!,
              walletId: wallet.id,
              playerId: wallet.playerId,
              roundId: wagerTx.roundId,
              gameId: wagerTx.gameId,
              kind: wagerTx.kind,
              money: inputMoney.toJSON(),
            },
          });

          this.enqueueOutbox(txEm, pendingRefEvent);
          await txEm.flush();

          return {
            transactionId: wagerTx.id,
            status: wagerTx.status,
            balance: wallet.balance.toJSON(),
            idempotentReplay: false,
          };
        }

        // Validação cruzada estrita da referência (Regra 2, Seção 7)
        if (
          referenceOrm.providerId !== command.providerId ||
          referenceOrm.playerId !== command.playerId ||
          referenceOrm.walletId !== command.walletId ||
          referenceOrm.currency !== inputMoney.currency ||
          referenceOrm.roundId !== command.roundId
        ) {
          return this.recordRejection(
            txEm,
            command,
            payloadHash,
            wallet,
            inputMoney,
            FailureCode.ReferenceMismatch,
            wallet.balance
          );
        }

        // Validação de valor idêntico (Regra 5, Seção 7)
        if (referenceOrm.amount !== inputMoney.amount) {
          return this.recordRejection(
            txEm,
            command,
            payloadHash,
            wallet,
            inputMoney,
            FailureCode.ReferenceMismatch,
            wallet.balance
          );
        }

        // Matriz de tipos permitidos na referência (Regra 3, Seção 7)
        if (command.kind === WagerTransactionKind.Refund) {
          if (referenceOrm.kind !== WagerTransactionKind.Bet) {
            return this.recordRejection(
              txEm,
              command,
              payloadHash,
              wallet,
              inputMoney,
              FailureCode.InvalidReferenceType,
              wallet.balance
            );
          }
        } else if (command.kind === WagerTransactionKind.Rollback) {
          const allowedForRollback = [
            WagerTransactionKind.Bet,
            WagerTransactionKind.Win,
            WagerTransactionKind.Refund,
          ];
          if (!allowedForRollback.includes(referenceOrm.kind)) {
            return this.recordRejection(
              txEm,
              command,
              payloadHash,
              wallet,
              inputMoney,
              FailureCode.InvalidReferenceType,
              wallet.balance
            );
          }
        }

        // Prevenção de dupla reversão pelo mesmo tipo (Regra 4, Seção 7)
        const existingReversal = await txEm.findOne(WagerTransactionOrmEntity, {
          referenceTransactionId: referenceOrm.id,
          kind: command.kind,
          status: WagerTransactionStatus.Processed,
        });

        if (existingReversal) {
          return this.recordRejection(
            txEm,
            command,
            payloadHash,
            wallet,
            inputMoney,
            FailureCode.DuplicateReversal,
            wallet.balance
          );
        }
      }

      // 7. Processar movimentação financeira por Kind
      let balanceBefore = wallet.balance;
      let balanceAfter = wallet.balance;
      let direction: LedgerDirection | null = null;

      try {
        if (command.kind === WagerTransactionKind.Bet) {
          direction = LedgerDirection.Debit;
          const movement = wallet.debit(inputMoney);
          balanceBefore = movement.balanceBefore;
          balanceAfter = movement.balanceAfter;
        } else if (command.kind === WagerTransactionKind.Win) {
          direction = LedgerDirection.Credit;
          const movement = wallet.credit(inputMoney);
          balanceBefore = movement.balanceBefore;
          balanceAfter = movement.balanceAfter;
        } else if (command.kind === WagerTransactionKind.Loss) {
          // LOSS não move saldo, não altera version e não gera ledger
          direction = null;
        } else if (command.kind === WagerTransactionKind.Refund) {
          // REFUND reverte BET -> gera crédito
          direction = LedgerDirection.Credit;
          const movement = wallet.credit(inputMoney);
          balanceBefore = movement.balanceBefore;
          balanceAfter = movement.balanceAfter;
        } else if (command.kind === WagerTransactionKind.Rollback) {
          // ROLLBACK inverte a operação referenciada
          const isRefCredit =
            referenceOrm?.kind === WagerTransactionKind.Win ||
            referenceOrm?.kind === WagerTransactionKind.Opening ||
            referenceOrm?.kind === WagerTransactionKind.Refund;

          if (isRefCredit) {
            // Reverter crédito exige débito do saldo
            direction = LedgerDirection.Debit;
            if (wallet.balance.isLessThan(inputMoney)) {
              return this.recordRejection(
                txEm,
                command,
                payloadHash,
                wallet,
                inputMoney,
                FailureCode.ReversalInsufficientFunds,
                wallet.balance
              );
            }
            const movement = wallet.debit(inputMoney);
            balanceBefore = movement.balanceBefore;
            balanceAfter = movement.balanceAfter;
          } else {
            // Referência era BET (débito) -> reverte com crédito
            direction = LedgerDirection.Credit;
            const movement = wallet.credit(inputMoney);
            balanceBefore = movement.balanceBefore;
            balanceAfter = movement.balanceAfter;
          }
        }
      } catch (error) {
        // Exceção de saldo insuficiente ao apostar
        return this.recordRejection(
          txEm,
          command,
          payloadHash,
          wallet,
          inputMoney,
          FailureCode.InsufficientFunds,
          wallet.balance
        );
      }

      // 8. Atualizar entidade WagerTransaction para PROCESSED com o observedBalance registrado
      wagerTx.markProcessed(referenceOrm?.id, wallet.balance);

      const txOrm = txEm.create(WagerTransactionOrmEntity, {
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
        referenceExternalTransactionId: wagerTx.referenceExternalTransactionId,
        referenceTransactionId: wagerTx.referenceTransactionId,
        status: wagerTx.status,
        observedBalance: wallet.balance.amount,
        observedBalanceCurrency: wallet.balance.currency,
        createdAt: wagerTx.createdAt,
        processedAt: wagerTx.processedAt,
      });
      txEm.persist(txOrm);

      // 9. Atualizar a linha da Wallet no banco somente se houve alteração de saldo
      if (direction !== null) {
        walletOrm.balance = wallet.balance.amount;
        walletOrm.version = wallet.version;
        walletOrm.updatedAt = wallet.updatedAt;

        // 10. Lançamento do Ledger imutável
        const ledgerEntry = WalletLedgerEntry.create({
          id: uuidv7(),
          walletId: wallet.id,
          transactionId: wagerTx.id,
          direction,
          money: inputMoney,
          balanceBefore,
          balanceAfter,
          createdAt: wagerTx.processedAt,
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

        // Outbox: WalletBalanceChanged
        const balanceChangedEvent = new WalletBalanceChanged({
          eventId: uuidv7(),
          aggregateId: wallet.id,
          correlationId: wagerTx.idempotencyKey,
          occurredAt: wagerTx.processedAt,
          data: {
            walletId: wallet.id,
            transactionId: wagerTx.id,
            direction,
            money: inputMoney.toJSON(),
            balanceBefore: balanceBefore.toJSON(),
            balanceAfter: balanceAfter.toJSON(),
            walletVersion: wallet.version,
          },
        });
        this.enqueueOutbox(txEm, balanceChangedEvent);
      }

      // Outbox: WagerTransactionProcessed (emitido para qualquer transação aplicada, inclusive LOSS)
      const txProcessedEvent = new WagerTransactionProcessed({
        eventId: uuidv7(),
        aggregateId: wallet.id,
        correlationId: wagerTx.idempotencyKey,
        occurredAt: wagerTx.processedAt,
        data: {
          transactionId: wagerTx.id,
          providerId: wagerTx.providerId,
          externalTransactionId: wagerTx.externalTransactionId,
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: wagerTx.roundId,
          gameId: wagerTx.gameId,
          kind: wagerTx.kind,
          money: inputMoney.toJSON(),
          referenceExternalTransactionId: wagerTx.referenceExternalTransactionId,
          referenceTransactionId: wagerTx.referenceTransactionId,
          balanceAfter: wallet.balance.toJSON(),
        },
      });
      this.enqueueOutbox(txEm, txProcessedEvent);

      await txEm.flush();

      return {
        transactionId: wagerTx.id,
        status: wagerTx.status,
        balance: wallet.balance.toJSON(),
        idempotentReplay: false,
      };
    });
  }

  private async recordRejection(
    txEm: EntityManager,
    command: ProcessWagerTransactionCommand,
    payloadHash: string,
    wallet: Wallet,
    money: Money,
    failureCode: FailureCode,
    observedBalance: Money
  ): Promise<ProcessWagerTransactionResult> {
    const transactionId = uuidv7();
    const wagerTx = WagerTransaction.create({
      id: transactionId,
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
    });

    wagerTx.reject(failureCode, observedBalance);

    const txOrm = txEm.create(WagerTransactionOrmEntity, {
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
      referenceExternalTransactionId: wagerTx.referenceExternalTransactionId,
      status: wagerTx.status,
      failureCode: wagerTx.failureCode,
      observedBalance: observedBalance.amount,
      observedBalanceCurrency: observedBalance.currency,
      createdAt: wagerTx.createdAt,
      processedAt: wagerTx.processedAt,
    });
    txEm.persist(txOrm);

    // Evento WagerTransactionRejected
    const rejectedEvent = new WagerTransactionRejected({
      eventId: uuidv7(),
      aggregateId: wallet.id,
      correlationId: wagerTx.idempotencyKey,
      occurredAt: wagerTx.processedAt,
      data: {
        transactionId: wagerTx.id,
        providerId: wagerTx.providerId,
        externalTransactionId: wagerTx.externalTransactionId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: wagerTx.roundId,
        gameId: wagerTx.gameId,
        kind: wagerTx.kind,
        money: money.toJSON(),
        failureCode,
      },
    });
    this.enqueueOutbox(txEm, rejectedEvent);

    await txEm.flush();

    return {
      transactionId: wagerTx.id,
      status: wagerTx.status,
      balance: observedBalance.toJSON(),
      idempotentReplay: false,
      failureCode,
    };
  }

  private enqueueOutbox(txEm: EntityManager, event: any): void {
    const outboxMsg = OutboxMessage.enqueue(event);
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
}
