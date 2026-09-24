import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { CreateUserDto, CreditDto, PageDto, PaymentDto, ReportDto } from './dto';
import { idempotencyKey, LedgerService } from './ledger.service';
import { ApiGuard } from './security';

@ApiTags('Credit payments')
@ApiSecurity('api-key')
@UseGuards(ApiGuard)
@Controller('api')
export class ApiController {
  constructor(private readonly ledger: LedgerService) {}

  @Post('users') createUser(@Body() body: CreateUserDto) {
    return this.ledger.createUser(body.name);
  }
  @Get('users') users(@Query() query: PageDto) {
    return this.ledger.users(query);
  }
  @Get('users/:id') user(@Param('id', ParseUUIDPipe) id: string) {
    return this.ledger.user(id);
  }
  @Get('users/:id/balance') balance(@Param('id', ParseUUIDPipe) id: string) {
    return this.ledger.user(id);
  }
  @Post('users/:id/credits')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  credit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreditDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.ledger.credit(id, body, idempotencyKey(key));
  }
  @Get('users/:id/transactions') transactions(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: PageDto,
  ) {
    return this.ledger.transactions(id, query);
  }
  @Post('payments')
  @HttpCode(202)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  payment(@Body() body: PaymentDto, @Headers('idempotency-key') key?: string) {
    return this.ledger.submit(body, idempotencyKey(key));
  }
  @Get('payments/:id') getPayment(@Param('id', ParseUUIDPipe) id: string) {
    return this.ledger.payment(id);
  }
  @Get('payments/:id/events') events(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: PageDto,
  ) {
    return this.ledger.events(id, query);
  }
  @Get('admin/reports') report(@Query() query: ReportDto) {
    return this.ledger.report(query);
  }
  @Get('admin/users/:id/usage') usage(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ReportDto,
  ) {
    return this.ledger.usage(id, query);
  }
}
