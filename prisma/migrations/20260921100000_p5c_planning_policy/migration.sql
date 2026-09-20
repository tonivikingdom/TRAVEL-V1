CREATE TYPE "DwellSuggestionSource" AS ENUM ('SYSTEM_SUGGESTION');

CREATE TABLE "SystemDwellSuggestion" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tripId" UUID NOT NULL,
    "nodeId" UUID NOT NULL,
    "durationSeconds" INTEGER NOT NULL,
    "source" "DwellSuggestionSource" NOT NULL DEFAULT 'SYSTEM_SUGGESTION',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SystemDwellSuggestion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SystemDwellSuggestion_durationSeconds_check"
      CHECK ("durationSeconds" > 0)
);

CREATE UNIQUE INDEX "SystemDwellSuggestion_nodeId_key"
ON "SystemDwellSuggestion"("nodeId");

CREATE UNIQUE INDEX "SystemDwellSuggestion_nodeId_tripId_key"
ON "SystemDwellSuggestion"("nodeId", "tripId");

CREATE INDEX "SystemDwellSuggestion_tripId_nodeId_idx"
ON "SystemDwellSuggestion"("tripId", "nodeId");

ALTER TABLE "SystemDwellSuggestion"
ADD CONSTRAINT "SystemDwellSuggestion_tripId_fkey"
FOREIGN KEY ("tripId") REFERENCES "Trip"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SystemDwellSuggestion"
ADD CONSTRAINT "SystemDwellSuggestion_nodeId_tripId_fkey"
FOREIGN KEY ("nodeId", "tripId") REFERENCES "ItineraryNode"("id", "tripId")
ON DELETE CASCADE ON UPDATE CASCADE;
