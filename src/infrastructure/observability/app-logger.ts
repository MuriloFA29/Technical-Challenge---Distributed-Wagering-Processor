import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers['x-api-key']",
      "password",
      "token",
      "secret",
      "cardNumber",
    ],
    remove: true,
  },
});

export function logFinancialEvent(data: {
  event: string;
  correlationId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  messageId?: string;
  status?: string;
  failureCode?: string;
}): void {
  // Log estruturado JSON contendo apenas metadados canônicos, sem payloads financeiros brutos
  logger.info({
    event: data.event,
    correlationId: data.correlationId,
    transactionId: data.transactionId,
    walletId: data.walletId,
    providerId: data.providerId,
    messageId: data.messageId,
    status: data.status,
    failureCode: data.failureCode,
  });
}
