import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { EntityManager } from "@mikro-orm/postgresql";
import mikroOrmConfig from "./infrastructure/database/mikro-orm.config";
import { WalletsController } from "./presentation/controllers/wallets.controller";
import { WageringController } from "./presentation/controllers/wagering.controller";
import { HealthController } from "./presentation/controllers/health.controller";
import { MetricsController } from "./presentation/controllers/metrics.controller";
import { OpenWalletUseCase } from "./application/use-cases/open-wallet.use-case";
import { GetWalletUseCase } from "./application/use-cases/get-wallet.use-case";
import { GetWalletLedgerUseCase } from "./application/use-cases/get-wallet-ledger.use-case";
import { ReconcileWalletUseCase } from "./application/use-cases/reconcile-wallet.use-case";
import { ProcessWagerTransactionUseCase } from "./application/use-cases/process-wager-transaction.use-case";
import { GetTransactionUseCase } from "./application/use-cases/get-transaction.use-case";
import { createSqsClient } from "./infrastructure/messaging/sqs-client.provider";
import { SQSClient } from "@aws-sdk/client-sqs";
import { OutboxPublisherWorker } from "./infrastructure/workers/outbox-publisher.worker";
import { PendingReferenceWorker } from "./infrastructure/workers/pending-reference.worker";
import { SqsConsumerService } from "./infrastructure/messaging/sqs-consumer.service";
import { MetricsService } from "./infrastructure/observability/metrics.service";
import { AuthGuard } from "./presentation/guards/auth.guard";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { GlobalHttpExceptionFilter } from "./presentation/filters/http-exception.filter";

@Module({
  imports: [
    MikroOrmModule.forRoot(mikroOrmConfig),
    ScheduleModule.forRoot(),
  ],
  controllers: [
    WalletsController,
    WageringController,
    HealthController,
    MetricsController,
  ],
  providers: [
    // SQS Client
    {
      provide: SQSClient,
      useFactory: () => createSqsClient(),
    },
    // Metrics
    MetricsService,
    // Use Cases
    {
      provide: OpenWalletUseCase,
      useFactory: (em: EntityManager) => new OpenWalletUseCase(em),
      inject: [EntityManager],
    },
    {
      provide: GetWalletUseCase,
      useFactory: (em: EntityManager) => new GetWalletUseCase(em),
      inject: [EntityManager],
    },
    {
      provide: GetWalletLedgerUseCase,
      useFactory: (em: EntityManager) => new GetWalletLedgerUseCase(em),
      inject: [EntityManager],
    },
    {
      provide: ReconcileWalletUseCase,
      useFactory: (em: EntityManager) => new ReconcileWalletUseCase(em),
      inject: [EntityManager],
    },
    {
      provide: ProcessWagerTransactionUseCase,
      useFactory: (em: EntityManager) => new ProcessWagerTransactionUseCase(em),
      inject: [EntityManager],
    },
    {
      provide: GetTransactionUseCase,
      useFactory: (em: EntityManager) => new GetTransactionUseCase(em),
      inject: [EntityManager],
    },
    // Workers & Messaging
    OutboxPublisherWorker,
    PendingReferenceWorker,
    SqsConsumerService,
    // Guards & Filters
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
    {
      provide: APP_FILTER,
      useClass: GlobalHttpExceptionFilter,
    },
  ],
})
export class AppModule {}
