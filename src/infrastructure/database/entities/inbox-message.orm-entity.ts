import { Entity, PrimaryKeyProp, Property } from "@mikro-orm/core";

@Entity({ tableName: "inbox_messages" })
export class InboxMessageOrmEntity {
  @Property({ type: "varchar", length: 255, primary: true })
  messageId!: string;

  @Property({ type: "varchar", length: 100, primary: true })
  consumerName!: string;

  @Property({ type: "varchar", length: 64 })
  payloadHash!: string;

  @Property({ type: "timestamptz" })
  receivedAt: Date = new Date();

  @Property({ type: "timestamptz", nullable: true })
  processedAt?: Date;

  [PrimaryKeyProp]?: ["consumerName", "messageId"];
}
