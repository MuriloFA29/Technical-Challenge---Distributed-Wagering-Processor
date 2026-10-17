import { Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { EntityManager } from "@mikro-orm/postgresql";
import {
  WagerTransactionOrmEntity,
  WalletOrmEntity,
  OutboxMessageOrmEntity,
} from "../database/entities";
import {
  FailureCode,
  WagerTransactionStatus,
  WagerTransactionKind,
} from "../../domain/entities/wager-transaction";
import { ProcessWagerTransactionUseCase } from "../../application/use-cases/process-wager-transaction.use-case";
import { WagerTransactionRejected } from "../../domain/events/integration-event";
import { OutboxMessage } from "../../domain/entities/outbox-message";
import { v7 as uuidv7 } from "uuid";

@Injectable()
export class PendingReferenceWorker {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private isRunning = false;

  constructor(
    private readonly em: EntityManager,
    private readonly processWagerTxUseCase: ProcessWagerTransactionUseCase
  ) {}

  @Interval(3000)
  async handlePendingReferences(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const pendingTxs = await this.em.find(
        WagerTransactionOrmEntity,
        { status: WagerTransactionStatus.PendingReference },
        { limit: 20, orderBy: { createdAt: "ASC" } }
      );

      if (pendingTxs.length === 0) return;

      const now = new Date();
      const maxAgeMs = 5 * 60 * 1000; // TTL: 5 minutos

      for (const tx of pendingTxs) {
        const ageMs = now.getTime() - tx.createdAt.getTime();

        // 1. Verificar se expirou o TTL
        if (ageMs > maxAgeMs) {
          await this.em.transactional(async (txEm) => {
            const freshTx = await txEm.findOne(WagerTransactionOrmEntity, { id: tx.id });
            if (!freshTx || freshTx.status !== WagerTransactionStatus.PendingReference) return;

            freshTx.status = WagerTransactionStatus.Rejected;
            freshTx.failureCode = FailureCode.ReferenceNotFound;
            freshTx.processedAt = now;

            // Outbox event
            const rejectedEvent = new WagerTransactionRejected({
              eventId: uuidv7(),
              aggregateId: freshTx.walletId,
              correlationId: freshTx.idempotencyKey,
              occurredAt: now,
              data: {
                transactionId: freshTx.id,
                providerId: freshTx.providerId,
                externalTransactionId: freshTx.externalTransactionId,
                walletId: freshTx.walletId,
                playerId: freshTx.playerId,
                roundId: freshTx.roundId,
                gameId: freshTx.gameId,
                kind: freshTx.kind,
                money: { amount: freshTx.amount, currency: freshTx.currency },
                failureCode: FailureCode.ReferenceNotFound,
              },
            });

            const outboxMsg = OutboxMessage.enqueue(rejectedEvent);
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

            await txEm.flush();
            this.logger.warn(`Transação ${freshTx.id} expirou o TTL aguardando referência e foi rejeitada.`);
          });
          continue;
        }

        // 2. Verificar se a referência chegou
        const reference = await this.em.findOne(WagerTransactionOrmEntity, {
          providerId: tx.providerId,
          externalTransactionId: tx.referenceExternalTransactionId!,
          status: WagerTransactionStatus.Processed,
        });

        if (reference) {
          // A referência agora existe! Deletamos o registro pending_reference para que o usecase processe novamente de forma limpa
          await this.em.transactional(async (txEm) => {
            const pendingRecord = await txEm.findOne(WagerTransactionOrmEntity, { id: tx.id });
            if (pendingRecord) {
              await txEm.removeAndFlush(pendingRecord);
            }
          });

          await this.processWagerTxUseCase.execute({
            providerId: tx.providerId,
            externalTransactionId: tx.externalTransactionId,
            idempotencyKey: tx.idempotencyKey,
            playerId: tx.playerId,
            walletId: tx.walletId,
            roundId: tx.roundId,
            gameId: tx.gameId,
            kind: tx.kind,
            money: { amount: tx.amount, currency: tx.currency },
            referenceExternalTransactionId: tx.referenceExternalTransactionId,
          });

          this.logger.log(`Transação fora de ordem ${tx.id} reprocessada com sucesso após chegada da referência.`);
        }
      }
    } catch (err) {
      this.logger.error(`Erro ao reprocessar referências pendentes: ${(err as Error).message}`);
    } finally {
      this.isRunning = false;
    }
  }
}
