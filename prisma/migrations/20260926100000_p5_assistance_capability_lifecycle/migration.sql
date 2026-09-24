CREATE TYPE "AssistanceState" AS ENUM ('ENABLED', 'PAUSED', 'STOPPED');
CREATE TYPE "AssistanceStopReason" AS ENUM ('USER', 'NATURAL_END');
CREATE TYPE "TripAssistanceKind" AS ENUM ('LOCATION_ASSISTANCE', 'AUTO_RECORD');
CREATE TYPE "AssistanceAction" AS ENUM ('ENABLE', 'PAUSE', 'RESUME', 'STOP', 'NATURAL_END');

ALTER TABLE "Job" ADD COLUMN "capabilityRevision" INTEGER;

CREATE TABLE "TripAssistanceCapability" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "ownerUserId" UUID NOT NULL,
  "tripId" UUID NOT NULL,
  "kind" "TripAssistanceKind" NOT NULL,
  "state" "AssistanceState" NOT NULL,
  "revision" INTEGER NOT NULL,
  "enabledAt" TIMESTAMPTZ(3),
  "resumedAt" TIMESTAMPTZ(3),
  "pausedAt" TIMESTAMPTZ(3),
  "stoppedAt" TIMESTAMPTZ(3),
  "stopReason" "AssistanceStopReason",
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TripAssistanceCapability_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TripAssistanceCapability_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "TripAssistanceCapability_stop_reason_check" CHECK (
    ("state" = 'STOPPED' AND "stopReason" IS NOT NULL AND "stoppedAt" IS NOT NULL)
    OR ("state" <> 'STOPPED' AND "stopReason" IS NULL)
  )
);

CREATE UNIQUE INDEX "TripAssistanceCapability_tripId_kind_key"
  ON "TripAssistanceCapability"("tripId", "kind");
CREATE UNIQUE INDEX "TripAssistanceCapability_id_ownerUserId_key"
  ON "TripAssistanceCapability"("id", "ownerUserId");
CREATE INDEX "TripAssistanceCapability_ownerUserId_tripId_idx"
  ON "TripAssistanceCapability"("ownerUserId", "tripId");

ALTER TABLE "TripAssistanceCapability"
  ADD CONSTRAINT "TripAssistanceCapability_tripId_ownerUserId_fkey"
  FOREIGN KEY ("tripId", "ownerUserId") REFERENCES "Trip"("id", "ownerUserId")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "FlightMonitoringCapability" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "ownerUserId" UUID NOT NULL,
  "tripId" UUID NOT NULL,
  "flightBindingId" UUID NOT NULL,
  "state" "AssistanceState" NOT NULL,
  "revision" INTEGER NOT NULL,
  "enabledAt" TIMESTAMPTZ(3),
  "resumedAt" TIMESTAMPTZ(3),
  "pausedAt" TIMESTAMPTZ(3),
  "stoppedAt" TIMESTAMPTZ(3),
  "stopReason" "AssistanceStopReason",
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FlightMonitoringCapability_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FlightMonitoringCapability_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "FlightMonitoringCapability_stop_reason_check" CHECK (
    ("state" = 'STOPPED' AND "stopReason" IS NOT NULL AND "stoppedAt" IS NOT NULL)
    OR ("state" <> 'STOPPED' AND "stopReason" IS NULL)
  )
);

CREATE UNIQUE INDEX "FlightMonitoringCapability_flightBindingId_key"
  ON "FlightMonitoringCapability"("flightBindingId");
CREATE UNIQUE INDEX "FlightMonitoringCapability_id_ownerUserId_key"
  ON "FlightMonitoringCapability"("id", "ownerUserId");
CREATE UNIQUE INDEX "FlightMonitoringCapability_flightBindingId_tripId_ownerUserId_key"
  ON "FlightMonitoringCapability"("flightBindingId", "tripId", "ownerUserId");
CREATE INDEX "FlightMonitoringCapability_ownerUserId_tripId_idx"
  ON "FlightMonitoringCapability"("ownerUserId", "tripId");

ALTER TABLE "FlightMonitoringCapability"
  ADD CONSTRAINT "FlightMonitoringCapability_flightBindingId_tripId_ownerUserId_fkey"
  FOREIGN KEY ("flightBindingId", "tripId", "ownerUserId")
  REFERENCES "FlightBinding"("id", "tripId", "ownerUserId")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TripAssistanceReceipt" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "ownerUserId" UUID NOT NULL,
  "capabilityId" UUID NOT NULL,
  "idempotencyKey" VARCHAR(200) NOT NULL,
  "requestHash" VARCHAR(64) NOT NULL,
  "action" "AssistanceAction" NOT NULL,
  "baseRevision" INTEGER NOT NULL,
  "resultingRevision" INTEGER NOT NULL,
  "resultingState" "AssistanceState" NOT NULL,
  "resultingStopReason" "AssistanceStopReason",
  "resultPayload" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TripAssistanceReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TripAssistanceReceipt_ownerUserId_idempotencyKey_key"
  ON "TripAssistanceReceipt"("ownerUserId", "idempotencyKey");
CREATE INDEX "TripAssistanceReceipt_capabilityId_createdAt_idx"
  ON "TripAssistanceReceipt"("capabilityId", "createdAt");
ALTER TABLE "TripAssistanceReceipt"
  ADD CONSTRAINT "TripAssistanceReceipt_capabilityId_ownerUserId_fkey"
  FOREIGN KEY ("capabilityId", "ownerUserId")
  REFERENCES "TripAssistanceCapability"("id", "ownerUserId")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "FlightAssistanceReceipt" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "ownerUserId" UUID NOT NULL,
  "capabilityId" UUID NOT NULL,
  "idempotencyKey" VARCHAR(200) NOT NULL,
  "requestHash" VARCHAR(64) NOT NULL,
  "action" "AssistanceAction" NOT NULL,
  "baseRevision" INTEGER NOT NULL,
  "resultingRevision" INTEGER NOT NULL,
  "resultingState" "AssistanceState" NOT NULL,
  "resultingStopReason" "AssistanceStopReason",
  "resultPayload" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FlightAssistanceReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FlightAssistanceReceipt_ownerUserId_idempotencyKey_key"
  ON "FlightAssistanceReceipt"("ownerUserId", "idempotencyKey");
CREATE INDEX "FlightAssistanceReceipt_capabilityId_createdAt_idx"
  ON "FlightAssistanceReceipt"("capabilityId", "createdAt");
ALTER TABLE "FlightAssistanceReceipt"
  ADD CONSTRAINT "FlightAssistanceReceipt_capabilityId_ownerUserId_fkey"
  FOREIGN KEY ("capabilityId", "ownerUserId")
  REFERENCES "FlightMonitoringCapability"("id", "ownerUserId")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing trips and flight bindings deliberately receive no capability rows:
-- absence is the authoritative NOT_ENABLED state. Legacy monitor jobs therefore
-- retain a NULL capabilityRevision and are fenced to a runtime no-op.
