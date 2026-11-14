import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { ApplicationError } from "../../application/errors/application-errors";
import { ProcessWagerTransactionUseCase } from "../../application/use-cases/process-wager-transaction.use-case";
import { DomainError } from "../../domain/errors/domain-errors";
import { logFinancialEvent, logger } from "../observability/app-logger";
import { MetricsService } from "../observability/metrics.service";

const BUSINESS_ERROR_NAMES = new Set([
  "SyntaxError",
  "InvalidMoneyError",
  "CurrencyMismatchError",
  "InsufficientFundsError",
  "InvalidTransactionStateError",
  "UnbalancedLedgerEntryError",
  "ReferenceRequirementError",
  "ReferenceMismatchError",
  "DuplicateReversalError",
  "WalletNotFoundError",
  "WalletAlreadyExistsError",
  "TransactionNotFoundError",
  "IdempotencyConflictError",
  "InvalidTransactionKindError",
]);

@Injectable()
export class SqsConsumerService implements OnModuleInit, OnModuleDestroy {
  private isRunning = false;
  private isShuttingDown = false;
  private readonly consumerName = "WagerSqsConsumer";

  constructor(
    private readonly sqsClient: SQSClient,
    private readonly processWagerTxUseCase: ProcessWagerTransactionUseCase,
    @Optional() private readonly metricsService?: MetricsService
  ) {}

  onModuleInit() {
    this.startPolling();
  }

  onModuleDestroy() {
    this.isShuttingDown = true;
  }

  private async startPolling() {
    this.isRunning = true;
    const queueUrl =
      process.env.SQS_QUEUE_URL || "http://localhost:4566/000000000000/wager-transactions.fifo";

    logger.info(`Iniciando consumo de mensagens da fila SQS: ${queueUrl}`);

    while (this.isRunning && !this.isShuttingDown) {
      try {
        const response = await this.sqsClient.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 2, // Long polling
            VisibilityTimeout: 30,
            MessageSystemAttributeNames: ["ApproximateReceiveCount"],
          })
        );

        if (response.Messages && response.Messages.length > 0) {
          for (const msg of response.Messages) {
            if (this.isShuttingDown) {
              // Graceful shutdown: devolver visibilidade imediatamente se estiver desligando
              if (msg.ReceiptHandle) {
                await this.sqsClient.send(
                  new ChangeMessageVisibilityCommand({
                    QueueUrl: queueUrl,
                    ReceiptHandle: msg.ReceiptHandle,
                    VisibilityTimeout: 0,
                  })
                );
              }
              break;
            }

            await this.processMessage(msg, queueUrl);
          }
        }
      } catch (error) {
        if (!this.isShuttingDown) {
          logger.error(`Erro durante o polling do SQS: ${(error as Error).message}`);
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    }
  }

  private async processMessage(msg: Message, queueUrl: string) {
    const messageId = msg.MessageId ?? "";
    const receiptHandle = msg.ReceiptHandle;
    const receiveCount = Number(msg.Attributes?.ApproximateReceiveCount ?? 1);
    if (Number.isFinite(receiveCount) && receiveCount > 1) {
      this.metricsService?.messageRetriesTotal.inc({ worker_name: "SqsConsumerService" });
    }

    try {
      const parsedBody = JSON.parse(msg.Body || "{}");
      const eventData = parsedBody.data || parsedBody;
      const idempotencyKey =
        eventData.idempotencyKey || `${eventData.providerId}:${eventData.externalTransactionId}`;

      // Executa o use case central com contexto de Inbox para deduplicação persistente
      const result = await this.processWagerTxUseCase.execute({
        providerId: eventData.providerId,
        externalTransactionId: eventData.externalTransactionId,
        idempotencyKey,
        playerId: eventData.playerId,
        walletId: eventData.walletId,
        roundId: eventData.roundId,
        gameId: eventData.gameId,
        kind: eventData.kind,
        money: eventData.money,
        referenceExternalTransactionId: eventData.referenceExternalTransactionId,
        inboxContext: {
          consumerName: this.consumerName,
          messageId,
        },
      });

      logFinancialEvent({
        event: "SqsMessageProcessed",
        correlationId: idempotencyKey,
        transactionId: result.transactionId,
        walletId: eventData.walletId,
        providerId: eventData.providerId,
        messageId,
        status: result.status,
        failureCode: result.failureCode,
      });

      // Ack no SQS SOMENTE após o commit com sucesso da transação
      await this.sqsClient.send(
        new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receiptHandle,
        })
      );
    } catch (err) {
      const error = err as Error;
      logger.error(`Erro ao processar mensagem do SQS ${messageId}: ${error.message}`);

      // Erros de sintaxe (poison pill), domínio ou aplicação são terminais: fazer ack para não travar a fila FIFO
      const isBusinessError =
        err instanceof SyntaxError ||
        err instanceof DomainError ||
        err instanceof ApplicationError ||
        BUSINESS_ERROR_NAMES.has(error.name);

      if (isBusinessError) {
        this.metricsService?.dlqMessagesTotal.inc();
        logFinancialEvent({
          event: "SqsMessageDropped",
          messageId,
          status: "DLQ_DROPPED",
          failureCode: error.name,
        });
        logger.warn(
          `Mensagem SQS ${messageId} classificada como erro não-retentável (${error.name}); removendo da fila.`
        );
        await this.sqsClient.send(
          new DeleteMessageCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: receiptHandle,
          })
        );
      } else {
        // Se for transitório (ex: BD indisponível), não deleta a mensagem para o SQS reenviar
        this.metricsService?.messageRetriesTotal.inc({ worker_name: "SqsConsumerService" });
      }
    }
  }
}
