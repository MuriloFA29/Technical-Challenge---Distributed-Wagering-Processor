import { randomUUID } from "node:crypto";
import { Injectable, NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { logger } from "../../infrastructure/observability/app-logger";

export interface CorrelatedRequest extends Request {
  correlationId?: string;
}

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: CorrelatedRequest, res: Response, next: NextFunction): void {
    const rawCorrelationId = req.headers["x-correlation-id"] ?? req.headers["x-request-id"];
    const headerValue = Array.isArray(rawCorrelationId) ? rawCorrelationId[0] : rawCorrelationId;
    const correlationId =
      typeof headerValue === "string" && headerValue.trim().length > 0
        ? headerValue.trim()
        : randomUUID();

    req.correlationId = correlationId;
    res.setHeader("X-Correlation-Id", correlationId);

    const startNs = process.hrtime.bigint();
    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
      logger.info({
        event: "HttpRequestCompleted",
        correlationId,
        method: req.method,
        path: req.originalUrl || req.url,
        statusCode: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
      });
    });

    next();
  }
}
