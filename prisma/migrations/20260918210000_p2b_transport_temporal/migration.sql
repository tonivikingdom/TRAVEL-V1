CREATE TYPE "TransportMode" AS ENUM (
  'WALKING',
  'DRIVING',
  'TAXI',
  'RAIL',
  'BUS',
  'FERRY',
  'FLIGHT',
  'OTHER'
);

CREATE TYPE "TransportSource" AS ENUM ('MANUAL');

CREATE TYPE "TransportInvalidationReason" AS ENUM (
  'ADJACENCY_CHANGED',
  'ENDPOINT_REPLACED',
  'NODE_DELETED',
  'USER_REPLACED',
  'USER_CLEARED'
);

CREATE TYPE "TemporalLayer" AS ENUM ('PLANNED', 'ESTIMATED', 'ACTUAL');

CREATE TYPE "TemporalPointKind" AS ENUM ('ARRIVAL', 'DEPARTURE');

CREATE TYPE "TemporalSourceKind" AS ENUM (
  'USER_VALUE',
  'ADOPTED_TRANSPORT_FACT',
  'SYSTEM_SUGGESTION',
  'DERIVED',
  'PROVIDER_OBSERVATION'
);

CREATE UNIQUE INDEX "ItineraryNode_id_tripId_key"
  ON "ItineraryNode"("id", "tripId");

CREATE TABLE "TransportEdge" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tripId" UUID NOT NULL,
  "fromNodeId" UUID NOT NULL,
  "toNodeId" UUID NOT NULL,
  "mode" "TransportMode" NOT NULL,
  "fixedService" BOOLEAN NOT NULL,
  "serviceLabel" VARCHAR(200),
  "note" VARCHAR(2000),
  "source" "TransportSource" NOT NULL DEFAULT 'MANUAL',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "TransportEdge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TransportEdge_distinct_endpoints_check"
    CHECK ("fromNodeId" <> "toNodeId")
);

CREATE UNIQUE INDEX "TransportEdge_tripId_fromNodeId_toNodeId_key"
  ON "TransportEdge"("tripId", "fromNodeId", "toNodeId");
CREATE UNIQUE INDEX "TransportEdge_tripId_fromNodeId_key"
  ON "TransportEdge"("tripId", "fromNodeId");
CREATE UNIQUE INDEX "TransportEdge_tripId_toNodeId_key"
  ON "TransportEdge"("tripId", "toNodeId");
CREATE INDEX "TransportEdge_tripId_createdAt_id_idx"
  ON "TransportEdge"("tripId", "createdAt", "id");

