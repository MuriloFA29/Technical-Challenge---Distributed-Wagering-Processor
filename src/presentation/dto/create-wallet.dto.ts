import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsNotEmpty, IsObject, IsString, ValidateNested } from "class-validator";
import { MoneyDto } from "./money.dto";

export class CreateWalletDto {
  @ApiProperty({
    example: "player-123",
    description: "External player identifier",
  })
  @IsString()
  @IsNotEmpty()
  playerId!: string;

  @ApiProperty({
    type: () => MoneyDto,
    description: "Initial wallet balance",
  })
  @IsObject()
  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}
