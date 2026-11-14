# ADR 003: Transactional Outbox, Inbox & Workers `SKIP LOCKED`

- **Status**: Aceito
- **Data**: 2026-11-12
- **Relacionado**: [ARCHITECTURE.md](../../ARCHITECTURE.md)

---

## Contexto

O processador consome comandos de apostas do AWS SQS FIFO (`wager-transactions.fifo`) e emite eventos de integração de domínio (`WalletBalanceChanged`, `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`) para `wager-events.fifo`.

Publicar no SQS dentro de uma transação de banco de dados traz riscos de:
- Inconsistência de escrita dupla (*dual-write*): o banco faz commit e o SQS falha; ou o SQS recebe a mensagem e o banco faz rollback.
- Manter conexões de banco e locks de linha abertos durante I/O de rede.

Além disso, múltiplas instâncias da aplicação podem consultar `outbox_messages` e transações `PENDING_REFERENCE` simultaneamente, e mensagens `REFUND`/`ROLLBACK` podem chegar fora de ordem antes do `BET` referenciado.

## Decisão

1. **Padrão Inbox (`inbox_messages`)**:
   - O `SqsConsumerService` (`consumerName = "WagerSqsConsumer"`) insere `(consumer_name, message_id)` em `inbox_messages` dentro da mesma transação de banco da operação de aposta.
   - `DeleteMessageCommand` do SQS é executado **somente após** o commit da transação PostgreSQL.
   - Mensagens inválidas/venenosas que excedem `maxReceiveCount = 5` são encaminhadas pela `RedrivePolicy` do SQS para `wager-transactions-dlq.fifo`.
2. **Outbox Transacional (`outbox_messages`) + `OutboxPublisherWorker` em 3 Fases**:
   - Eventos de domínio são persistidos em `outbox_messages` na mesma transação ACID das atualizações da carteira e do ledger.
   - O `OutboxPublisherWorker` executa em 3 fases:
     1. **Claim**: `LockMode.PESSIMISTIC_PARTIAL_WRITE` (`FOR UPDATE SKIP LOCKED`) seleciona linhas vencidas e define um lease de 30 segundos (`next_attempt_at`).
     2. **Publish**: Envia mensagens para `wager-events.fifo` (`MessageGroupId = aggregateId`, `MessageDeduplicationId = outboxMessage.id`) **fora** de qualquer transação de banco.
     3. **Acknowledge / Retry**: Marca `published_at` em sucesso ou aplica backoff e incrementa `wagering_message_retries_total` em falha.
3. **Recuperação Fora de Ordem (`PendingReferenceWorker`)**:
   - Consulta transações `PENDING_REFERENCE` usando `FOR UPDATE SKIP LOCKED`, adquire o lock da carteira primeiro, rejeita rapidamente se a transação referenciada estiver `REJECTED`/`FAILED`, aplica a reversão *in-place* se estiver `PROCESSED`, ou chama `rejectInPlace(...)` para transicionar para `REJECTED` (`FailureCode.ReferenceNotFound`) após um TTL de 5 minutos.

## Consequências

### Positivas
- **Sem anomalias de dual-write**: Toda mudança de estado comitada produz seu evento de outbox atomicamente.
- **Escalabilidade horizontal de workers**: Múltiplas réplicas executam `OutboxPublisherWorker` e `PendingReferenceWorker` concorrentemente sem processamento duplicado ou contenção de lock graças ao `FOR UPDATE SKIP LOCKED`.
- **Uso limpo de conexões de banco**: Chamadas de rede ao SQS acontecem fora das transações de banco.

### Trade-offs & Mitigações
- **Semântica de entrega *at-least-once***: Se o worker cair após `SendMessage` e antes de marcar `published_at`, o evento pode ser enviado novamente após o lease de 30s. *Mitigação*: A deduplicação do SQS FIFO (`MessageDeduplicationId = outboxMessage.id`) e o `eventId` no envelope `IntegrationEvent` permitem que consumidores downstream deduplicam com segurança.

## Referências de Implementação

- [`OutboxPublisherWorker`](../../src/infrastructure/workers/outbox-publisher.worker.ts)
- [`PendingReferenceWorker`](../../src/infrastructure/workers/pending-reference.worker.ts)
- [`SqsConsumerService`](../../src/infrastructure/messaging/sqs-consumer.service.ts)
- [`IntegrationEvent`](../../src/domain/events/integration-event.ts)
- [`init-sqs.sh`](../../docker/localstack-init/init-sqs.sh)
