import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { EntityManager, LockMode } from "@mikro-orm/postgresql";
import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { OutboxMessage } from "../../domain/entities/outbox-message";
import { OutboxMessageOrmEntity } from "../database/entities/outbox-message.orm-entity";
import { logFinancialEvent, logger } from "../observability/app-logger";
import { MetricsService } from "../observability/metrics.service";

type PublishResult =
  | { id: string; aggregateId: string; success: true; publishedAt: Date }
  | { id: string; success: false; domainMsg: OutboxMessage };

@Injectable()
export class OutboxPublisherWorker implements OnModuleInit, OnModuleDestroy {
  private isRunning = false;
  private isShuttingDown = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private inFlightPromise: Promise<void> | null = null;

  constructor(
    private readonly em: EntityManager,
    private readonly sqsClient: SQSClient,
    @Optional() private readonly metricsService?: MetricsService
  ) {}

  onModuleInit(): void {
    const raw = process.env.OUTBOX_POLL_INTERVAL_MS;
    const intervalMs = raw !== undefined ? Number(raw) : 1000;
    if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
      throw new Error(`Invalid OUTBOX_POLL_INTERVAL_MS: "${raw}". Must be a positive integer.`);
    }

    this.pollTimer = setInterval(() => {
      void this.handleOutboxPublishing();
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

  async handleOutboxPublishing(): Promise<void> {
    if (this.isRunning || this.isShuttingDown) return;
    this.isRunning = true;

    const run = (async () => {
      try {
        // Fase 1 (tx curta): Claim com FOR UPDATE SKIP LOCKED e lease de 30s
        const claimed = await this.em.transactional(async (txEm) => {
          if (this.metricsService && typeof txEm.count === "function") {
            const unpublishedCount = await txEm.count(OutboxMessageOrmEntity, {
              publishedAt: null,
            });
            this.metricsService.outboxLagGauge.set(unpublishedCount);
          }

          const now = new Date();
          const dueMessagesOrm = await txEm
            .createQueryBuilder(OutboxMessageOrmEntity, "o")
            .where({
              publishedAt: null,
            })
            .andWhere("(o.next_attempt_at IS NULL OR o.next_attempt_at <= ?)", [now])
            .orderBy({ occurredAt: "ASC" })
            .limit(20)
            .setLockMode(LockMode.PESSIMISTIC_PARTIAL_WRITE)
            .getResultList();

          if (dueMessagesOrm.length === 0) return [];

          const leaseUntil = new Date(now.getTime() + 30_000);
          for (const msgOrm of dueMessagesOrm) {
            msgOrm.nextAttemptAt = leaseUntil;
          }
          await txEm.flush();

          return dueMessagesOrm.map((msgOrm) =>
            OutboxMessage.rehydrate({
              id: msgOrm.id,
              aggregateId: msgOrm.aggregateId,
              eventType: msgOrm.eventType,
              payload: msgOrm.payload,
              occurredAt: msgOrm.occurredAt,
              attempts: msgOrm.attempts,
              nextAttemptAt: msgOrm.nextAttemptAt,
              publishedAt: msgOrm.publishedAt,
            })
          );
        });

        if (claimed.length === 0) return;

        // Fase 2 (sem tx de BD): Publicação no SQS fora de locks de banco
        const queueUrl =
          process.env.SQS_OUTBOX_QUEUE_URL ||
          "http://localhost:4566/000000000000/wager-events.fifo";

        const results: PublishResult[] = [];
        for (const domainMsg of claimed) {
          try {
            await this.sqsClient.send(
              new SendMessageCommand({
                QueueUrl: queueUrl,
                MessageBody: JSON.stringify(domainMsg.payload),
                MessageGroupId: domainMsg.aggregateId,
                MessageDeduplicationId: domainMsg.id,
              })
            );
            results.push({
              id: domainMsg.id,
              aggregateId: domainMsg.aggregateId,
              success: true,
              publishedAt: new Date(),
            });
          } catch (err) {
            logger.error(
              `Erro ao publicar outbox message ${domainMsg.id}: ${(err as Error).message}`
            );
            results.push({ id: domainMsg.id, success: false, domainMsg });
          }
        }

        // Fase 3 (tx curta): Finalização dos registros reivindicados por ID
        await this.em.transactional(async (txEm) => {
          const ids = results.map((r) => r.id);
          const rows = await txEm.find(OutboxMessageOrmEntity, { id: { $in: ids } });
          const rowsById = new Map(rows.map((row) => [row.id, row]));

          for (const result of results) {
            const msgOrm = rowsById.get(result.id);
            if (!msgOrm) continue;

            if (result.success) {
              msgOrm.publishedAt = result.publishedAt;
              msgOrm.nextAttemptAt = undefined;
              logFinancialEvent({
                event: "OutboxMessagePublished",
                walletId: result.aggregateId,
                messageId: result.id,
                status: "PUBLISHED",
              });
            } else {
              result.domainMsg.scheduleRetry();
              msgOrm.attempts = result.domainMsg.attempts;
              msgOrm.nextAttemptAt = result.domainMsg.nextAttemptAt;
              this.metricsService?.messageRetriesTotal.inc({
                worker_name: "OutboxPublisherWorker",
              });
              logFinancialEvent({
                event: "OutboxPublishRetryScheduled",
                walletId: result.domainMsg.aggregateId,
                messageId: result.id,
                status: "RETRY_SCHEDULED",
              });
            }
          }

          await txEm.flush();
          if (this.metricsService && typeof txEm.count === "function") {
            const remainingCount = await txEm.count(OutboxMessageOrmEntity, {
              publishedAt: null,
            });
            this.metricsService.outboxLagGauge.set(remainingCount);
          }
        });
      } catch (error) {
        logger.error(`Erro no processamento da outbox: ${(error as Error).message}`);
      } finally {
        this.isRunning = false;
        this.inFlightPromise = null;
      }
    })();

    this.inFlightPromise = run;
    await run;
  }
}
