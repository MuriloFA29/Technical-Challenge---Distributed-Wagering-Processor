import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from "class-validator";
import { WagerTransactionKind } from "../../domain/entities/wager-transaction";
import { MoneyDto } from "./money.dto";

const trimString = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;

export class SubmitTransactionDto {
  @ApiProperty({ example: "provider-a", description: "Game provider identifier" })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  providerId!: string;

  @ApiProperty({ example: "ext-bet-1", description: "Provider-unique external transaction ID" })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  externalTransactionId!: string;

  @ApiProperty({ example: "player-123", description: "Player identifier" })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  playerId!: string;

  @ApiProperty({ example: "0195a1b2-0000-7000-8000-000000000001", description: "Wallet ID" })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  walletId!: string;

  @ApiProperty({ example: "round-1", description: "Game round identifier" })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  roundId!: string;

  @ApiProperty({ example: "game-slots-1", description: "Game identifier" })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  gameId!: string;

  @ApiProperty({
    enum: WagerTransactionKind,
    example: WagerTransactionKind.Bet,
    description: "Transaction kind (BET, WIN, LOSS, REFUND, ROLLBACK)",
  })
  @IsEnum(WagerTransactionKind)
  kind!: WagerTransactionKind;

  @ApiProperty({ type: () => MoneyDto, description: "Transaction amount and currency" })
  @IsObject()
  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @ApiPropertyOptional({
    example: "ext-bet-1",
    description: "Referenced external transaction ID (required for REFUND and ROLLBACK)",
  })
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  referenceExternalTransactionId?: string;
}
