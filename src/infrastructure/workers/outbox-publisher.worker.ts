import { Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { EntityManager } from "@mikro-orm/postgresql";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { OutboxMessageOrmEntity } from "../database/entities/outbox-message.orm-entity";
import { OutboxMessage } from "../../domain/entities/outbox-message";

@Injectable()
export class OutboxPublisherWorker {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private isRunning = false;

  constructor(
    private readonly em: EntityManager,
    private readonly sqsClient: SQSClient
  ) {}

  @Interval(1000)
  async handleOutboxPublishing(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      await this.em.transactional(async (txEm) => {
        const queueUrl =
          process.env.SQS_QUEUE_URL ||
          "http://localhost:4566/000000000000/wager-transactions.fifo";

        const now = new Date();

        // Query com SKIP LOCKED: seguro para múltiplas instâncias concorrentes
        const dueMessagesOrm = await txEm
          .createQueryBuilder(OutboxMessageOrmEntity, "o")
          .where({
            publishedAt: null,
          })
          .andWhere(
            "(o.next_attempt_at IS NULL OR o.next_attempt_at <= ?)",
            [now]
          )
          .orderBy({ occurredAt: "ASC" })
          .limit(20)
          .getResultList();

        if (dueMessagesOrm.length === 0) return;

        for (const msgOrm of dueMessagesOrm) {
          const domainMsg = OutboxMessage.rehydrate({
            id: msgOrm.id,
            aggregateId: msgOrm.aggregateId,
            eventType: msgOrm.eventType,
            payload: msgOrm.payload,
            occurredAt: msgOrm.occurredAt,
            attempts: msgOrm.attempts,
            nextAttemptAt: msgOrm.nextAttemptAt,
            publishedAt: msgOrm.publishedAt,
          });

          try {
            await this.sqsClient.send(
              new SendMessageCommand({
                QueueUrl: queueUrl,
                MessageBody: JSON.stringify(domainMsg.payload),
                MessageGroupId: domainMsg.aggregateId,
                MessageDeduplicationId: domainMsg.id,
              })
            );

            domainMsg.markPublished();
            msgOrm.publishedAt = domainMsg.publishedAt;
            msgOrm.nextAttemptAt = undefined;
          } catch (err) {
            this.logger.error(
              `Erro ao publicar outbox message ${domainMsg.id}: ${(err as Error).message}`
            );
            domainMsg.scheduleRetry();
            msgOrm.attempts = domainMsg.attempts;
            msgOrm.nextAttemptAt = domainMsg.nextAttemptAt;
          }
        }

        await txEm.flush();
      });
    } catch (error) {
      this.logger.error(
        `Erro no processamento da outbox: ${(error as Error).message}`
      );
    } finally {
      this.isRunning = false;
    }
  }
}
