# Distributed Wagering Processor — Architecture & Design Document

Este documento detalha as decisões arquiteturais, garantias de concorrência, consistência financeira e trade-offs adotados na implementação do **Distributed Wagering Processor** para a Jungle Gaming.

---

## 1. Visão Geral da Arquitetura

O sistema é construído sobre os princípios de **Domain-Driven Design (DDD)**, **Hexagonal Architecture (Ports and Adapters)** e **EDA (Event-Driven Architecture)**, rodando sob o runtime **Bun 1.x** com o framework **NestJS** em modo TypeScript estrito.

```
       [ HTTP API (Express/NestJS) ]       [ AWS SQS FIFO Consumer ]
                     │                                 │
                     └───────────────┬─────────────────┘
                                     ▼
                     [ Application Layer: Use Cases ]
                     (ProcessWagerTransaction, OpenWallet)
                                     │
                     ┌───────────────┴─────────────────┐
                     ▼                                 ▼
             [ Domain Core (DDD) ]        [ Infrastructure (MikroORM) ]
          (Wallet, WagerTransaction,       (PostgreSQL Schema, Constraints,
           WalletLedgerEntry, Money)        Pessimistic Lock, SQS Client)
```

---

## 2. Decisão de ORM e Concorrência (Seções 4, 5 e 8)

### Por que MikroORM?
O **MikroORM** foi selecionado como ORM preferencial devido ao seu padrão de **Unit of Work** e **Identity Map** explícitos. Diferente de soluções ativas como Prisma ou TypeORM, o MikroORM mantém rastreamento preciso das entidades mutadas durante a transação, executando todas as operações SQL em lote atômico (`em.transactional()`), prevenindo side-effects parciais.

### Concorrência com Pessimistic Locking
A unidade de concorrência é a **`walletId`**. Para suportar concorrência extrema (ex.: 50 apostas simultâneas ou disputa entre 3+ instâncias):
1. Cada operação financeira executa:
   ```sql
   SELECT * FROM wallets WHERE id = $1 FOR UPDATE;
   ```
   via `em.findOne(WalletOrmEntity, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE })`.
2. Essa estratégia enfileira no nível do motor transacional do PostgreSQL todas as requisições concorrentes daquela carteira específica, sem necessidade de retry storm ou locks distribuídos globais no Redis.
3. Wallets distintas processam em paralelo sem nenhum bloqueio cruzado.

---

## 3. Garantias Estruturais no Schema do PostgreSQL (Seções 5, 6 e 7)

Conforme a Restrição Inviolável nº 9, a consistência não depende exclusivamente do código da aplicação, mas é reforçada estruturalmente no banco de dados:

1. **Unicidade de Wallet por Jogador e Moeda**:
   ```sql
   CONSTRAINT uq_wallet_player_currency UNIQUE (player_id, currency)
   ```
2. **Saldo Não-Negativo no Banco**:
   ```sql
   CONSTRAINT chk_wallet_balance_non_negative CHECK (balance >= 0)
   ```
3. **Unicidade de Lançamento no Ledger**:
   ```sql
   CONSTRAINT uq_ledger_wallet_transaction UNIQUE (wallet_id, transaction_id)
   ```
4. **Trigger de Imutabilidade Estrita do Ledger**:
   Para cumprir a proibição de update ou delete em registros contábeis:
   ```sql
   CREATE OR REPLACE FUNCTION fn_prevent_ledger_modification()
   RETURNS TRIGGER AS $$
   BEGIN
     RAISE EXCEPTION 'Wallet ledger entries are immutable and cannot be updated or deleted.';
   END;
   $$ LANGUAGE plpgsql;

   CREATE TRIGGER trg_prevent_ledger_update_or_delete
   BEFORE UPDATE OR DELETE ON wallet_ledger_entries
   FOR EACH ROW EXECUTE FUNCTION fn_prevent_ledger_modification();
   ```
5. **Prevenção de Dupla Reversão via Índice Único Parcial**:
   ```sql
   CREATE UNIQUE INDEX idx_unique_reversal ON wager_transactions (reference_transaction_id, kind)
   WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK');
   ```
6. **Integridade Matemática do Ledger (Partida Balanceada)**:
   ```sql
   CONSTRAINT chk_ledger_math CHECK (
     (direction = 'DEBIT' AND balance_before - amount = balance_after) OR
     (direction = 'CREDIT' AND balance_before + amount = balance_after)
   )
   ```

---

## 4. Precisão Monetária — Value Object `Money`

