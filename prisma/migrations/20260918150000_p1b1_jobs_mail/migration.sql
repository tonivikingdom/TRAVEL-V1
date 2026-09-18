CREATE TYPE "JobType" AS ENUM ('MAGIC_LINK_EMAIL');
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');
CREATE TYPE "MagicLinkDeliveryStatus" AS ENUM ('PENDING', 'TOKEN_READY', 'DELIVERED', 'NOOP');

CREATE TABLE "MagicLinkDeliveryRequest" (
  "id" UUID NOT NULL,
  "normalizedEmail" TEXT NOT NULL,
  "requestedEmail" TEXT NOT NULL,
  "requestedAt" TIMESTAMPTZ(3) NOT NULL,
  "status" "MagicLinkDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "tokenExpiresAt" TIMESTAMPTZ(3),
  "processedAt" TIMESTAMPTZ(3),
  CONSTRAINT "MagicLinkDeliveryRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Job" (
  "id" UUID NOT NULL,
  "type" "JobType" NOT NULL,
  "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
  "runAt" TIMESTAMPTZ(3) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL,
  "leaseOwner" VARCHAR(128),
  "leaseUntil" TIMESTAMPTZ(3),
  "uniqueKey" VARCHAR(200) NOT NULL,
  "payloadRef" UUID NOT NULL,
  "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
  "lastErrorCode" VARCHAR(64),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  "completedAt" TIMESTAMPTZ(3),
  "cancelledAt" TIMESTAMPTZ(3),
  CONSTRAINT "Job_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Job_attempts_check" CHECK ("attempts" >= 0 AND "attempts" <= "maxAttempts"),
  CONSTRAINT "Job_maxAttempts_check" CHECK ("maxAttempts" BETWEEN 1 AND 100),
  CONSTRAINT "Job_lease_pair_check" CHECK (("leaseOwner" IS NULL) = ("leaseUntil" IS NULL)),
  CONSTRAINT "Job_running_lease_check" CHECK (
    ("status" = 'RUNNING') = ("leaseOwner" IS NOT NULL)
  ),
  CONSTRAINT "Job_terminal_lease_check" CHECK (
    "status" NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
    OR ("leaseOwner" IS NULL AND "leaseUntil" IS NULL)
  )
);

ALTER TABLE "MagicLinkToken" ADD COLUMN "deliveryRequestId" UUID;

CREATE UNIQUE INDEX "MagicLinkToken_deliveryRequestId_key" ON "MagicLinkToken"("deliveryRequestId");
CREATE INDEX "MagicLinkDeliveryRequest_status_requestedAt_idx" ON "MagicLinkDeliveryRequest"("status", "requestedAt");
CREATE UNIQUE INDEX "Job_uniqueKey_key" ON "Job"("uniqueKey");
CREATE INDEX "Job_status_runAt_leaseUntil_idx" ON "Job"("status", "runAt", "leaseUntil");
CREATE INDEX "Job_payloadRef_idx" ON "Job"("payloadRef");

ALTER TABLE "MagicLinkToken"
  ADD CONSTRAINT "MagicLinkToken_deliveryRequestId_fkey"
  FOREIGN KEY ("deliveryRequestId") REFERENCES "MagicLinkDeliveryRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
