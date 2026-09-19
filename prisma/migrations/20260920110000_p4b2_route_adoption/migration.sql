ALTER TYPE "ItineraryNodeSource" ADD VALUE 'ROUTE_GENERATED';
ALTER TYPE "TransportSource" ADD VALUE 'ADOPTED_ROUTE';

CREATE TYPE "AdoptedRouteStatus" AS ENUM ('ACTIVE', 'REPLACED');
CREATE TYPE "TransportDayProjectionRole" AS ENUM ('SAME_DAY', 'START', 'OCCUPIED', 'END');
CREATE TYPE "OperationType" AS ENUM ('ROUTE_ADOPT');
CREATE TYPE "OutboxEventType" AS ENUM ('ROUTE_ADOPTED');

ALTER TABLE "RoutePreview" ADD COLUMN "previewHash" VARCHAR(64);

ALTER TABLE "ItineraryNode"
  ADD COLUMN "adoptedRouteId" UUID,
  ADD COLUMN "provider" VARCHAR(100),
  ADD COLUMN "providerPlaceRef" VARCHAR(300),
  ADD COLUMN "providerHubRef" VARCHAR(300),
  ADD COLUMN "sourceOperationId" UUID,
  ADD COLUMN "autoReplaceable" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "userModifiedAt" TIMESTAMPTZ(3);

ALTER TABLE "TransportEdge"
  ADD COLUMN "adoptedRouteId" UUID,
  ADD COLUMN "provider" VARCHAR(100),
  ADD COLUMN "providerRef" VARCHAR(300);

ALTER TABLE "TransportEdgeHistory"
  ADD COLUMN "adoptedRouteId" UUID,
  ADD COLUMN "provider" VARCHAR(100),
  ADD COLUMN "providerRef" VARCHAR(300);

