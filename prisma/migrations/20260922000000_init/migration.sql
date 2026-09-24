-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'QUEUED', 'PROCESSING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('CREDIT', 'DEBIT');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "balance" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_requests" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "reference" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "idempotency_key" VARCHAR(100) NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "failure_code" TEXT,
    "failure_reason" TEXT,
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "next_attempt_at" TIMESTAMPTZ(3),
    "last_published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "payment_id" UUID,
    "idempotency_key" VARCHAR(100),
    "type" "TransactionType" NOT NULL,
    "amount" BIGINT NOT NULL,
    "reference" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_events" (
    "id" BIGSERIAL NOT NULL,
    "payment_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "details" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_requests_idempotency_key_key" ON "payment_requests"("idempotency_key");

-- CreateIndex
CREATE INDEX "payment_requests_status_next_attempt_at_last_published_at_idx" ON "payment_requests"("status", "next_attempt_at", "last_published_at");

-- CreateIndex
CREATE INDEX "payment_requests_user_id_created_at_idx" ON "payment_requests"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_payment_id_key" ON "transactions"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_idempotency_key_key" ON "transactions"("idempotency_key");

-- CreateIndex
CREATE INDEX "transactions_user_id_created_at_idx" ON "transactions"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "transactions_created_at_type_idx" ON "transactions"("created_at", "type");

-- CreateIndex
CREATE INDEX "payment_events_payment_id_id_idx" ON "payment_events"("payment_id", "id");

-- AddForeignKey
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payment_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payment_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Financial invariants live in PostgreSQL as well as application code.
ALTER TABLE users ADD CONSTRAINT users_balance_nonnegative CHECK (balance >= 0);
ALTER TABLE payment_requests ADD CONSTRAINT payment_amount_positive CHECK (amount > 0);
ALTER TABLE payment_requests ADD CONSTRAINT payment_attempts_nonnegative CHECK (attempts >= 0);
ALTER TABLE transactions ADD CONSTRAINT transaction_amount_positive CHECK (amount > 0);
ALTER TABLE transactions ADD CONSTRAINT transaction_kind_fields CHECK (
  (type = 'DEBIT' AND payment_id IS NOT NULL AND idempotency_key IS NULL) OR
  (type = 'CREDIT' AND payment_id IS NULL AND idempotency_key IS NOT NULL)
);
