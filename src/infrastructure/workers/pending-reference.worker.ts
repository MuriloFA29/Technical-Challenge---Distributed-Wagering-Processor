import { EntityManager, LockMode } from "@mikro-orm/postgresql";
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { v7 as uuidv7 } from "uuid";
import { OutboxMessage } from "../../domain/entities/outbox-message";
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/entities/wager-transaction";
import { Wallet } from "../../domain/entities/wallet";
import { LedgerDirection, WalletLedgerEntry } from "../../domain/entities/wallet-ledger-entry";
import {
  IntegrationEvent,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../../domain/events/integration-event";
import { Money } from "../../domain/value-objects/money";
import {
  OutboxMessageOrmEntity,
  WagerTransactionOrmEntity,
  WalletLedgerEntryOrmEntity,
  WalletOrmEntity,
} from "../database/entities";

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private isRunning = false;
  private isShuttingDown = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private inFlightPromise: Promise<void> | null = null;

  constructor(private readonly em: EntityManager) {}

  onModuleInit(): void {
    const raw = process.env.PENDING_REFERENCE_POLL_INTERVAL_MS;
    const intervalMs = raw !== undefined ? Number(raw) : 3000;
    if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
      throw new Error(
        `Invalid PENDING_REFERENCE_POLL_INTERVAL_MS: "${raw}". Must be a positive integer.`
      );
    }

    this.pollTimer = setInterval(() => {
      void this.handlePendingReferences();
    }, intervalMs);
  }

  async onModuleDestroy(): Promise<void> {
    this.isShuttingDown = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.inFlightPromise) {
      await this.inFlightPromise;
    }
  }

  async handlePendingReferences(): Promise<void> {
    if (this.isRunning || this.isShuttingDown) return;
    this.isRunning = true;

    const run = (async () => {
      try {
        // Fase 1 (tx curta): Selecionar candidatos com FOR UPDATE SKIP LOCKED
        const candidates = await this.em.transactional(async (txEm) => {
          return await txEm
            .createQueryBuilder(WagerTransactionOrmEntity, "t")
            .where({ status: WagerTransactionStatus.PendingReference })
            .orderBy({ createdAt: "ASC" })
            .limit(20)
            .setLockMode(LockMode.PESSIMISTIC_PARTIAL_WRITE)
            .getResultList();
        });

        if (candidates.length === 0) return;

        const maxAgeMs = 5 * 60 * 1000; // TTL: 5 minutos

        // Fase 2: Processar cada candidato in-place sob lock da wallet
        for (const candidate of candidates) {
          try {
            await this.em.transactional(async (txEm) => {
              if (typeof txEm.getConnection === "function") {
                await txEm.getConnection().execute("SET LOCAL lock_timeout = '5000ms'");
              }

              // Lock da wallet PRIMEIRO (mesma ordem do ProcessWagerTransactionUseCase)
              const walletOrm = await txEm.findOne(
                WalletOrmEntity,
                { id: candidate.walletId },
                { lockMode: LockMode.PESSIMISTIC_WRITE }
              );
              if (!walletOrm) return;

              // Re-buscar e travar a transação pendente
              const txOrm = await txEm.findOne(
                WagerTransactionOrmEntity,
                { id: candidate.id },
                { lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE }
              );
              if (!txOrm || txOrm.status !== WagerTransactionStatus.PendingReference) return;

              const now = new Date();

              // Buscar transação referenciada
              const referenceOrm = txOrm.referenceExternalTransactionId
                ? await txEm.findOne(WagerTransactionOrmEntity, {
                    providerId: txOrm.providerId,
                    externalTransactionId: txOrm.referenceExternalTransactionId,
                  })
                : null;

              // Fast-reject: referência já existe em estado terminal de falha/rejeição
              if (
                referenceOrm &&
                (referenceOrm.status === WagerTransactionStatus.Rejected ||
                  referenceOrm.status === WagerTransactionStatus.Failed)
              ) {
                this.rejectInPlace(txEm, txOrm, walletOrm, FailureCode.ReferenceNotFound, now);
                await txEm.flush();
                this.logger.warn(
                  `Transação ${txOrm.id} rejeitada in-place: referência ${referenceOrm.id} está em estado ${referenceOrm.status}.`
                );
                return;
              }

              // Verificar TTL se referência ainda não chegou ou não está PROCESSED
              if (!referenceOrm || referenceOrm.status !== WagerTransactionStatus.Processed) {
                const ageMs = now.getTime() - txOrm.createdAt.getTime();
                if (ageMs > maxAgeMs) {
                  this.rejectInPlace(txEm, txOrm, walletOrm, FailureCode.ReferenceNotFound, now);
                  await txEm.flush();
                  this.logger.warn(
                    `Transação ${txOrm.id} expirou o TTL aguardando referência e foi rejeitada in-place.`
                  );
                }
                return;
              }

              // Referência PROCESSED encontrada: executar validações idênticas ao ProcessWagerTransactionUseCase
              // 1. Validação cruzada estrita da referência
              if (
                referenceOrm.providerId !== txOrm.providerId ||
                referenceOrm.playerId !== txOrm.playerId ||
                referenceOrm.walletId !== txOrm.walletId ||
                referenceOrm.currency !== txOrm.currency ||
                referenceOrm.roundId !== txOrm.roundId
              ) {
                this.rejectInPlace(txEm, txOrm, walletOrm, FailureCode.ReferenceMismatch, now);
                await txEm.flush();
                return;
              }

              // 2. Validação de valor idêntico
              if (referenceOrm.amount !== txOrm.amount) {
                this.rejectInPlace(txEm, txOrm, walletOrm, FailureCode.ReferenceMismatch, now);
                await txEm.flush();
                return;
              }

              // 3. Matriz de tipos permitidos na referência
              if (txOrm.kind === WagerTransactionKind.Refund) {
                if (referenceOrm.kind !== WagerTransactionKind.Bet) {
                  this.rejectInPlace(txEm, txOrm, walletOrm, FailureCode.InvalidReferenceType, now);
                  await txEm.flush();
                  return;
                }
              } else if (txOrm.kind === WagerTransactionKind.Rollback) {
                const allowedForRollback = [
                  WagerTransactionKind.Bet,
                  WagerTransactionKind.Win,
                  WagerTransactionKind.Refund,
                ];
                if (!allowedForRollback.includes(referenceOrm.kind)) {
                  this.rejectInPlace(txEm, txOrm, walletOrm, FailureCode.InvalidReferenceType, now);
                  await txEm.flush();
                  return;
                }
              }

              // 4. Prevenção de dupla reversão pelo mesmo tipo
              const existingReversal = await txEm.findOne(WagerTransactionOrmEntity, {
                referenceTransactionId: referenceOrm.id,
                kind: txOrm.kind,
                status: WagerTransactionStatus.Processed,
              });
              if (existingReversal) {
                this.rejectInPlace(txEm, txOrm, walletOrm, FailureCode.DuplicateReversal, now);
                await txEm.flush();
                return;
              }

              // 5. Aplicar movimentação financeira na Wallet
              const wallet = Wallet.rehydrate({
                id: walletOrm.id,
                playerId: walletOrm.playerId,
                currency: walletOrm.currency,
                balance: Money.from({ amount: walletOrm.balance, currency: walletOrm.currency }),
                version: walletOrm.version,
                createdAt: walletOrm.createdAt,
                updatedAt: walletOrm.updatedAt,
              });
              const inputMoney = Money.from({ amount: txOrm.amount, currency: txOrm.currency });

              let direction: LedgerDirection;
              let balanceBefore: Money;
              let balanceAfter: Money;

              if (txOrm.kind === WagerTransactionKind.Refund) {
                direction = LedgerDirection.Credit;
                const movement = wallet.credit(inputMoney);
                balanceBefore = movement.balanceBefore;
                balanceAfter = movement.balanceAfter;
              } else {
                // ROLLBACK
                const isRefCredit =
                  referenceOrm.kind === WagerTransactionKind.Win ||
                  referenceOrm.kind === WagerTransactionKind.Opening ||
                  referenceOrm.kind === WagerTransactionKind.Refund;

                if (isRefCredit) {
                  if (wallet.balance.isLessThan(inputMoney)) {
                    this.rejectInPlace(
                      txEm,
                      txOrm,
                      walletOrm,
                      FailureCode.ReversalInsufficientFunds,
                      now
                    );
                    await txEm.flush();
                    return;
                  }
                  direction = LedgerDirection.Debit;
                  const movement = wallet.debit(inputMoney);
                  balanceBefore = movement.balanceBefore;
                  balanceAfter = movement.balanceAfter;
                } else {
                  direction = LedgerDirection.Credit;
                  const movement = wallet.credit(inputMoney);
                  balanceBefore = movement.balanceBefore;
                  balanceAfter = movement.balanceAfter;
                }
              }

              // 6. Atualizar transação in-place para PROCESSED (preservando txOrm.id)
              txOrm.status = WagerTransactionStatus.Processed;
              txOrm.referenceTransactionId = referenceOrm.id;
              txOrm.observedBalance = wallet.balance.amount;
              txOrm.observedBalanceCurrency = wallet.balance.currency;
              txOrm.processedAt = now;

              // 7. Atualizar Wallet
              walletOrm.balance = wallet.balance.amount;
              walletOrm.version = wallet.version;
              walletOrm.updatedAt = wallet.updatedAt;

              // 8. Lançamento do Ledger imutável
              const ledgerEntry = WalletLedgerEntry.create({
                id: uuidv7(),
                walletId: wallet.id,
                transactionId: txOrm.id,
                direction,
                money: inputMoney,
                balanceBefore,
                balanceAfter,
                createdAt: now,
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

              // 9. Enfileirar eventos de Outbox
              const balanceChangedEvent = new WalletBalanceChanged({
                eventId: uuidv7(),
                aggregateId: wallet.id,
                correlationId: txOrm.idempotencyKey,
                occurredAt: now,
                data: {
                  walletId: wallet.id,
                  transactionId: txOrm.id,
                  direction,
                  money: inputMoney.toJSON(),
                  balanceBefore: balanceBefore.toJSON(),
                  balanceAfter: balanceAfter.toJSON(),
                  walletVersion: wallet.version,
                },
              });
              this.enqueueOutbox(txEm, balanceChangedEvent);

              const txProcessedEvent = new WagerTransactionProcessed({
                eventId: uuidv7(),
                aggregateId: wallet.id,
                correlationId: txOrm.idempotencyKey,
                occurredAt: now,
                data: {
                  transactionId: txOrm.id,
                  providerId: txOrm.providerId,
                  externalTransactionId: txOrm.externalTransactionId,
                  walletId: wallet.id,
                  playerId: wallet.playerId,
                  roundId: txOrm.roundId,
                  gameId: txOrm.gameId,
                  kind: txOrm.kind,
                  money: inputMoney.toJSON(),
                  referenceExternalTransactionId: txOrm.referenceExternalTransactionId,
                  referenceTransactionId: referenceOrm.id,
                  balanceAfter: wallet.balance.toJSON(),
                },
              });
              this.enqueueOutbox(txEm, txProcessedEvent);

              await txEm.flush();
              this.logger.log(
                `Transação fora de ordem ${txOrm.id} resolvida in-place com sucesso.`
              );
            });
          } catch (candidateErr) {
            this.logger.error(
              `Erro ao processar transação pendente ${candidate.id}: ${(candidateErr as Error).message}`
            );
          }
        }
      } catch (err) {
        this.logger.error(`Erro ao reprocessar referências pendentes: ${(err as Error).message}`);
      } finally {
        this.isRunning = false;
        this.inFlightPromise = null;
      }
    })();

    this.inFlightPromise = run;
    await run;
  }

  private rejectInPlace(
    txEm: EntityManager,
    txOrm: WagerTransactionOrmEntity,
    walletOrm: WalletOrmEntity,
    failureCode: FailureCode,
    now: Date
  ): void {
    txOrm.status = WagerTransactionStatus.Rejected;
    txOrm.failureCode = failureCode;
    txOrm.observedBalance = walletOrm.balance;
    txOrm.observedBalanceCurrency = walletOrm.currency;
    txOrm.processedAt = now;

    const rejectedEvent = new WagerTransactionRejected({
      eventId: uuidv7(),
      aggregateId: txOrm.walletId,
      correlationId: txOrm.idempotencyKey,
      occurredAt: now,
      data: {
        transactionId: txOrm.id,
        providerId: txOrm.providerId,
        externalTransactionId: txOrm.externalTransactionId,
        walletId: txOrm.walletId,
        playerId: txOrm.playerId,
        roundId: txOrm.roundId,
        gameId: txOrm.gameId,
        kind: txOrm.kind,
        money: { amount: txOrm.amount, currency: txOrm.currency },
        failureCode,
      },
    });
    this.enqueueOutbox(txEm, rejectedEvent);
  }

  private enqueueOutbox(txEm: EntityManager, event: IntegrationEvent<unknown>): void {
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