Dinheiro é representado exclusivamente pelo Value Object imutável `Money`, respaldado internamente pela biblioteca de precisão decimal arbitrária `decimal.js`:
- Escala fixa de 2 casas decimais (`"25.00"`).
- Tipos `number`, `float` ou `double` são estritamente proibidos.
- Entradas inválidas (`NaN`, `Infinity`, strings vazias, valores negativos na entrada) são rejeitadas na camada de domínio.
- Operações entre moedas distintas lançam `CurrencyMismatchError`.

---

## 5. Idempotência e Saldo Observado Fiel

O sistema utiliza o header `Idempotency-Key` (formato canônico `{providerId}:{externalTransactionId}`) como fonte da verdade:
1. **Hash Canônico**: Calcula SHA-256 sobre a representação canônica ordenada lexicograficamente dos atributos de negócio.
2. **Detecção de Conflito**: Mesma chave com hash divergente gera HTTP 409 Conflict (`IdempotencyConflictError`).
3. **Replay Fiel com Saldo Observado (Regra 7, Seção 7)**:
   - A transação persiste no banco o campo `observed_balance` correspondente ao momento exato em que foi aplicada ou rejeitada.
   - Em caso de replay idêntico, o endpoint retorna o `observed_balance` histórico persistido, garantindo que apostas posteriores feitas na carteira não alterem a resposta do replay.

---

## 6. Mensageria, Inbox & Transactional Outbox Pattern

Para garantir entrega *at-least-once* e tolerância a falhas sem perda nem duplicação de eventos:
- **Inbox Pattern**: Mensagens do SQS são salvas na tabela `inbox_messages` com chave `(consumer_name, message_id)`. Se uma mensagem for reenviada pelo SQS, a chave impede reprocessamento.
- **Transactional Outbox**: Na mesma transação SQL que altera o saldo e grava o ledger, o evento é enfileirado na tabela `outbox_messages`.
- **Worker com `SKIP LOCKED`**: O `OutboxPublisherWorker` consulta mensagens pendentes usando:
  ```sql
  SELECT * FROM outbox_messages WHERE published_at IS NULL FOR UPDATE SKIP LOCKED
  ```
  Isso permite que **múltiplas instâncias** da aplicação publiquem eventos concorrentemente sem colisões ou locks mútuos.
- **Ack Pós-Commit**: O consumidor SQS apenas executa `DeleteMessageCommand` após a transação SQL ter sido confirmada no PostgreSQL.
- **Referências Fora de Ordem (`PENDING_REFERENCE`)**: Se um `REFUND` ou `ROLLBACK` chegar antes da sua `BET`, ele é gravado em status `PENDING_REFERENCE` e reprocessado pelo `PendingReferenceWorker` até que a transação original seja confirmada ou o TTL expire.

---

## 7. Desenho de Autenticação — Identity Provider Externo (OIDC/Keycloak)

Conforme as diretrizes da Seção 2 do desafio (onde a autenticação não pontua na avaliação técnica), a aplicação fornece um ponto de extensão explícito `AuthGuard` e `ProviderIdentityPort`.

### Arquitetura de Produção Recomendada:
1. **IdP**: **Keycloak** ou **Zitadel** rodando em container OIDC.
2. **Provedores de Jogos**: Cada provedor autentica via OAuth2 Client Credentials Flow (`client_id` + `client_secret`) obtendo um JWT assinado.
3. **Jogadores**: End-users autenticam via Authorization Code Flow com PKCE.
4. **Validação no Wagering Processor**: O `AuthGuard` valida o JWT contra os endpoints JWKS (`/.well-known/jwks.json`) do Keycloak com cache de chaves públicas, extraindo o `provider_id` diretamente dos claims do token (ex.: `sub` ou `azp`).
5. **Mensageria**: Mensagens do SQS são tratadas como canal interno confiável com mTLS e IAM roles, mas o payload é submetido às mesmas validações de domínio.

---

## 8. Observabilidade e Segurança de Logs (Seção 12)

- **Logs Estruturados**: Implementados via **Pino**, com formatação JSON e injeção padronizada de `correlationId`, `transactionId`, `walletId`, `providerId`.
- **Sanitização Financeira**: Conforme a regra de ouro do README, nenhum payload financeiro completo, senhas, chaves de API ou dados de cartão são logados.
- **Métricas Prometheus (`/metrics`)**:
  - `wagering_transactions_total` (por status, kind e provider)
  - `wagering_duplicate_transactions_total` (replays idempotentes)
  - `wagering_outbox_lag_messages` (lag da outbox)
  - `wagering_transaction_duration_seconds` (histograma de latência)
  - `wagering_lock_conflicts_total`
- **Health Checks**: `/health/live` (liveness) e `/health/ready` (readiness checando conectividade ativa com PostgreSQL e SQS).
