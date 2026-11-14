import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/entities/wager-transaction";
import { LedgerDirection } from "../../domain/entities/wallet-ledger-entry";
import { MoneyDto } from "./money.dto";

export class WalletResponseDto {
  @ApiProperty({ example: "0195a1b2-0000-7000-8000-000000000001" })
  id!: string;

  @ApiProperty({ example: "player-123" })
  playerId!: string;

  @ApiProperty({ type: () => MoneyDto })
  balance!: MoneyDto;

  @ApiProperty({ example: 1 })
  version!: number;

  @ApiPropertyOptional({ example: "2026-01-01T00:00:00.000Z" })
  createdAt?: string;

  @ApiPropertyOptional({ example: "2026-01-01T00:00:00.000Z" })
  updatedAt?: string;
}

export class LedgerEntryDto {
  @ApiProperty({ example: "0195a1b2-0000-7000-8000-000000000002" })
  id!: string;

  @ApiProperty({ example: "0195a1b2-0000-7000-8000-000000000003" })
  transactionId!: string;

  @ApiProperty({ enum: LedgerDirection, example: LedgerDirection.Debit })
  direction!: LedgerDirection;

  @ApiProperty({ type: () => MoneyDto })
  money!: MoneyDto;

  @ApiProperty({ type: () => MoneyDto })
  balanceBefore!: MoneyDto;

  @ApiProperty({ type: () => MoneyDto })
  balanceAfter!: MoneyDto;

  @ApiProperty({ example: "2026-01-01T00:00:00.000Z" })
  createdAt!: string;
}

export class WalletLedgerResponseDto {
  @ApiProperty({ type: () => [LedgerEntryDto] })
  items!: LedgerEntryDto[];

  @ApiPropertyOptional({ example: "eyJpZCI6IjAxOTUuLi4ifQ==" })
  nextCursor?: string;

  @ApiProperty({ example: false })
  hasMore!: boolean;
}

export class ReconciliationResponseDto {
  @ApiProperty({ example: "0195a1b2-0000-7000-8000-000000000001" })
  walletId!: string;

  @ApiProperty({ type: () => MoneyDto })
  storedBalance!: MoneyDto;

  @ApiProperty({ type: () => MoneyDto })
  calculatedBalance!: MoneyDto;

  @ApiProperty({ type: () => MoneyDto })
  difference!: MoneyDto;

  @ApiProperty({ example: true })
  consistent!: boolean;

  @ApiProperty({ example: 5 })
  checkedEntries!: number;
}

export class TransactionResultResponseDto {
  @ApiProperty({ example: "0195a1b2-0000-7000-8000-000000000003" })
  transactionId!: string;

  @ApiProperty({ enum: WagerTransactionStatus, example: WagerTransactionStatus.Processed })
  status!: WagerTransactionStatus;

  @ApiProperty({ type: () => MoneyDto })
  balance!: MoneyDto;

  @ApiProperty({ example: false })
  idempotentReplay!: boolean;

  @ApiPropertyOptional({ enum: FailureCode })
  failureCode?: FailureCode;
}

export class TransactionDetailResponseDto {
  @ApiProperty({ example: "0195a1b2-0000-7000-8000-000000000003" })
  id!: string;

  @ApiProperty({ example: "provider-a" })
  providerId!: string;

  @ApiProperty({ example: "ext-bet-1" })
  externalTransactionId!: string;

  @ApiProperty({ example: "provider-a:ext-bet-1" })
  idempotencyKey!: string;

  @ApiProperty({ example: "0195a1b2-0000-7000-8000-000000000001" })
  walletId!: string;

  @ApiProperty({ example: "player-123" })
  playerId!: string;

  @ApiProperty({ example: "round-1" })
  roundId!: string;

  @ApiProperty({ example: "game-slots-1" })
  gameId!: string;

  @ApiProperty({ enum: WagerTransactionKind, example: WagerTransactionKind.Bet })
  kind!: WagerTransactionKind;

  @ApiProperty({ type: () => MoneyDto })
  money!: MoneyDto;

  @ApiProperty({ enum: WagerTransactionStatus, example: WagerTransactionStatus.Processed })
  status!: WagerTransactionStatus;

  @ApiPropertyOptional({ example: "ext-bet-1" })
  referenceExternalTransactionId?: string;

  @ApiPropertyOptional({ example: "0195a1b2-0000-7000-8000-000000000004" })
  referenceTransactionId?: string;

  @ApiPropertyOptional({ enum: FailureCode })
  failureCode?: FailureCode;

  @ApiProperty({ example: "2026-01-01T00:00:00.000Z" })
  createdAt!: string;

  @ApiPropertyOptional({ example: "2026-01-01T00:00:00.000Z" })
  processedAt?: string;
}

export class HealthLiveResponseDto {
  @ApiProperty({ example: "UP" })
  status!: string;

  @ApiProperty({ example: "2026-01-01T00:00:00.000Z" })
  timestamp!: string;
}

export class HealthReadyResponseDto {
  @ApiProperty({ example: "UP" })
  status!: string;

  @ApiProperty({ example: "UP" })
  database!: string;

  @ApiProperty({ example: "UP" })
  sqs!: string;

  @ApiProperty({ example: "2026-01-01T00:00:00.000Z" })
  timestamp!: string;
}
