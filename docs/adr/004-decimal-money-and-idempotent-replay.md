# ADR 004: `Money` de Precisão Arbitrária & Replay Idempotente com SHA-256 Canônico

- **Status**: Aceito
- **Data**: 2026-11-12
- **Relacionado**: [ARCHITECTURE.md](../../ARCHITECTURE.md)

---

## Contexto

A aritmética de `number` IEEE-754 em JavaScript introduz erros de arredondamento de ponto flutuante binário (ex.: `0.1 + 0.2 !== 0.3`), o que é inaceitável em ledgers financeiros.

Além disso, retries de rede e entregas *at-least-once* do SQS fazem com que requisições idênticas de aposta cheguem múltiplas vezes. Se um cliente reutilizar acidentalmente uma `Idempotency-Key` com um valor ou carteira diferente, aceitar silenciosamente corromperia saldos; por outro lado, se um retry válido chegar *depois* que apostas subsequentes alteraram o saldo atual da carteira, retornar o saldo *atual* em vez do saldo *observado quando a transação original foi executada* violaria a fidelidade do replay idempotente.

## Decisão

1. **Value Object `Money` Imutável (`decimal.js`)**:
   - Configurar `decimal.js` com precisão `28` e `Decimal.ROUND_HALF_UP`.
   - Impor no máximo 2 casas decimais (`"25.00"`) e rejeitar `NaN`, `Infinity`, strings vazias e valores negativos na construção.
   - Exigir moedas correspondentes em todas as operações aritméticas (`CurrencyMismatchError` caso contrário).
   - Armazenar colunas monetárias no PostgreSQL como `NUMERIC(18, 2)`.
2. **JSON Canônico + Idempotência por `payloadHash` SHA-256**:
   - Assumir `Idempotency-Key` padrão `${providerId}:${externalTransactionId}` quando não informada explicitamente.
   - Calcular um digest SHA-256 sobre uma representação JSON canônica com chaves ordenadas recursivamente (`canonicalJson`) do payload de negócio.
   - Em caso de duplicidade em `(provider_id, idempotency_key)`:
     - Se `payloadHash` divergir → lançar `IdempotencyConflictError` (HTTP `409 IDEMPOTENCY_CONFLICT`).
     - Se `payloadHash` coincidir → incrementar `wagering_duplicate_transactions_total` e retornar `200 OK` com `idempotentReplay: true` e o `observed_balance` persistido em `wager_transactions`.

## Consequências

### Positivas
- **Aritmética decimal exata**: Elimina desvios de arredondamento IEEE-754 nos cálculos de domínio e na persistência `NUMERIC(18, 2)` do PostgreSQL.
- **Detecção determinística de conflitos**: Diferenças na ordem das chaves na serialização JSON nunca causam falsos `409`, enquanto qualquer mudança semântica no payload é detectada imediatamente.
- **Respostas de replay fiéis**: Requisições reenviadas sempre recebem o `observed_balance` exato da execução original, independentemente de movimentações posteriores na carteira.

### Trade-offs & Mitigações
- **Serialização em string nos payloads da API**: Valores monetários são representados como strings decimais (ex.: `"25.00"`) em vez de números JSON. *Mitigação*: Documentado nos DTOs OpenAPI/Swagger (`MoneyDto`) e validado via `class-validator`.

## Referências de Implementação

- [`Money`](../../src/domain/value-objects/money.ts)
- [`canonical-json.ts`](../../src/application/utils/canonical-json.ts)
- [`ProcessWagerTransactionUseCase`](../../src/application/use-cases/process-wager-transaction.use-case.ts)
- [`MoneyDto`](../../src/presentation/dto/money.dto.ts)