CREATE TABLE "AdoptedRoute" (
  "id" UUID NOT NULL,
  "tripId" UUID NOT NULL,
  "anchorFromNodeId" UUID NOT NULL,
  "anchorToNodeId" UUID NOT NULL,
  "sourcePreviewId" UUID NOT NULL,
  "candidateSnapshotId" UUID NOT NULL,
  "candidateHash" VARCHAR(64) NOT NULL,
  "policyVersion" VARCHAR(100) NOT NULL,
  "status" "AdoptedRouteStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "replacedAt" TIMESTAMPTZ(3),
  CONSTRAINT "AdoptedRoute_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdoptedRoute_sourcePreviewId_key" ON "AdoptedRoute"("sourcePreviewId");
CREATE UNIQUE INDEX "AdoptedRoute_id_tripId_key" ON "AdoptedRoute"("id", "tripId");
CREATE INDEX "AdoptedRoute_tripId_status_anchorFromNodeId_anchorToNodeId_idx"
  ON "AdoptedRoute"("tripId", "status", "anchorFromNodeId", "anchorToNodeId");

CREATE UNIQUE INDEX "TransportEdge_id_tripId_key" ON "TransportEdge"("id", "tripId");
CREATE INDEX "ItineraryNode_adoptedRouteId_idx" ON "ItineraryNode"("adoptedRouteId");
CREATE INDEX "ItineraryNode_provider_providerPlaceRef_idx" ON "ItineraryNode"("provider", "providerPlaceRef");
CREATE INDEX "ItineraryNode_provider_providerHubRef_idx" ON "ItineraryNode"("provider", "providerHubRef");
CREATE INDEX "TransportEdge_adoptedRouteId_idx" ON "TransportEdge"("adoptedRouteId");
CREATE INDEX "TransportEdgeHistory_adoptedRouteId_idx" ON "TransportEdgeHistory"("adoptedRouteId");

ALTER TABLE "AdoptedRoute" ADD CONSTRAINT "AdoptedRoute_tripId_fkey"
  FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdoptedRoute" ADD CONSTRAINT "AdoptedRoute_anchorFromNodeId_tripId_fkey"
  FOREIGN KEY ("anchorFromNodeId", "tripId") REFERENCES "ItineraryNode"("id", "tripId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AdoptedRoute" ADD CONSTRAINT "AdoptedRoute_anchorToNodeId_tripId_fkey"
  FOREIGN KEY ("anchorToNodeId", "tripId") REFERENCES "ItineraryNode"("id", "tripId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AdoptedRoute" ADD CONSTRAINT "AdoptedRoute_sourcePreviewId_fkey"
  FOREIGN KEY ("sourcePreviewId") REFERENCES "RoutePreview"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AdoptedRoute" ADD CONSTRAINT "AdoptedRoute_candidateSnapshotId_fkey"
  FOREIGN KEY ("candidateSnapshotId") REFERENCES "RouteCandidateSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ItineraryNode" ADD CONSTRAINT "ItineraryNode_adoptedRouteId_fkey"
  FOREIGN KEY ("adoptedRouteId") REFERENCES "AdoptedRoute"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TransportEdge" ADD CONSTRAINT "TransportEdge_adoptedRouteId_fkey"
  FOREIGN KEY ("adoptedRouteId") REFERENCES "AdoptedRoute"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "TransportDayProjection" (
  "id" UUID NOT NULL,
  "tripId" UUID NOT NULL,
  "transportEdgeId" UUID NOT NULL,
  "dayOccurrenceId" UUID NOT NULL,
  "role" "TransportDayProjectionRole" NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TransportDayProjection_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TransportDayProjection_transportEdgeId_dayOccurrenceId_key"
  ON "TransportDayProjection"("transportEdgeId", "dayOccurrenceId");
CREATE INDEX "TransportDayProjection_tripId_dayOccurrenceId_role_idx"
  ON "TransportDayProjection"("tripId", "dayOccurrenceId", "role");
ALTER TABLE "TransportDayProjection" ADD CONSTRAINT "TransportDayProjection_tripId_fkey"
  FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TransportDayProjection" ADD CONSTRAINT "TransportDayProjection_transportEdgeId_tripId_fkey"
  FOREIGN KEY ("transportEdgeId", "tripId") REFERENCES "TransportEdge"("id", "tripId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TransportDayProjection" ADD CONSTRAINT "TransportDayProjection_dayOccurrenceId_tripId_fkey"
  FOREIGN KEY ("dayOccurrenceId", "tripId") REFERENCES "DayOccurrence"("id", "tripId") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "OperationReceipt" (
  "id" UUID NOT NULL,
  "ownerUserId" UUID NOT NULL,
  "tripId" UUID NOT NULL,
  "operationType" "OperationType" NOT NULL,
  "idempotencyKey" VARCHAR(200) NOT NULL,
  "requestHash" VARCHAR(64) NOT NULL,
  "baseTripVersion" INTEGER NOT NULL,
  "resultingTripVersion" INTEGER NOT NULL,
  "previewId" UUID NOT NULL,
  "adoptedRouteId" UUID NOT NULL,
  "delta" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OperationReceipt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OperationReceipt_ownerUserId_tripId_operationType_idempotencyKey_key"
  ON "OperationReceipt"("ownerUserId", "tripId", "operationType", "idempotencyKey");
CREATE INDEX "OperationReceipt_ownerUserId_tripId_createdAt_idx"
  ON "OperationReceipt"("ownerUserId", "tripId", "createdAt" DESC);
ALTER TABLE "OperationReceipt" ADD CONSTRAINT "OperationReceipt_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OperationReceipt" ADD CONSTRAINT "OperationReceipt_tripId_ownerUserId_fkey"
  FOREIGN KEY ("tripId", "ownerUserId") REFERENCES "Trip"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OperationReceipt" ADD CONSTRAINT "OperationReceipt_previewId_fkey"
  FOREIGN KEY ("previewId") REFERENCES "RoutePreview"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OperationReceipt" ADD CONSTRAINT "OperationReceipt_adoptedRouteId_fkey"
  FOREIGN KEY ("adoptedRouteId") REFERENCES "AdoptedRoute"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "OutboxEvent" (
  "id" UUID NOT NULL,
  "type" "OutboxEventType" NOT NULL,
  "aggregateType" VARCHAR(100) NOT NULL,
  "aggregateId" UUID NOT NULL,
  "tripId" UUID NOT NULL,
  "operationReceiptId" UUID NOT NULL,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMPTZ(3),
  CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OutboxEvent_operationReceiptId_type_key"
  ON "OutboxEvent"("operationReceiptId", "type");
CREATE INDEX "OutboxEvent_processedAt_createdAt_idx" ON "OutboxEvent"("processedAt", "createdAt");
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_tripId_fkey"
  FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_operationReceiptId_fkey"
  FOREIGN KEY ("operationReceiptId") REFERENCES "OperationReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ItineraryNode" ADD CONSTRAINT "ItineraryNode_route_generated_metadata_check"
  CHECK (
    ("source" = 'USER_PLANNED' AND "adoptedRouteId" IS NULL)
    OR
    ("source" = 'ROUTE_GENERATED' AND "adoptedRouteId" IS NOT NULL AND "provider" IS NOT NULL AND "sourceOperationId" IS NOT NULL)
  );
ALTER TABLE "TransportEdge" ADD CONSTRAINT "TransportEdge_adopted_source_check"
  CHECK (
    ("source" = 'MANUAL' AND "adoptedRouteId" IS NULL)
    OR
    ("source" = 'ADOPTED_ROUTE' AND "adoptedRouteId" IS NOT NULL AND "provider" IS NOT NULL)
  );
