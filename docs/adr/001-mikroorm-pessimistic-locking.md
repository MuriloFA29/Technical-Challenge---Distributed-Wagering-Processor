# ADR 001: MikroORM & Pessimistic Row Locking para Concorrência de Carteiras

- **Status**: Aceito
- **Data**: 2026-11-12
- **Relacionado**: [ARCHITECTURE.md](../../ARCHITECTURE.md)

---

## Contexto

Um processador distribuído de apostas precisa lidar com mutações de saldo concorrentes em rajada (ex.: requisições simultâneas de `BET`, `WIN`, `REFUND` e `ROLLBACK` para a mesma carteira de jogador entre múltiplas réplicas da aplicação) sem:
- Atualizações perdidas (*lost updates*) ou saldos negativos.
- Divergência entre o saldo da carteira e o ledger.
- Tempestades de retries otimistas sob alta contenção ou infraestrutura frágil de locks distribuídos (ex.: Redis Redlock).

Também precisamos de um ORM que rastreie mutações de estado entre múltiplas tabelas (`wallets`, `wager_transactions`, `wallet_ledger_entries`, `outbox_messages`, `inbox_messages`) dentro de uma única transação SQL atômica.

## Decisão

1. **Adotar MikroORM 6.4** como camada de persistência devido ao seu **Unit of Work** e **Identity Map** explícitos por fork do `EntityManager` (`em.transactional(...)`).
2. **Usar `walletId` como unidade de concorrência** e serializar operações que alteram saldo por carteira usando locking pessimista de linha no PostgreSQL:
   - `LockMode.PESSIMISTIC_WRITE` (`SELECT ... FROM wallets WHERE id = $1 FOR UPDATE`).
   - Espera limitada via `SET LOCAL lock_timeout = '5000ms'` dentro de cada transação.
3. **Usar `LockMode.PESSIMISTIC_READ`** no `ReconcileWalletUseCase` para que a reconciliação via `SUM`/`COUNT` no ledger execute sobre um snapshot consistente sem bloquear leitores concorrentes.
4. **Impor ordenação consistente de locks** nos workers em background (`PendingReferenceWorker` adquire o lock da linha `wallet` antes de mutar `wager_transactions` e `wallet_ledger_entries`) para evitar deadlocks.

## Consequências

### Positivas
- **Zero divergência de saldo**: Mutações concorrentes na mesma carteira são estritamente serializadas pelo gerenciador de locks transacionais do PostgreSQL.
- **Paralelismo completo entre carteiras**: Transações em `walletId`s distintos nunca competem entre si.
- **Sem coordenador de lock externo**: Elimina drift de lease de locks no Redis, modos de falha *split-brain* e saltos extras de rede.
- **Latência de cauda limitada**: `SET LOCAL lock_timeout = '5000ms'` evita enfileiramento indefinido de locks e incrementa `wagering_lock_conflicts_total` quando acionado.

### Trade-offs & Mitigações
- **Teto de vazão por carteira**: Uma única carteira muito quente é serializada pela latência da transação no banco. *Mitigação*: Manter transações curtas (sem I/O externo de HTTP/SQS dentro de `em.transactional`) e delegar a publicação assíncrona para o `OutboxPublisherWorker`.
- **Pressão no pool de conexões sob contenção extrema**: Transações em espera seguram uma conexão PostgreSQL. *Mitigação*: `lock_timeout = 5000ms` limita o tempo de retenção e expõe conflitos de lock de forma limpa.

## Referências de Implementação

- [`ProcessWagerTransactionUseCase`](../../src/application/use-cases/process-wager-transaction.use-case.ts)
- [`ReconcileWalletUseCase`](../../src/application/use-cases/reconcile-wallet.use-case.ts)
- [`PendingReferenceWorker`](../../src/infrastructure/workers/pending-reference.worker.ts)
- [`mikro-orm.config.ts`](../../src/infrastructure/database/mikro-orm.config.ts)
