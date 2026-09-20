CREATE TYPE "ExecutionRiskKind" AS ENUM (
  'PROTECTED_TIME_AT_RISK',
  'PROTECTED_TIME_INFEASIBLE',
  'FIXED_SERVICE_MISSED',
  'BUFFER_BELOW_SYSTEM_MINIMUM',
  'UNKNOWN_EXECUTION_MARGIN'
);

CREATE TYPE "ExecutionRiskSeverity" AS ENUM (
  'EXECUTABLE_RISK',
  'INFEASIBLE',
  'UNKNOWN'
);

CREATE TYPE "ExecutionRiskStatus" AS ENUM (
  'OPEN',
  'ACKNOWLEDGED',
  'SNOOZED',
  'RESOLVED'
);

CREATE TABLE "ExecutionRisk" (
  "id" UUID NOT NULL,
  "ownerUserId" UUID NOT NULL,
  "tripId" UUID NOT NULL,
  "fingerprint" VARCHAR(64) NOT NULL,
  "lifecycleGeneration" INTEGER NOT NULL DEFAULT 1,
  "kind" "ExecutionRiskKind" NOT NULL,
  "severity" "ExecutionRiskSeverity" NOT NULL,
  "status" "ExecutionRiskStatus" NOT NULL DEFAULT 'OPEN',
  "sourceNodeId" UUID,
  "sourceTransportEdgeId" UUID,
  "protectedNodeId" UUID,
  "protectedTransportEdgeId" UUID,
  "firstSeenAt" TIMESTAMPTZ(3) NOT NULL,
  "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,
  "acknowledgedAt" TIMESTAMPTZ(3),
  "snoozedUntil" TIMESTAMPTZ(3),
  "resolvedAt" TIMESTAMPTZ(3),
  "evaluationBasisTripVersion" INTEGER NOT NULL,
  "lastEvidenceHash" VARCHAR(64) NOT NULL,
  "evidenceRefs" JSONB NOT NULL,
  "requiresRouteReevaluation" BOOLEAN NOT NULL DEFAULT false,
  "notificationGeneration" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ExecutionRisk_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ExecutionRisk_lifecycle_generation_positive" CHECK ("lifecycleGeneration" > 0),
  CONSTRAINT "ExecutionRisk_notification_generation_nonnegative" CHECK ("notificationGeneration" >= 0),
  CONSTRAINT "ExecutionRisk_fingerprint_sha256" CHECK ("fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ExecutionRisk_evidence_hash_sha256" CHECK ("lastEvidenceHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ExecutionRisk_status_timestamps" CHECK (
    ("status" = 'OPEN' AND "resolvedAt" IS NULL)
    OR ("status" = 'ACKNOWLEDGED' AND "acknowledgedAt" IS NOT NULL AND "resolvedAt" IS NULL)
    OR ("status" = 'SNOOZED' AND "snoozedUntil" IS NOT NULL AND "resolvedAt" IS NULL)
    OR ("status" = 'RESOLVED' AND "resolvedAt" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "ExecutionRisk_owner_trip_fingerprint_generation_key"
  ON "ExecutionRisk"("ownerUserId", "tripId", "fingerprint", "lifecycleGeneration");
CREATE UNIQUE INDEX "ExecutionRisk_one_active_fingerprint_key"
  ON "ExecutionRisk"("ownerUserId", "tripId", "fingerprint")
  WHERE "resolvedAt" IS NULL;
CREATE INDEX "ExecutionRisk_owner_trip_status_last_seen_idx"
  ON "ExecutionRisk"("ownerUserId", "tripId", "status", "lastSeenAt" DESC);
CREATE INDEX "ExecutionRisk_trip_fingerprint_resolved_idx"
  ON "ExecutionRisk"("tripId", "fingerprint", "resolvedAt");

ALTER TABLE "ExecutionRisk"
  ADD CONSTRAINT "ExecutionRisk_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ExecutionRisk"
  ADD CONSTRAINT "ExecutionRisk_tripId_ownerUserId_fkey"
  FOREIGN KEY ("tripId", "ownerUserId") REFERENCES "Trip"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE CASCADE;
