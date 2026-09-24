import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateUserDto {
  @ApiProperty({ example: 'Ali' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Matches(/\S/)
  name!: string;
}

export class CreditDto {
  @ApiProperty({
    example: '1000',
    description: 'Positive integer string, smallest credit unit; max 15 digits',
  })
  @IsString()
  @Matches(/^[1-9][0-9]{0,14}$/)
  amount!: string;

  @ApiProperty({ example: 'TOPUP-001' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Matches(/\S/)
  reference!: string;
}

export class PaymentDto extends CreditDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  userId!: string;

  @ApiProperty({ example: 'Invoice payment' })
  @IsString()
  @MaxLength(500)
  description!: string;
}

export class PageDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000000)
  page = 1;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}

export class ReportDto {
  @ApiPropertyOptional({ enum: ['day', 'month', 'year'], default: 'day' })
  @IsOptional()
  @IsIn(['day', 'month', 'year'])
  period: 'day' | 'month' | 'year' = 'day';

  @ApiPropertyOptional({ example: '2026-09-01T00:00:00.000Z' })
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(/Z$/)
  from?: string;

  @ApiPropertyOptional({ example: '2026-10-01T00:00:00.000Z' })
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(/Z$/)
  to?: string;
}
