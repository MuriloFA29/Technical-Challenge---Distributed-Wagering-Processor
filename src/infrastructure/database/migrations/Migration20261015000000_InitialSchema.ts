import { Migration } from "@mikro-orm/migrations";

export class Migration20261015000000_InitialSchema extends Migration {
  async up(): Promise<void> {
    // 1. Tabela wallets
    this.addSql(`
      CREATE TABLE IF NOT EXISTS "wallets" (
        "id" UUID PRIMARY KEY,
        "player_id" VARCHAR(100) NOT NULL,
        "currency" VARCHAR(3) NOT NULL,
        "balance" NUMERIC(18, 2) NOT NULL,
        "version" INTEGER NOT NULL DEFAULT 1,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT "uq_wallet_player_currency" UNIQUE ("player_id", "currency"),
        CONSTRAINT "chk_wallet_balance_non_negative" CHECK ("balance" >= 0)
      );
    `);

    // 2. Tabela wager_transactions
    this.addSql(`
      CREATE TABLE IF NOT EXISTS "wager_transactions" (
        "id" UUID PRIMARY KEY,
        "provider_id" VARCHAR(100) NOT NULL,
        "external_transaction_id" VARCHAR(100) NOT NULL,
        "idempotency_key" VARCHAR(255) NOT NULL,
        "payload_hash" VARCHAR(64) NOT NULL,
        "wallet_id" UUID NOT NULL REFERENCES "wallets" ("id") ON DELETE RESTRICT,
        "player_id" VARCHAR(100) NOT NULL,
        "round_id" VARCHAR(100) NOT NULL,
        "game_id" VARCHAR(100) NOT NULL,
        "kind" VARCHAR(20) NOT NULL,
        "amount" NUMERIC(18, 2) NOT NULL,
        "currency" VARCHAR(3) NOT NULL,
        "reference_external_transaction_id" VARCHAR(100) NULL,
        "reference_transaction_id" UUID NULL REFERENCES "wager_transactions" ("id") ON DELETE RESTRICT,
        "status" VARCHAR(30) NOT NULL,
        "failure_code" VARCHAR(50) NULL,
        "observed_balance" NUMERIC(18, 2) NULL,
        "observed_balance_currency" VARCHAR(3) NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "processed_at" TIMESTAMPTZ NULL,
        CONSTRAINT "uq_transaction_provider_idempotency" UNIQUE ("provider_id", "idempotency_key"),
        CONSTRAINT "uq_transaction_provider_external_id" UNIQUE ("provider_id", "external_transaction_id")
      );

      CREATE INDEX IF NOT EXISTS "idx_transaction_wallet" ON "wager_transactions" ("wallet_id");
      CREATE INDEX IF NOT EXISTS "idx_transaction_provider_round" ON "wager_transactions" ("provider_id", "round_id");
      CREATE INDEX IF NOT EXISTS "idx_transaction_status" ON "wager_transactions" ("status");
      CREATE INDEX IF NOT EXISTS "idx_transaction_pending_reference" ON "wager_transactions" ("status") WHERE "status" = 'PENDING_REFERENCE';

      -- Prevenção de dupla reversão no schema: uma referência não pode ser revertida duas vezes pelo mesmo tipo
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_unique_reversal" ON "wager_transactions" ("reference_transaction_id", "kind")
      WHERE "status" = 'PROCESSED' AND "kind" IN ('REFUND', 'ROLLBACK');
    `);

    // 3. Tabela wallet_ledger_entries (Imutabilidade Estrutural com Trigger)
    this.addSql(`
      CREATE TABLE IF NOT EXISTS "wallet_ledger_entries" (
        "id" UUID PRIMARY KEY,
        "wallet_id" UUID NOT NULL REFERENCES "wallets" ("id") ON DELETE RESTRICT,
        "transaction_id" UUID NOT NULL REFERENCES "wager_transactions" ("id") ON DELETE RESTRICT,
        "direction" VARCHAR(10) NOT NULL,
        "amount" NUMERIC(18, 2) NOT NULL,
        "currency" VARCHAR(3) NOT NULL,
        "balance_before" NUMERIC(18, 2) NOT NULL,
        "balance_after" NUMERIC(18, 2) NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT "uq_ledger_wallet_transaction" UNIQUE ("wallet_id", "transaction_id"),
        CONSTRAINT "chk_ledger_direction_valid" CHECK ("direction" IN ('DEBIT', 'CREDIT')),
        CONSTRAINT "chk_ledger_amounts_positive" CHECK ("amount" >= 0 AND "balance_before" >= 0 AND "balance_after" >= 0),
        CONSTRAINT "chk_ledger_math" CHECK (
          ("direction" = 'DEBIT' AND "balance_before" - "amount" = "balance_after") OR
          ("direction" = 'CREDIT' AND "balance_before" + "amount" = "balance_after")
        )
      );

      CREATE INDEX IF NOT EXISTS "idx_ledger_wallet_created" ON "wallet_ledger_entries" ("wallet_id", "created_at" DESC);

      -- Função e Trigger para Imutabilidade Estrita do Ledger no Banco de Dados
      CREATE OR REPLACE FUNCTION fn_prevent_ledger_modification()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'Wallet ledger entries are immutable and cannot be updated or deleted.';
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_prevent_ledger_update_or_delete ON "wallet_ledger_entries";
      CREATE TRIGGER trg_prevent_ledger_update_or_delete
      BEFORE UPDATE OR DELETE ON "wallet_ledger_entries"
      FOR EACH ROW
      EXECUTE FUNCTION fn_prevent_ledger_modification();
    `);

    // 4. Tabela inbox_messages
    this.addSql(`
      CREATE TABLE IF NOT EXISTS "inbox_messages" (
        "message_id" VARCHAR(255) NOT NULL,
        "consumer_name" VARCHAR(100) NOT NULL,
        "payload_hash" VARCHAR(64) NOT NULL,
        "received_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "processed_at" TIMESTAMPTZ NULL,
        PRIMARY KEY ("consumer_name", "message_id")
      );
    `);

    // 5. Tabela outbox_messages
    this.addSql(`
      CREATE TABLE IF NOT EXISTS "outbox_messages" (
        "id" UUID PRIMARY KEY,
        "aggregate_id" VARCHAR(100) NOT NULL,
        "event_type" VARCHAR(100) NOT NULL,
        "payload" JSONB NOT NULL,
        "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "attempts" INTEGER NOT NULL DEFAULT 0,
        "next_attempt_at" TIMESTAMPTZ NULL,
        "published_at" TIMESTAMPTZ NULL
      );

      CREATE INDEX IF NOT EXISTS "idx_outbox_due" ON "outbox_messages" ("published_at", "next_attempt_at");
    `);
  }

  async down(): Promise<void> {
    this.addSql('DROP TRIGGER IF EXISTS trg_prevent_ledger_update_or_delete ON "wallet_ledger_entries";');
    this.addSql('DROP FUNCTION IF EXISTS fn_prevent_ledger_modification();');
    this.addSql('DROP TABLE IF EXISTS "outbox_messages";');
    this.addSql('DROP TABLE IF EXISTS "inbox_messages";');
    this.addSql('DROP TABLE IF EXISTS "wallet_ledger_entries";');
    this.addSql('DROP TABLE IF EXISTS "wager_transactions";');
    this.addSql('DROP TABLE IF EXISTS "wallets";');
  }
}