ALTER TABLE "TransportEdge"
  ADD CONSTRAINT "TransportEdge_tripId_fkey"
  FOREIGN KEY ("tripId") REFERENCES "Trip"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TransportEdge"
  ADD CONSTRAINT "TransportEdge_fromNodeId_tripId_fkey"
  FOREIGN KEY ("fromNodeId", "tripId")
  REFERENCES "ItineraryNode"("id", "tripId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TransportEdge"
  ADD CONSTRAINT "TransportEdge_toNodeId_tripId_fkey"
  FOREIGN KEY ("toNodeId", "tripId")
  REFERENCES "ItineraryNode"("id", "tripId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "TransportEdgeHistory" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "originalTransportEdgeId" UUID NOT NULL,
  "tripId" UUID NOT NULL,
  "originalFromNodeId" UUID NOT NULL,
  "originalToNodeId" UUID NOT NULL,
  "mode" "TransportMode" NOT NULL,
  "fixedService" BOOLEAN NOT NULL,
  "serviceLabel" VARCHAR(200),
  "note" VARCHAR(2000),
  "source" "TransportSource" NOT NULL,
  "originalCreatedAt" TIMESTAMPTZ(3) NOT NULL,
  "invalidatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "invalidationReason" "TransportInvalidationReason" NOT NULL,

  CONSTRAINT "TransportEdgeHistory_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TransportEdgeHistory_distinct_endpoints_check"
    CHECK ("originalFromNodeId" <> "originalToNodeId")
);

CREATE UNIQUE INDEX "TransportEdgeHistory_originalTransportEdgeId_key"
  ON "TransportEdgeHistory"("originalTransportEdgeId");
CREATE INDEX "TransportEdgeHistory_tripId_invalidatedAt_id_idx"
  ON "TransportEdgeHistory"("tripId", "invalidatedAt" DESC, "id" DESC);
CREATE INDEX "TransportEdgeHistory_originalFromNodeId_originalToNodeId_idx"
  ON "TransportEdgeHistory"("originalFromNodeId", "originalToNodeId");

ALTER TABLE "TransportEdgeHistory"
  ADD CONSTRAINT "TransportEdgeHistory_tripId_fkey"
  FOREIGN KEY ("tripId") REFERENCES "Trip"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TemporalValue" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "nodeId" UUID,
  "transportEdgeId" UUID,
  "layer" "TemporalLayer" NOT NULL,
  "pointKind" "TemporalPointKind" NOT NULL,
  "instant" TIMESTAMPTZ(3) NOT NULL,
  "timeZone" VARCHAR(100) NOT NULL,
  "sourceKind" "TemporalSourceKind" NOT NULL,
  "sourceRef" VARCHAR(300),
  "observedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "TemporalValue_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TemporalValue_exactly_one_subject_check"
    CHECK (("nodeId" IS NOT NULL) <> ("transportEdgeId" IS NOT NULL))
);

CREATE UNIQUE INDEX "TemporalValue_nodeId_pointKind_layer_key"
  ON "TemporalValue"("nodeId", "pointKind", "layer");
CREATE UNIQUE INDEX "TemporalValue_transportEdgeId_pointKind_layer_key"
  ON "TemporalValue"("transportEdgeId", "pointKind", "layer");
CREATE INDEX "TemporalValue_nodeId_idx" ON "TemporalValue"("nodeId");
CREATE INDEX "TemporalValue_transportEdgeId_idx"
  ON "TemporalValue"("transportEdgeId");

ALTER TABLE "TemporalValue"
  ADD CONSTRAINT "TemporalValue_nodeId_fkey"
  FOREIGN KEY ("nodeId") REFERENCES "ItineraryNode"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TemporalValue"
  ADD CONSTRAINT "TemporalValue_transportEdgeId_fkey"
  FOREIGN KEY ("transportEdgeId") REFERENCES "TransportEdge"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TransportEdgeHistoryTimeValue" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "transportEdgeHistoryId" UUID NOT NULL,
  "layer" "TemporalLayer" NOT NULL,
  "pointKind" "TemporalPointKind" NOT NULL,
  "instant" TIMESTAMPTZ(3) NOT NULL,
  "timeZone" VARCHAR(100) NOT NULL,
  "sourceKind" "TemporalSourceKind" NOT NULL,
  "sourceRef" VARCHAR(300),
  "observedAt" TIMESTAMPTZ(3),
  "originalCreatedAt" TIMESTAMPTZ(3) NOT NULL,
  "originalUpdatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "TransportEdgeHistoryTimeValue_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TransportEdgeHistoryTimeValue_transportEdgeHistoryId_pointKind_layer_key"
  ON "TransportEdgeHistoryTimeValue"("transportEdgeHistoryId", "pointKind", "layer");
CREATE INDEX "TransportEdgeHistoryTimeValue_transportEdgeHistoryId_idx"
  ON "TransportEdgeHistoryTimeValue"("transportEdgeHistoryId");

ALTER TABLE "TransportEdgeHistoryTimeValue"
  ADD CONSTRAINT "TransportEdgeHistoryTimeValue_transportEdgeHistoryId_fkey"
  FOREIGN KEY ("transportEdgeHistoryId") REFERENCES "TransportEdgeHistory"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
