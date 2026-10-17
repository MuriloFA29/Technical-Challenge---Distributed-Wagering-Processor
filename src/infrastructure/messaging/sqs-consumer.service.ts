import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { ProcessWagerTransactionUseCase } from "../../application/use-cases/process-wager-transaction.use-case";
import { logger } from "../observability/app-logger";

@Injectable()
export class SqsConsumerService implements OnModuleInit, OnModuleDestroy {
  private isRunning = false;
  private isShuttingDown = false;
  private readonly consumerName = "WagerSqsConsumer";

  constructor(
    private readonly sqsClient: SQSClient,
    private readonly processWagerTxUseCase: ProcessWagerTransactionUseCase
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
      process.env.SQS_QUEUE_URL ||
      "http://localhost:4566/000000000000/wager-transactions.fifo";

    logger.info(`Iniciando consumo de mensagens da fila SQS: ${queueUrl}`);

    while (this.isRunning && !this.isShuttingDown) {
      try {
        const response = await this.sqsClient.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 2, // Long polling
            VisibilityTimeout: 30,
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

  private async processMessage(msg: any, queueUrl: string) {
    const messageId = msg.MessageId;
    const receiptHandle = msg.ReceiptHandle;

    try {
      const parsedBody = JSON.parse(msg.Body || "{}");
      const eventData = parsedBody.data || parsedBody;

      // Executa o use case central com contexto de Inbox para deduplicação persistente
      await this.processWagerTxUseCase.execute({
        providerId: eventData.providerId,
        externalTransactionId: eventData.externalTransactionId,
        idempotencyKey: eventData.idempotencyKey || `${eventData.providerId}:${eventData.externalTransactionId}`,
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

      // Erros de domínio / regra de negócio são terminais: fazer ack para não travar a fila FIFO
      const isBusinessError =
        error.name === "InvalidMoneyError" ||
        error.name === "ReferenceRequirementError" ||
        error.name === "IdempotencyConflictError";

      if (isBusinessError) {
        await this.sqsClient.send(
          new DeleteMessageCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: receiptHandle,
          })
        );
      }
      // Se for transitório (ex: BD indisponível), não deleta a mensagem para o SQS reenviar
    }
  }
}
