CREATE TABLE "ExecutionObservationWatermark" (
  "tripId" UUID NOT NULL,
  "lastObservedAt" TIMESTAMPTZ(3) NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "ExecutionObservationWatermark_pkey" PRIMARY KEY ("tripId")
);

CREATE TABLE "ExecutionArrivalSuppression" (
  "nodeId" UUID NOT NULL,
  "tripId" UUID NOT NULL,
  "suppressedByEventId" UUID NOT NULL,
  "suppressedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "ExecutionArrivalSuppression_pkey" PRIMARY KEY ("nodeId")
);

CREATE UNIQUE INDEX "ExecutionArrivalSuppression_suppressedByEventId_key"
  ON "ExecutionArrivalSuppression"("suppressedByEventId");

CREATE UNIQUE INDEX "ExecutionArrivalSuppression_nodeId_tripId_key"
  ON "ExecutionArrivalSuppression"("nodeId", "tripId");

CREATE UNIQUE INDEX "ExecutionArrivalSuppression_suppressedByEventId_tripId_key"
  ON "ExecutionArrivalSuppression"("suppressedByEventId", "tripId");

CREATE INDEX "ExecutionArrivalSuppression_tripId_suppressedAt_idx"
  ON "ExecutionArrivalSuppression"("tripId", "suppressedAt");

ALTER TABLE "ExecutionObservationWatermark"
  ADD CONSTRAINT "ExecutionObservationWatermark_tripId_fkey"
  FOREIGN KEY ("tripId") REFERENCES "Trip"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ExecutionArrivalSuppression"
  ADD CONSTRAINT "ExecutionArrivalSuppression_tripId_fkey"
  FOREIGN KEY ("tripId") REFERENCES "Trip"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ExecutionArrivalSuppression"
  ADD CONSTRAINT "ExecutionArrivalSuppression_nodeId_tripId_fkey"
  FOREIGN KEY ("nodeId", "tripId") REFERENCES "ItineraryNode"("id", "tripId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ExecutionArrivalSuppression"
  ADD CONSTRAINT "ExecutionArrivalSuppression_suppressedByEventId_tripId_fkey"
  FOREIGN KEY ("suppressedByEventId", "tripId") REFERENCES "ExecutionEvent"("id", "tripId")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserve the highest location-observation instant available on upgrade. The
-- event fallback restores the watermark for trips whose proximity state was
-- deleted by a historical Undo.
INSERT INTO "ExecutionObservationWatermark" (
  "tripId",
  "lastObservedAt",
  "updatedAt"
)
SELECT
  observations."tripId",
  MAX(observations."observedAt"),
  CURRENT_TIMESTAMP
FROM (
  SELECT "tripId", "lastObservedAt" AS "observedAt"
  FROM "ExecutionLocationState"
  UNION ALL
  SELECT "tripId", "occurredAt" AS "observedAt"
  FROM "ExecutionEvent"
  WHERE "source" = 'LOCATION'
) AS observations
GROUP BY observations."tripId";

-- Historical undone arrivals become suppressed only when no later active
-- arrival or ACTUAL arrival currently represents that node.
INSERT INTO "ExecutionArrivalSuppression" (
  "nodeId",
  "tripId",
  "suppressedByEventId",
  "suppressedAt"
)
SELECT DISTINCT ON (undone."nodeId")
  undone."nodeId",
  undone."tripId",
  undone."id",
  undone."undoneAt"
FROM "ExecutionEvent" AS undone
WHERE undone."type" = 'ARRIVAL'
  AND undone."undoneAt" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "ExecutionEvent" AS active
    WHERE active."tripId" = undone."tripId"
      AND active."nodeId" = undone."nodeId"
      AND active."type" = 'ARRIVAL'
      AND active."undoneAt" IS NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "TemporalValue" AS actual
    WHERE actual."nodeId" = undone."nodeId"
      AND actual."layer" = 'ACTUAL'
      AND actual."pointKind" = 'ARRIVAL'
  )
ORDER BY undone."nodeId", undone."undoneAt" DESC, undone."id" DESC;
