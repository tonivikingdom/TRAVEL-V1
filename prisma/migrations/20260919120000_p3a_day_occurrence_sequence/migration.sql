CREATE TABLE "DayOccurrence" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tripId" UUID NOT NULL,
  "localDate" DATE NOT NULL,
  "sequence" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "DayOccurrence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DayOccurrence_sequence_nonnegative" CHECK ("sequence" >= 0)
);

CREATE UNIQUE INDEX "DayOccurrence_tripId_sequence_key"
  ON "DayOccurrence"("tripId", "sequence");
CREATE UNIQUE INDEX "DayOccurrence_id_tripId_key"
  ON "DayOccurrence"("id", "tripId");
CREATE INDEX "DayOccurrence_tripId_localDate_idx"
  ON "DayOccurrence"("tripId", "localDate");

ALTER TABLE "DayOccurrence"
  ADD CONSTRAINT "DayOccurrence_tripId_fkey"
  FOREIGN KEY ("tripId") REFERENCES "Trip"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Materialize every natural day in each existing effective range, including
-- intermediate blank days. Old P2A/P2B order was localDate then position, so
-- the date offset is the lossless zero-based sequence for existing data.
INSERT INTO "DayOccurrence" ("tripId", "localDate", "sequence", "updatedAt")
SELECT
  trip."id",
  day_value::date,
  (day_value::date - trip."effectiveStartDate")::integer,
  CURRENT_TIMESTAMP
FROM "Trip" AS trip
CROSS JOIN LATERAL generate_series(
  trip."effectiveStartDate"::date,
  trip."effectiveEndDate"::date,
  interval '1 day'
) AS day_value
WHERE trip."effectiveStartDate" IS NOT NULL
  AND trip."effectiveEndDate" IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM "ItineraryNode" AS existing_node
    WHERE existing_node."tripId" = trip."id"
  );

ALTER TABLE "ItineraryNode"
  ADD COLUMN "dayOccurrenceId" UUID;

UPDATE "ItineraryNode" AS node
SET "dayOccurrenceId" = occurrence."id"
FROM "DayOccurrence" AS occurrence
WHERE occurrence."tripId" = node."tripId"
  AND occurrence."localDate" = node."localDate";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "ItineraryNode" WHERE "dayOccurrenceId" IS NULL
  ) THEN
    RAISE EXCEPTION 'P3A migration could not map every itinerary node to a DayOccurrence';
  END IF;
END $$;

ALTER TABLE "ItineraryNode"
  ALTER COLUMN "dayOccurrenceId" SET NOT NULL;

DROP INDEX "ItineraryNode_tripId_localDate_position_key";
DROP INDEX "ItineraryNode_tripId_localDate_position_idx";

ALTER TABLE "ItineraryNode"
  DROP COLUMN "localDate";

CREATE UNIQUE INDEX "ItineraryNode_dayOccurrenceId_position_key"
  ON "ItineraryNode"("dayOccurrenceId", "position");
CREATE INDEX "ItineraryNode_tripId_dayOccurrenceId_position_idx"
  ON "ItineraryNode"("tripId", "dayOccurrenceId", "position");

ALTER TABLE "ItineraryNode"
  ADD CONSTRAINT "ItineraryNode_dayOccurrenceId_tripId_fkey"
  FOREIGN KEY ("dayOccurrenceId", "tripId")
  REFERENCES "DayOccurrence"("id", "tripId")
  ON DELETE CASCADE ON UPDATE CASCADE;
