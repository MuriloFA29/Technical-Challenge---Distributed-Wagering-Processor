import "reflect-metadata";
import { ListQueuesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { EntityManager } from "@mikro-orm/postgresql";
import { INestApplication, Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, NestFactory } from "@nestjs/core";
import { GetTransactionUseCase } from "../../../src/application/use-cases/get-transaction.use-case";
import { GetWalletUseCase } from "../../../src/application/use-cases/get-wallet.use-case";
import { GetWalletLedgerUseCase } from "../../../src/application/use-cases/get-wallet-ledger.use-case";
import { OpenWalletUseCase } from "../../../src/application/use-cases/open-wallet.use-case";
import { ProcessWagerTransactionUseCase } from "../../../src/application/use-cases/process-wager-transaction.use-case";
import { ReconcileWalletUseCase } from "../../../src/application/use-cases/reconcile-wallet.use-case";
import { MetricsService } from "../../../src/infrastructure/observability/metrics.service";
import { HealthController } from "../../../src/presentation/controllers/health.controller";
import { MetricsController } from "../../../src/presentation/controllers/metrics.controller";
import { WageringController } from "../../../src/presentation/controllers/wagering.controller";
import { WalletsController } from "../../../src/presentation/controllers/wallets.controller";
import { GlobalHttpExceptionFilter } from "../../../src/presentation/filters/http-exception.filter";
import { AuthGuard } from "../../../src/presentation/guards/auth.guard";
import { E2eEntityManager } from "./e2e-entity-manager";

export class MockSqsClient {
  public sqsHealthy = true;

  async send(command: unknown): Promise<Record<string, unknown>> {
    if (!this.sqsHealthy) {
      throw new Error("Simulated SQS connection failure");
    }
    if (command instanceof ListQueuesCommand) {
      return {
        QueueUrls: ["http://localhost:4566/000000000000/wager-transactions.fifo"],
      };
    }
    return {};
  }
}

export interface HttpResponse<T = any> {
  status: number;
  headers: Headers;
  body: T;
  text: string;
}

export interface E2eTestHarness {
  app: INestApplication;
  baseUrl: string;
  em: E2eEntityManager;
  sqsClient: MockSqsClient;
  request<T = any>(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      headers?: Record<string, string>;
    }
  ): Promise<HttpResponse<T>>;
  reset(): void;
  close(): Promise<void>;
}

export async function createE2eApp(): Promise<E2eTestHarness> {
  const em = new E2eEntityManager();
  const sqsClient = new MockSqsClient();

  @Module({
    controllers: [WalletsController, WageringController, HealthController, MetricsController],
    providers: [
      {
        provide: EntityManager,
        useValue: em,
      },
      {
        provide: SQSClient,
        useValue: sqsClient,
      },
      MetricsService,
      {
        provide: OpenWalletUseCase,
        useFactory: (entityManager: EntityManager) => new OpenWalletUseCase(entityManager),
        inject: [EntityManager],
      },
      {
        provide: GetWalletUseCase,
        useFactory: (entityManager: EntityManager) => new GetWalletUseCase(entityManager),
        inject: [EntityManager],
      },
      {
        provide: GetWalletLedgerUseCase,
        useFactory: (entityManager: EntityManager) => new GetWalletLedgerUseCase(entityManager),
        inject: [EntityManager],
      },
      {
        provide: ReconcileWalletUseCase,
        useFactory: (entityManager: EntityManager) => new ReconcileWalletUseCase(entityManager),
        inject: [EntityManager],
      },
      {
        provide: ProcessWagerTransactionUseCase,
        useFactory: (entityManager: EntityManager) =>
          new ProcessWagerTransactionUseCase(entityManager),
        inject: [EntityManager],
      },
      {
        provide: GetTransactionUseCase,
        useFactory: (entityManager: EntityManager) => new GetTransactionUseCase(entityManager),
        inject: [EntityManager],
      },
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
  class E2eAppModule {}

  const app = await NestFactory.create(E2eAppModule, { logger: false });
  await app.listen(0, "127.0.0.1");

  const address = app.getHttpServer().address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    app,
    baseUrl,
    em,
    sqsClient,
    async request<T = any>(
      method: string,
      path: string,
      options?: {
        body?: unknown;
        headers?: Record<string, string>;
      }
    ): Promise<HttpResponse<T>> {
      const headers: Record<string, string> = {
        ...(options?.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(options?.headers ?? {}),
      };

      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
      });

      const text = await res.text();
      let parsed: T;
      try {
        parsed = JSON.parse(text) as T;
      } catch {
        parsed = text as unknown as T;
      }

      return {
        status: res.status,
        headers: res.headers,
        body: parsed,
        text,
      };
    },
    reset() {
      em.reset();
      sqsClient.sqsHealthy = true;
    },
    async close() {
      await app.close();
    },
  };
}
