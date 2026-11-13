# ADR 002: Imutabilidade do Ledger & Constraints Estruturais no PostgreSQL

- **Status**: Aceito
- **Data**: 2026-11-12
- **Relacionado**: [ARCHITECTURE.md](../../ARCHITECTURE.md)

---

## Contexto

Em sistemas financeiros e de ledger de iGaming, validação apenas na camada de aplicação não é suficiente para garantir integridade contábil. Um bug em um caso de uso futuro, um script ad-hoc ou uma condição de corrida poderia:
- Sobrescrever ou apagar registros históricos de `wallet_ledger_entries`.
- Permitir que o saldo de uma carteira ficasse negativo.
- Aplicar duas transações de `REFUND` ou duas de `ROLLBACK` contra o mesmo `BET` original.
- Persistir valores matematicamente inconsistentes de `balance_before`, `amount` e `balance_after`.

## Decisão

Impor invariantes financeiras diretamente no schema do PostgreSQL 16 (`Migration20261015000000_InitialSchema`):

1. **Trigger de Ledger Append-Only**:
   - `fn_prevent_ledger_modification()` associada via `trg_prevent_ledger_update_or_delete` (`BEFORE UPDATE OR DELETE ON "wallet_ledger_entries"`) lança uma exceção em qualquer tentativa de atualização ou exclusão.
2. **Matemática de Partida Dobrada & Constraints `CHECK` de Valores Positivos**:
   - `chk_ledger_direction_valid`: `direction IN ('DEBIT', 'CREDIT')`.
   - `chk_ledger_amounts_positive`: `amount >= 0 AND balance_before >= 0 AND balance_after >= 0`.
   - `chk_ledger_math`: `(direction = 'DEBIT' AND balance_before - amount = balance_after) OR (direction = 'CREDIT' AND balance_before + amount = balance_after)`.
   - `uq_ledger_wallet_transaction`: `UNIQUE (wallet_id, transaction_id)`.
3. **Invariantes da Carteira**:
   - `uq_wallet_player_currency`: `UNIQUE (player_id, currency)` (uma carteira por jogador por moeda).
   - `chk_wallet_balance_non_negative`: `CHECK (balance >= 0)`.
4. **Prevenção de Dupla Reversão**:
   - Índice único parcial `idx_unique_reversal` em `wager_transactions (reference_transaction_id, kind) WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK')`.

## Consequências

### Positivas
- **Defesa em profundidade**: Mesmo comandos SQL diretos de `UPDATE`/`DELETE` em `wallet_ledger_entries` falham imediatamente.
- **Trilha de auditoria autoverificável**: O `ReconcileWalletUseCase` sempre consegue recalcular o saldo exato da carteira a partir de `wallet_ledger_entries` com divergência 0.00.
- **Unicidade de reversão segura contra concorrência**: `idx_unique_reversal` garante no nível de índice que um `BET` nunca possa ser estornado ou revertido duas vezes.

### Trade-offs & Mitigações
- **Correções exigem lançamentos compensatórios**: Linhas históricas do ledger não podem ser editadas no lugar. *Mitigação*: Modelar todas as correções como novas transações `REFUND`/`ROLLBACK` com suas próprias entradas no ledger.

## Referências de Implementação

- [`Migration20261015000000_InitialSchema`](../../src/infrastructure/database/migrations/Migration20261015000000_InitialSchema.ts)
- [`WalletLedgerEntryOrmEntity`](../../src/infrastructure/database/entities/wallet-ledger-entry.orm-entity.ts)
- [`ReconcileWalletUseCase`](../../src/application/use-cases/reconcile-wallet.use-case.ts)
