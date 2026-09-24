# Asynchronous User Credit Payments

NestJS + TypeScript, PostgreSQL + Prisma, RabbitMQ, Redis. Includes a small admin panel, Swagger, automatic technical retries and a durable payment dispatcher.

## Quick start (Docker)

Install and start Docker Desktop. From this directory:

```sh
cp .env.example .env
docker compose up --build -d
docker compose exec api npm run db:seed
docker compose ps
```

PowerShell: use `Copy-Item .env.example .env` instead of `cp` if needed. Only Docker is needed for this path; Node runs inside the image. Initial build downloads dependencies and can take several minutes.

- Admin: http://localhost:3000/admin/
- Swagger: http://localhost:3000/docs
- Readiness: http://localhost:3000/readyz
- RabbitMQ management: http://localhost:15672 (`credit` / `credit_local`)
- Local demo API key: `local-development-key-change-me` (from `.env`; enter it in Admin or Swagger's Authorize dialog).
- Seed user: `11111111-1111-4111-8111-111111111111`, initial credit `100000`. Re-running the seed does not add credit again.

All `/api` routes require `X-API-Key`. This is a trusted/admin service with one shared key, not an end-user login system. Compose publishes ports on localhost only; the example credentials are for local use.

## Test a payment

The curl examples use Bash/zsh syntax. On Windows, use Git Bash or try the same requests through Swagger instead.

Amounts are **positive integer strings** in an abstract smallest credit unit, max 15 digits. Responses also use strings for amounts and balances. There is no bank gateway or currency conversion.

```sh
curl -X POST http://localhost:3000/api/payments \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: local-development-key-change-me' \
  -H 'Idempotency-Key: demo-payment-001' \
  -d '{"userId":"11111111-1111-4111-8111-111111111111","amount":"300","reference":"INV-001","description":"Demo payment"}'
```

This returns HTTP `202` and a payment `id`. It means accepted, not paid. Replace `<payment-id>` below with the returned ID:

```sh
curl http://localhost:3000/api/payments/<payment-id> -H 'X-API-Key: local-development-key-change-me'
curl http://localhost:3000/api/payments/<payment-id>/events -H 'X-API-Key: local-development-key-change-me'
curl http://localhost:3000/api/users/11111111-1111-4111-8111-111111111111/balance -H 'X-API-Key: local-development-key-change-me'
```

Run the first POST again with exactly the same key and body: same ID, no extra debit. Reuse that key with a different body: HTTP `409`.

To recharge:

```sh
curl -X POST http://localhost:3000/api/users/11111111-1111-4111-8111-111111111111/credits \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: local-development-key-change-me' \
  -H 'Idempotency-Key: demo-credit-001' \
  -d '{"amount":"1000","reference":"TOPUP-001"}'
```

Use a new idempotency key for each genuinely new payment/credit. Keys are globally unique within payments and, separately, credits.

## Automated tests

Against the running Docker stack:

```sh
docker compose exec api npm test
docker compose exec api npm run test:integration
docker compose exec api npm run test:e2e
```

- Unit: amount validation, exact serialization, failure simulation and retry policy.
- Integration: real PostgreSQL; creates and drops a unique test schema, without changing application tables. Covers concurrent spending, duplicate deliveries, duplicate API requests, retry rules, rollback after debit, dispatch recovery, reports and DB constraints.
- End-to-end: live HTTP API + RabbitMQ Worker + PostgreSQL + Redis. Checks successful payment, transient retry, forced failure, insufficient funds, idempotency, auth and validation. Creates a demo account retained for Admin inspection. Run with `SIMULATION_ENABLED=false` and `MAX_ATTEMPTS=3`.

## Manual scenarios

Submit payments with new keys and the following references:

| Scenario | Input / expected result |
| --- | --- |
| Success | `INV-001`, sufficient balance → `SUCCEEDED`, one debit |
| Insufficient funds | Amount larger than balance → `FAILED`, `INSUFFICIENT_FUNDS`, one attempt, no debit |
| Forced technical failure | Reference containing `FAIL` (case-insensitive) → failure until attempt budget exhausted |
| Temporary failure | Reference starting `RETRY-ONCE` → first attempt fails, second succeeds |
| Random simulation | Set `SIMULATION_ENABLED=true`, recreate Worker; probability increases with amount, capped at 50% |
| Worker offline | `docker compose stop worker`, submit payment, then `docker compose start worker` → eventual processing |
| Broker offline | Stop RabbitMQ, submit, start RabbitMQ again → pending/stale requests are dispatched after recovery |

Default `MAX_ATTEMPTS=3` means **3 total attempts**, with 1s then 2s retry delays, plus the polling interval. Insufficient funds never retries automatically; recharge and create a new payment with a new key. `CANCELLED` is optional in the specification and is not implemented.

`FAILED` with `nextAttemptAt` means a technical retry is scheduled. `FAILED` with `nextAttemptAt=null` is final. `retryable=true` describes the error category; the attempt budget may still be exhausted.

## API / reports

| Method | Path |
| --- | --- |
| POST / GET | `/api/users` |
| GET | `/api/users/:id`, `/api/users/:id/balance` |
| POST | `/api/users/:id/credits` (Idempotency-Key required) |
| GET | `/api/users/:id/transactions?page=1&limit=20` |
| POST | `/api/payments` (Idempotency-Key required) |
| GET | `/api/payments/:id`, `/api/payments/:id/events?page=1&limit=20` |
| GET | `/api/admin/reports?period=day` (`day`, `month`, `year`) |
| GET | `/api/admin/users/:id/usage` |

Reports accept `from` and `to` as UTC ISO strings ending in `Z`, e.g. `2026-09-01T00:00:00.000Z`. The interval is `[from, to)` and defaults to the current UTC month through now. Totals contain actual CREDIT/DEBIT transactions; failed payments do not count. Current balance in account details is not a historical period-end balance. Lists are paginated; `limit` is at most 100.

## Local development (Node 24)

```sh
cp .env.example .env
npm ci
docker compose up -d postgres rabbitmq redis
npm run db:generate
npm run db:migrate
npm run db:seed
npm run start:dev
```

In another terminal in this directory: `npm run worker:dev`. Do not run a second API on port 3000 while the Compose API is running. Tests also work locally with `npm test`, `npm run test:integration`, `npm run test:e2e`.

## Operations / design

- `docker compose logs -f api worker`: inspect service logs.
- `docker compose up -d --build`: rebuild after code changes; `--force-recreate worker` applies changed Worker environment settings.
- `docker compose down`: stop services; named volumes retain data. Adding `-v` deletes the local database and queue volumes.
- PostgreSQL is authoritative. Balance updates, debit records, final payment state and events commit together. Payment row locks serialize duplicates, user row locks serialize competing spends, and unique debit constraints add protection.
- The payment table doubles as a durable dispatch list. Stale `QUEUED` rows are republished after 10 seconds. Duplicate delivery is expected and safe. Publisher confirms plus manual consumer acknowledgements are used.
- `PROCESSING` is inside the short financial transaction; external polling normally sees `QUEUED` then a final result. History retains `PROCESSING_STARTED` after commit. No external payment call is made while holding locks.
- Redis provides rate limiting (120 authorized requests/minute/IP). It fails open during Redis outages; money correctness does not depend on Redis. `/readyz` reports Redis degradation but returns 200 if PostgreSQL is ready. It does not assert Worker health.
- Versions are locked in `package-lock.json`; Prisma 6.19 uses `prisma-client-js` and schema-based connection configuration. Do not mix in Prisma 7+ setup instructions without migrating the project.
- `npm run format:check` checks code formatting; `npm run format` applies it. Security overrides pin patched transitive versions of multer, deepmerge-ts and effect; migration/build/integration tests validate compatibility.

## شروع سریع فارسی

Docker Desktop را اجرا کنید، فایل `.env.example` را به `.env` کپی کنید و دستورهای بخش Quick start را بزنید. پنل در `/admin/` و مستندات قابل آزمایش در `/docs` هستند. کلید نمونه را از همین README وارد کنید. مثال‌های بالا برای پرداخت و شارژ قابل اجرا هستند؛ مبلغ را رشتهٔ عدد صحیح بفرستید، مثل `"300"`.

برای آزمایش کامل، سه دستور بخش Automated tests را اجرا کنید. آموزش مفصل فارسی و انگلیسی عمداً خارج از این پروژه، در پوشهٔ هم‌سطح `learning` قرار دارد.
