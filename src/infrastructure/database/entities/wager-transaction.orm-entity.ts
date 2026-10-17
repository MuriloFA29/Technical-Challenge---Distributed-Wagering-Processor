import { Entity, Index, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { WagerTransactionKind, WagerTransactionStatus, FailureCode } from "../../../domain/entities/wager-transaction";

@Entity({ tableName: "wager_transactions" })
@Unique({ properties: ["providerId", "idempotencyKey"], name: "uq_transaction_provider_idempotency" })
@Unique({ properties: ["providerId", "externalTransactionId"], name: "uq_transaction_provider_external_id" })
@Index({ properties: ["walletId"], name: "idx_transaction_wallet" })
@Index({ properties: ["providerId", "roundId"], name: "idx_transaction_provider_round" })
@Index({ properties: ["status"], name: "idx_transaction_status" })
export class WagerTransactionOrmEntity {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ type: "varchar", length: 100 })
  providerId!: string;

  @Property({ type: "varchar", length: 100 })
  externalTransactionId!: string;

  @Property({ type: "varchar", length: 255 })
  idempotencyKey!: string;

  @Property({ type: "varchar", length: 64 })
  payloadHash!: string;

  @Property({ type: "uuid" })
  walletId!: string;

  @Property({ type: "varchar", length: 100 })
  playerId!: string;

  @Property({ type: "varchar", length: 100 })
  roundId!: string;

  @Property({ type: "gameId", length: 100 })
  gameId!: string;

  @Property({ type: "varchar", length: 20 })
  kind!: WagerTransactionKind;

  @Property({ type: "decimal", precision: 18, scale: 2 })
  amount!: string;

  @Property({ type: "varchar", length: 3 })
  currency!: string;

  @Property({ type: "varchar", length: 100, nullable: true })
  referenceExternalTransactionId?: string;

  @Property({ type: "uuid", nullable: true })
  referenceTransactionId?: string;

  @Property({ type: "varchar", length: 30 })
  status!: WagerTransactionStatus;

  @Property({ type: "varchar", length: 50, nullable: true })
  failureCode?: FailureCode;

  @Property({ type: "decimal", precision: 18, scale: 2, nullable: true })
  observedBalance?: string;

  @Property({ type: "varchar", length: 3, nullable: true })
  observedBalanceCurrency?: string;

  @Property({ type: "timestamptz" })
  createdAt: Date = new Date();

  @Property({ type: "timestamptz", nullable: true })
  processedAt?: Date;
}
