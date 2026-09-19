CREATE TYPE "UserTimeIntentKind" AS ENUM ('POINT_TIME', 'MIN_DWELL');
CREATE TYPE "UserTimeIntentOperator" AS ENUM ('EXACT', 'NOT_BEFORE', 'NOT_AFTER', 'MINIMUM');

CREATE TABLE "UserTimeIntent" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tripId" UUID NOT NULL,
  "nodeId" UUID NOT NULL,
  "kind" "UserTimeIntentKind" NOT NULL,
  "pointKind" "TemporalPointKind",
  "operator" "UserTimeIntentOperator" NOT NULL,
  "instant" TIMESTAMPTZ(3),
  "timeZone" VARCHAR(100),
  "durationSeconds" INTEGER,
  "locked" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "UserTimeIntent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UserTimeIntent_shape_check" CHECK (
    (
      "kind" = 'POINT_TIME'
      AND "pointKind" IS NOT NULL
      AND "operator" IN ('EXACT', 'NOT_BEFORE', 'NOT_AFTER')
      AND "instant" IS NOT NULL
      AND "timeZone" IS NOT NULL
      AND "durationSeconds" IS NULL
    )
    OR
    (
      "kind" = 'MIN_DWELL'
      AND "pointKind" IS NULL
      AND "operator" = 'MINIMUM'
      AND "instant" IS NULL
      AND "timeZone" IS NULL
      AND "durationSeconds" > 0
    )
  )
);

CREATE INDEX "UserTimeIntent_tripId_nodeId_idx"
  ON "UserTimeIntent"("tripId", "nodeId");
CREATE INDEX "UserTimeIntent_nodeId_kind_pointKind_operator_idx"
  ON "UserTimeIntent"("nodeId", "kind", "pointKind", "operator");

CREATE UNIQUE INDEX "UserTimeIntent_point_slot_key"
  ON "UserTimeIntent"("nodeId", "pointKind", "operator")
  WHERE "kind" = 'POINT_TIME';
CREATE UNIQUE INDEX "UserTimeIntent_min_dwell_slot_key"
  ON "UserTimeIntent"("nodeId")
  WHERE "kind" = 'MIN_DWELL';

ALTER TABLE "UserTimeIntent"
  ADD CONSTRAINT "UserTimeIntent_tripId_fkey"
  FOREIGN KEY ("tripId") REFERENCES "Trip"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserTimeIntent"
  ADD CONSTRAINT "UserTimeIntent_nodeId_tripId_fkey"
  FOREIGN KEY ("nodeId", "tripId") REFERENCES "ItineraryNode"("id", "tripId")
  ON DELETE CASCADE ON UPDATE CASCADE;
