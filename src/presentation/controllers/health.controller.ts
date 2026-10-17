import { Controller, Get, HttpException, HttpStatus } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { SQSClient, ListQueuesCommand } from "@aws-sdk/client-sqs";

@Controller("health")
export class HealthController {
  constructor(
    private readonly em: EntityManager,
    private readonly sqsClient: SQSClient
  ) {}

  @Get("live")
  live() {
    return {
      status: "UP",
      timestamp: new Date().toISOString(),
    };
  }

  @Get("ready")
  async ready() {
    let dbStatus = "UP";
    let sqsStatus = "UP";

    // 1. Checar conexão com o PostgreSQL
    try {
      await this.em.getConnection().execute("SELECT 1");
    } catch {
      dbStatus = "DOWN";
    }

    // 2. Checar conexão com AWS SQS / LocalStack
    try {
      await this.sqsClient.send(new ListQueuesCommand({ MaxResults: 1 }));
    } catch {
      sqsStatus = "DOWN";
    }

    const isReady = dbStatus === "UP" && sqsStatus === "UP";

    if (!isReady) {
      throw new HttpException(
        {
          status: "DOWN",
          database: dbStatus,
          sqs: sqsStatus,
          timestamp: new Date().toISOString(),
        },
        HttpStatus.SERVICE_UNAVAILABLE
      );
    }

    return {
      status: "UP",
      database: dbStatus,
      sqs: sqsStatus,
      timestamp: new Date().toISOString(),
    };
  }
}
