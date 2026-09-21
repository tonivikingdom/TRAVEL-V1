ALTER TYPE "TemporalSourceKind" ADD VALUE 'EXECUTION_OBSERVATION';

CREATE TYPE "ExecutionEventType" AS ENUM ('ARRIVAL', 'DEPARTURE', 'SKIP_CONFIRMED');
CREATE TYPE "ExecutionEventSource" AS ENUM ('LOCATION', 'MANUAL');
CREATE TYPE "NodeExecutionStatus" AS ENUM ('POSSIBLY_SKIPPED', 'SKIPPED');
CREATE TYPE "ExecutionLocationStatus" AS ENUM ('RELIABLE', 'INDETERMINATE');

CREATE TABLE "ExecutionEvent" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "ownerUserId" UUID NOT NULL,
  "tripId" UUID NOT NULL,
  "nodeId" UUID NOT NULL,
  "type" "ExecutionEventType" NOT NULL,
  "source" "ExecutionEventSource" NOT NULL,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL,
  "idempotencyKey" VARCHAR(200),
  "requestHash" VARCHAR(64),
  "undoneAt" TIMESTAMPTZ(3),
  "undoIdempotencyKey" VARCHAR(200),
  "undoRequestHash" VARCHAR(64),
  "airportTriggerCompletedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExecutionEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ExecutionEvent_request_pair_check"
    CHECK (("idempotencyKey" IS NULL) = ("requestHash" IS NULL)),
  CONSTRAINT "ExecutionEvent_undo_pair_check"
    CHECK (("undoIdempotencyKey" IS NULL) = ("undoRequestHash" IS NULL)),
  CONSTRAINT "ExecutionEvent_undo_time_check"
    CHECK ("undoneAt" IS NULL OR "undoneAt" >= "createdAt")
);

CREATE TABLE "ExecutionLocationState" (
  "tripId" UUID NOT NULL,
  "currentNodeId" UUID,
  "targetNodeId" UUID,
  "lastObservedAt" TIMESTAMPTZ(3) NOT NULL,
  "lastDistanceToCurrentTargetMeters" DOUBLE PRECISION,
  "lastDistanceToNextTargetMeters" DOUBLE PRECISION,
  "outsideTargetConsecutiveCount" INTEGER NOT NULL DEFAULT 0,
  "locationStatus" "ExecutionLocationStatus" NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ExecutionLocationState_pkey" PRIMARY KEY ("tripId"),
  CONSTRAINT "ExecutionLocationState_distance_check" CHECK (
    ("lastDistanceToCurrentTargetMeters" IS NULL OR "lastDistanceToCurrentTargetMeters" >= 0)
    AND ("lastDistanceToNextTargetMeters" IS NULL OR "lastDistanceToNextTargetMeters" >= 0)
  ),
  CONSTRAINT "ExecutionLocationState_count_check"
    CHECK ("outsideTargetConsecutiveCount" >= 0)
);

CREATE TABLE "NodeExecutionState" (
  "nodeId" UUID NOT NULL,
  "tripId" UUID NOT NULL,
  "status" "NodeExecutionStatus" NOT NULL,
  "detectedByEventId" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "NodeExecutionState_pkey" PRIMARY KEY ("nodeId")
);

CREATE UNIQUE INDEX "ExecutionEvent_ownerUserId_idempotencyKey_key"
  ON "ExecutionEvent"("ownerUserId", "idempotencyKey");
CREATE UNIQUE INDEX "ExecutionEvent_ownerUserId_undoIdempotencyKey_key"
  ON "ExecutionEvent"("ownerUserId", "undoIdempotencyKey");
CREATE UNIQUE INDEX "ExecutionEvent_id_tripId_key"
  ON "ExecutionEvent"("id", "tripId");
CREATE INDEX "ExecutionEvent_owner_trip_created_idx"
  ON "ExecutionEvent"("ownerUserId", "tripId", "createdAt" DESC);
CREATE INDEX "ExecutionEvent_trip_node_type_undone_idx"
  ON "ExecutionEvent"("tripId", "nodeId", "type", "undoneAt");
CREATE UNIQUE INDEX "ExecutionEvent_one_active_fact_per_node_type"
  ON "ExecutionEvent"("tripId", "nodeId", "type")
  WHERE "undoneAt" IS NULL;

CREATE INDEX "ExecutionLocationState_currentNodeId_idx"
  ON "ExecutionLocationState"("currentNodeId");
CREATE INDEX "ExecutionLocationState_targetNodeId_idx"
  ON "ExecutionLocationState"("targetNodeId");

CREATE UNIQUE INDEX "NodeExecutionState_nodeId_tripId_key"
  ON "NodeExecutionState"("nodeId", "tripId");
CREATE INDEX "NodeExecutionState_tripId_status_idx"
  ON "NodeExecutionState"("tripId", "status");
CREATE INDEX "NodeExecutionState_detectedByEventId_idx"
  ON "NodeExecutionState"("detectedByEventId");

ALTER TABLE "ExecutionEvent"
  ADD CONSTRAINT "ExecutionEvent_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExecutionEvent"
  ADD CONSTRAINT "ExecutionEvent_tripId_ownerUserId_fkey"
  FOREIGN KEY ("tripId", "ownerUserId") REFERENCES "Trip"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExecutionEvent"
  ADD CONSTRAINT "ExecutionEvent_nodeId_tripId_fkey"
  FOREIGN KEY ("nodeId", "tripId") REFERENCES "ItineraryNode"("id", "tripId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ExecutionLocationState"
  ADD CONSTRAINT "ExecutionLocationState_tripId_fkey"
  FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExecutionLocationState"
  ADD CONSTRAINT "ExecutionLocationState_currentNodeId_fkey"
  FOREIGN KEY ("currentNodeId", "tripId") REFERENCES "ItineraryNode"("id", "tripId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExecutionLocationState"
  ADD CONSTRAINT "ExecutionLocationState_targetNodeId_fkey"
  FOREIGN KEY ("targetNodeId", "tripId") REFERENCES "ItineraryNode"("id", "tripId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NodeExecutionState"
  ADD CONSTRAINT "NodeExecutionState_nodeId_tripId_fkey"
  FOREIGN KEY ("nodeId", "tripId") REFERENCES "ItineraryNode"("id", "tripId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NodeExecutionState"
  ADD CONSTRAINT "NodeExecutionState_detectedByEventId_fkey"
  FOREIGN KEY ("detectedByEventId") REFERENCES "ExecutionEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
