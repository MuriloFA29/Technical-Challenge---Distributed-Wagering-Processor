import { randomUUID } from "node:crypto";
import { Injectable, NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { logger } from "../../infrastructure/observability/app-logger";

export interface CorrelatedRequest extends Request {
  correlationId?: string;
}

const MAX_CORRELATION_ID_LENGTH = 128;

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function pickNonEmptyHeader(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length > 0 && !hasControlChars(trimmed)) {
      return trimmed.slice(0, MAX_CORRELATION_ID_LENGTH);
    }
  }
  return null;
}

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: CorrelatedRequest, res: Response, next: NextFunction): void {
    const correlationId =
      pickNonEmptyHeader(req.headers["x-correlation-id"]) ??
      pickNonEmptyHeader(req.headers["x-request-id"]) ??
      randomUUID();

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
