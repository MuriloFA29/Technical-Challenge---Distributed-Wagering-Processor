import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, Length, Matches } from "class-validator";

export class MoneyDto {
  @ApiProperty({
    example: "100.00",
    description: "Decimal monetary amount as string (up to 2 decimal places)",
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^-?\d+(\.\d{1,2})?$/, {
    message: "amount must be a valid decimal string with up to 2 decimal places",
  })
  amount!: string;

  @ApiProperty({
    example: "USD",
    description: "ISO-4217 3-letter currency code",
  })
  @IsString()
  @Length(3, 3, { message: "currency must be a 3-letter ISO-4217 code" })
  currency!: string;
}
