# ADR 002: PostgreSQL Ledger Immutability & Structural Constraints

- **Status**: Accepted
- **Date**: 2026-11-12
- **Related**: [ARCHITECTURE.md](../../ARCHITECTURE.md)

---

## Context

In financial and iGaming ledger systems, application-level validation alone is insufficient to guarantee accounting integrity. A bug in a future use case, an ad-hoc script, or a race condition could otherwise:
- Overwrite or delete historical `wallet_ledger_entries`.
- Allow a wallet balance to go negative.
- Apply two `REFUND` or two `ROLLBACK` transactions against the same original `BET`.
- Persist mathematically inconsistent `balance_before`, `amount`, and `balance_after` values.

## Decision

Enforce financial invariants directly in the PostgreSQL 16 schema (`Migration20261015000000_InitialSchema`):

1. **Append-Only Ledger Trigger**:
   - `fn_prevent_ledger_modification()` attached via `trg_prevent_ledger_update_or_delete` (`BEFORE UPDATE OR DELETE ON "wallet_ledger_entries"`) raises an exception on any mutation or deletion attempt.
2. **Double-Entry Math & Positive Amount `CHECK` Constraints**:
   - `chk_ledger_direction_valid`: `direction IN ('DEBIT', 'CREDIT')`.
   - `chk_ledger_amounts_positive`: `amount >= 0 AND balance_before >= 0 AND balance_after >= 0`.
   - `chk_ledger_math`: `(direction = 'DEBIT' AND balance_before - amount = balance_after) OR (direction = 'CREDIT' AND balance_before + amount = balance_after)`.
   - `uq_ledger_wallet_transaction`: `UNIQUE (wallet_id, transaction_id)`.
3. **Wallet Invariants**:
   - `uq_wallet_player_currency`: `UNIQUE (player_id, currency)` (one wallet per player per currency).
   - `chk_wallet_balance_non_negative`: `CHECK (balance >= 0)`.
4. **Double-Reversal Prevention**:
   - Partial unique index `idx_unique_reversal` on `wager_transactions (reference_transaction_id, kind) WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK')`.

## Consequences

### Positive
- **Defense in depth**: Even direct SQL `UPDATE`/`DELETE` statements against `wallet_ledger_entries` fail immediately.
- **Self-verifying audit trail**: `ReconcileWalletUseCase` can always recompute the exact wallet balance from `wallet_ledger_entries` with 0.00 drift.
- **Race-safe reversal uniqueness**: `idx_unique_reversal` guarantees at the index level that a `BET` can never be refunded or rolled back twice.

### Trade-offs & Mitigations
- **Corrections require compensating entries**: Historical ledger rows cannot be patched in place. *Mitigation*: Model all corrections as new `REFUND`/`ROLLBACK` transactions with their own ledger entries.

## Implementation References

- [`Migration20261015000000_InitialSchema`](../../src/infrastructure/database/migrations/Migration20261015000000_InitialSchema.ts)
- [`WalletLedgerEntryOrmEntity`](../../src/infrastructure/database/entities/wallet-ledger-entry.orm-entity.ts)
- [`ReconcileWalletUseCase`](../../src/application/use-cases/reconcile-wallet.use-case.ts)
