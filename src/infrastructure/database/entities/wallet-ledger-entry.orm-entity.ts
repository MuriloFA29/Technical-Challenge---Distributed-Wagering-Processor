import { Check, Entity, Index, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { LedgerDirection } from "../../../domain/entities/wallet-ledger-entry";

@Entity({ tableName: "wallet_ledger_entries" })
@Unique({ properties: ["walletId", "transactionId"], name: "uq_ledger_wallet_transaction" })
@Index({ properties: ["walletId", "createdAt"], name: "idx_ledger_wallet_created" })
@Check({
  expression: "direction IN ('DEBIT', 'CREDIT')",
  name: "chk_ledger_direction_valid",
})
@Check({
  expression: "amount >= 0 AND balance_before >= 0 AND balance_after >= 0",
  name: "chk_ledger_amounts_positive",
})
@Check({
  expression:
    "(direction = 'DEBIT' AND balance_before - amount = balance_after) OR (direction = 'CREDIT' AND balance_before + amount = balance_after)",
  name: "chk_ledger_math",
})
export class WalletLedgerEntryOrmEntity {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ type: "uuid" })
  walletId!: string;

  @Property({ type: "uuid" })
  transactionId!: string;

  @Property({ type: "varchar", length: 10 })
  direction!: LedgerDirection;

  @Property({ type: "decimal", precision: 18, scale: 2 })
  amount!: string;

  @Property({ type: "varchar", length: 3 })
  currency!: string;

  @Property({ type: "decimal", precision: 18, scale: 2 })
  balanceBefore!: string;

  @Property({ type: "decimal", precision: 18, scale: 2 })
  balanceAfter!: string;

  @Property({ type: "timestamptz" })
  createdAt: Date = new Date();
}
