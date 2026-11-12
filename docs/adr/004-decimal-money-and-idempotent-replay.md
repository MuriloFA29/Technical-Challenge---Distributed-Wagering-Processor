# ADR 004: Arbitrary-Precision `Money` & Canonical SHA-256 Idempotent Replay

- **Status**: Accepted
- **Date**: 2026-11-12
- **Related**: [ARCHITECTURE.md](../../ARCHITECTURE.md)

---

## Context

JavaScript IEEE-754 `number` arithmetic introduces binary floating-point rounding errors (e.g., `0.1 + 0.2 !== 0.3`), which are unacceptable in financial ledgers.

Furthermore, network retries and SQS *at-least-once* deliveries mean identical wagering requests will arrive multiple times. If a client accidentally reuses an `Idempotency-Key` with a different amount or target wallet, silent acceptance would corrupt balances; conversely, if a valid retry arrives *after* subsequent bets have changed the wallet's current balance, returning the *current* balance instead of the *balance observed when the original transaction executed* would violate idempotent replay fidelity.

## Decision

1. **Immutable `Money` Value Object (`decimal.js`)**:
   - Configure `decimal.js` with precision `28` and `Decimal.ROUND_HALF_UP`.
   - Enforce a maximum of 2 decimal places (`"25.00"`) and reject `NaN`, `Infinity`, empty strings, and negative values at construction.
   - Require matching currencies on all arithmetic operations (`CurrencyMismatchError` otherwise).
   - Store monetary columns in PostgreSQL as `NUMERIC(18, 2)`.
2. **Canonical JSON + SHA-256 `payloadHash` Idempotency**:
   - Default `Idempotency-Key` to `${providerId}:${externalTransactionId}` when not explicitly provided.
   - Compute a SHA-256 digest over a recursively key-sorted canonical JSON representation (`canonicalJson`) of the business payload.
   - On duplicate `(provider_id, idempotency_key)`:
     - If `payloadHash` diverges → throw `IdempotencyConflictError` (HTTP `409 IDEMPOTENCY_CONFLICT`).
     - If `payloadHash` matches → increment `wagering_duplicate_transactions_total` and return `200 OK` with `idempotentReplay: true` and the persisted `observed_balance` stored on `wager_transactions`.

## Consequences

### Positive
- **Exact decimal arithmetic**: Eliminates IEEE-754 rounding drift across domain calculations and PostgreSQL `NUMERIC(18, 2)` persistence.
- **Deterministic conflict detection**: Key-ordering differences in JSON serialization never cause false `409` conflicts, while any semantic payload change is caught immediately.
- **Faithful replay responses**: Retried requests always receive the exact `observed_balance` from the original execution, regardless of subsequent wallet activity.

### Trade-offs & Mitigations
- **String serialization in API payloads**: Monetary amounts are represented as decimal strings (e.g., `"25.00"`) rather than JSON numbers. *Mitigation*: Documented in OpenAPI/Swagger DTOs (`MoneyDto`) and enforced via `class-validator`.

## Implementation References

- [`Money`](../../src/domain/value-objects/money.ts)
- [`canonical-json.ts`](../../src/application/utils/canonical-json.ts)
- [`ProcessWagerTransactionUseCase`](../../src/application/use-cases/process-wager-transaction.use-case.ts)
- [`MoneyDto`](../../src/presentation/dto/money.dto.ts)
