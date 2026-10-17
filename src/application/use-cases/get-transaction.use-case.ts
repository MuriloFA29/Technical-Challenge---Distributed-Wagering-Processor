import { EntityManager } from "@mikro-orm/postgresql";
import { TransactionNotFoundError } from "../errors/application-errors";
import { WagerTransactionOrmEntity } from "../../infrastructure/database/entities";
import { MoneyProps } from "../../domain/value-objects/money";
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/entities/wager-transaction";

export interface TransactionDetailsDto {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  status: WagerTransactionStatus;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  createdAt: Date;
  processedAt?: Date;
}

export class GetTransactionUseCase {
  constructor(private readonly em: EntityManager) {}

  async executeById(transactionId: string): Promise<TransactionDetailsDto> {
    const tx = await this.em.findOne(WagerTransactionOrmEntity, { id: transactionId });
    if (!tx) {
      throw new TransactionNotFoundError(transactionId);
    }
    return this.mapToDto(tx);
  }

  async executeByExternalId(
    providerId: string,
    externalTransactionId: string
  ): Promise<TransactionDetailsDto> {
    const tx = await this.em.findOne(WagerTransactionOrmEntity, {
      providerId,
      externalTransactionId,
    });
    if (!tx) {
      throw new TransactionNotFoundError(`${providerId}:${externalTransactionId}`);
    }
    return this.mapToDto(tx);
  }

  private mapToDto(tx: WagerTransactionOrmEntity): TransactionDetailsDto {
    return {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      money: { amount: tx.amount, currency: tx.currency },
      status: tx.status,
      referenceExternalTransactionId: tx.referenceExternalTransactionId,
      referenceTransactionId: tx.referenceTransactionId,
      failureCode: tx.failureCode,
      createdAt: tx.createdAt,
      processedAt: tx.processedAt,
    };
  }
}
