ALTER TYPE "JobType" ADD VALUE 'GROUND_TRANSIT_MONITOR';
ALTER TYPE "TripAssistanceKind" ADD VALUE 'GROUND_TRANSIT_MONITORING';

CREATE TYPE "GroundTransitServiceClass" AS ENUM ('FIXED_SERVICE', 'HIGH_FREQUENCY');
CREATE TYPE "GroundTransitLegState" AS ENUM (
  'PENDING', 'IN_PROGRESS', 'ARRIVED_PENDING_HANDOFF',
  'COMPLETED', 'NO_LONGER_FEASIBLE', 'UNKNOWN'
);

CREATE TABLE "GroundTransitLegExecution" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tripId" UUID NOT NULL,
  "adoptedRouteId" UUID NOT NULL,
  "transportEdgeId" UUID NOT NULL,
  "legIndex" INTEGER NOT NULL,
  "provider" VARCHAR(100) NOT NULL,
  "mode" "TransportMode" NOT NULL,
  "serviceClass" "GroundTransitServiceClass",
  "serviceIdentityKey" VARCHAR(300),
  "baseline" JSONB NOT NULL,
  "state" "GroundTransitLegState" NOT NULL DEFAULT 'PENDING',
  "latestFetchedAt" TIMESTAMPTZ(3),
  "latestObservationId" VARCHAR(300),
  "latestObservationHash" VARCHAR(64),
  "latestObservation" JSONB,
  "deviationStartedAt" TIMESTAMPTZ(3),
  "deviationCount" INTEGER NOT NULL DEFAULT 0,
  "nextCheckAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GroundTransitLegExecution_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GroundTransitLegExecution_mode_check" CHECK ("mode" IN ('RAIL', 'BUS')),
  CONSTRAINT "GroundTransitLegExecution_legIndex_check" CHECK ("legIndex" >= 0),
  CONSTRAINT "GroundTransitLegExecution_deviationCount_check" CHECK ("deviationCount" >= 0)
);
CREATE UNIQUE INDEX "GroundTransitLegExecution_transportEdgeId_key"
  ON "GroundTransitLegExecution"("transportEdgeId");
CREATE INDEX "GroundTransitLegExecution_tripId_state_idx"
  ON "GroundTransitLegExecution"("tripId", "state");
CREATE INDEX "GroundTransitLegExecution_tripId_nextCheckAt_idx"
  ON "GroundTransitLegExecution"("tripId", "nextCheckAt");
ALTER TABLE "GroundTransitLegExecution"
  ADD CONSTRAINT "GroundTransitLegExecution_tripId_fkey"
  FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GroundTransitLegExecution"
  ADD CONSTRAINT "GroundTransitLegExecution_adoptedRouteId_tripId_fkey"
  FOREIGN KEY ("adoptedRouteId", "tripId") REFERENCES "AdoptedRoute"("id", "tripId")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "GroundTransitObservation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "legExecutionId" UUID NOT NULL,
  "observationIdentity" VARCHAR(300) NOT NULL,
  "fetchedAt" TIMESTAMPTZ(3) NOT NULL,
  "factsHash" VARCHAR(64) NOT NULL,
  "facts" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GroundTransitObservation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GroundTransitObservation_legExecutionId_observationIdentity_key"
  ON "GroundTransitObservation"("legExecutionId", "observationIdentity");
CREATE INDEX "GroundTransitObservation_legExecutionId_fetchedAt_idx"
  ON "GroundTransitObservation"("legExecutionId", "fetchedAt" DESC);
ALTER TABLE "GroundTransitObservation"
  ADD CONSTRAINT "GroundTransitObservation_legExecutionId_fkey"
  FOREIGN KEY ("legExecutionId") REFERENCES "GroundTransitLegExecution"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "GroundTransitStateTransition" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "legExecutionId" UUID NOT NULL,
  "fromState" "GroundTransitLegState",
  "toState" "GroundTransitLegState" NOT NULL,
  "source" VARCHAR(40) NOT NULL,
  "evidenceRef" VARCHAR(300) NOT NULL,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "GroundTransitStateTransition_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "GroundTransitStateTransition_legExecutionId_occurredAt_idx"
  ON "GroundTransitStateTransition"("legExecutionId", "occurredAt");
ALTER TABLE "GroundTransitStateTransition"
  ADD CONSTRAINT "GroundTransitStateTransition_legExecutionId_fkey"
  FOREIGN KEY ("legExecutionId") REFERENCES "GroundTransitLegExecution"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing adopted routes and Trip capabilities are deliberately not backfilled.
-- Their missing metadata and opt-in remain UNKNOWN / NOT_ENABLED respectively.
