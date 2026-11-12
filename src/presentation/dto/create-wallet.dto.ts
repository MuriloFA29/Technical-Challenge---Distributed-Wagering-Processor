import { ApiProperty } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { IsNotEmpty, IsObject, IsString, ValidateNested } from "class-validator";
import { MoneyDto } from "./money.dto";

export class CreateWalletDto {
  @ApiProperty({
    example: "player-123",
    description: "External player identifier",
  })
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
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
