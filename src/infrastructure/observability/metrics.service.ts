import { Injectable } from "@nestjs/common";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

@Injectable()
export class MetricsService {
  public readonly registry: Registry;

  // 1. Transações por status
  public readonly transactionsTotal: Counter<string>;

  // 2. Duplicatas detectadas (Idempotent replays)
  public readonly duplicateTransactionsTotal: Counter<string>;

  // 3. Retries de processamento e mensageria
  public readonly messageRetriesTotal: Counter<string>;

  // 4. Mensagens em DLQ
  public readonly dlqMessagesTotal: Counter<string>;

  // 5. Conflitos de lock / idempotência
  public readonly lockConflictsTotal: Counter<string>;

  // 6. Outbox lag (mensagens pendentes na outbox)
  public readonly outboxLagGauge: Gauge<string>;

  // 7. Latência de processamento
  public readonly transactionDurationSeconds: Histogram<string>;

  constructor() {
    this.registry = new Registry();
    collectDefaultMetrics({ register: this.registry });

    this.transactionsTotal = new Counter({
      name: "wagering_transactions_total",
      help: "Total de transações financeiras submetidas por status e kind",
      labelNames: ["kind", "status", "provider_id"],
      registers: [this.registry],
    });

    this.duplicateTransactionsTotal = new Counter({
      name: "wagering_duplicate_transactions_total",
      help: "Total de replays idempotentes detectados",
      labelNames: ["provider_id"],
      registers: [this.registry],
    });

    this.messageRetriesTotal = new Counter({
      name: "wagering_message_retries_total",
      help: "Total de retries de mensagens ou tarefas agendadas",
      labelNames: ["worker_name"],
      registers: [this.registry],
    });

    this.dlqMessagesTotal = new Counter({
      name: "wagering_dlq_messages_total",
      help: "Total de mensagens enviadas para a Dead Letter Queue",
      registers: [this.registry],
    });

    this.lockConflictsTotal = new Counter({
      name: "wagering_lock_conflicts_total",
      help: "Total de conflitos de concorrência e idempotência observados",
      registers: [this.registry],
    });

    this.outboxLagGauge = new Gauge({
      name: "wagering_outbox_lag_messages",
      help: "Número atual de mensagens pendentes de publicação na outbox",
      registers: [this.registry],
    });

    this.transactionDurationSeconds = new Histogram({
      name: "wagering_transaction_duration_seconds",
      help: "Latência de processamento das transações financeiras",
      labelNames: ["kind", "status"],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers: [this.registry],
    });
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }
}
