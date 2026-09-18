CREATE TYPE "ItineraryNodeKind" AS ENUM ('PLACE_VISIT', 'FREE_ACTION');
CREATE TYPE "ItineraryNodeSource" AS ENUM ('USER_PLANNED');

CREATE TABLE "Trip" (
  "id" UUID NOT NULL,
  "ownerUserId" UUID NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "planningAnchorDate" DATE NOT NULL,
  "defaultPeopleCount" INTEGER NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "effectiveStartDate" DATE,
  "effectiveEndDate" DATE,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "Trip_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Trip_name_nonempty" CHECK (length(btrim("name")) > 0),
  CONSTRAINT "Trip_people_positive" CHECK ("defaultPeopleCount" > 0),
  CONSTRAINT "Trip_version_positive" CHECK ("version" > 0),
  CONSTRAINT "Trip_effective_range_complete" CHECK (
    ("effectiveStartDate" IS NULL AND "effectiveEndDate" IS NULL) OR
    ("effectiveStartDate" IS NOT NULL AND "effectiveEndDate" IS NOT NULL AND
      "effectiveStartDate" <= "effectiveEndDate")
  )
);

CREATE UNIQUE INDEX "Trip_id_ownerUserId_key" ON "Trip"("id", "ownerUserId");
CREATE INDEX "Trip_ownerUserId_updatedAt_id_idx"
  ON "Trip"("ownerUserId", "updatedAt" DESC, "id" DESC);

CREATE TABLE "DateOwnership" (
  "ownerUserId" UUID NOT NULL,
  "localDate" DATE NOT NULL,
  "tripId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DateOwnership_pkey" PRIMARY KEY ("ownerUserId", "localDate")
);

CREATE UNIQUE INDEX "DateOwnership_tripId_localDate_key"
  ON "DateOwnership"("tripId", "localDate");
CREATE INDEX "DateOwnership_tripId_localDate_idx"
  ON "DateOwnership"("tripId", "localDate");

CREATE TABLE "Place" (
  "id" UUID NOT NULL,
  "ownerUserId" UUID NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "latitude" DECIMAL(9, 6) NOT NULL,
  "longitude" DECIMAL(9, 6) NOT NULL,
  "address" VARCHAR(500),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Place_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Place_name_nonempty" CHECK (length(btrim("name")) > 0),
  CONSTRAINT "Place_latitude_range" CHECK ("latitude" BETWEEN -90 AND 90),
  CONSTRAINT "Place_longitude_range" CHECK ("longitude" BETWEEN -180 AND 180)
);

CREATE INDEX "Place_ownerUserId_createdAt_id_idx"
  ON "Place"("ownerUserId", "createdAt", "id");

CREATE TABLE "ItineraryNode" (
  "id" UUID NOT NULL,
  "tripId" UUID NOT NULL,
  "kind" "ItineraryNodeKind" NOT NULL,
  "localDate" DATE NOT NULL,
  "position" INTEGER NOT NULL,
  "placeId" UUID,
  "note" VARCHAR(2000),
  "source" "ItineraryNodeSource" NOT NULL DEFAULT 'USER_PLANNED',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ItineraryNode_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ItineraryNode_position_nonnegative" CHECK ("position" >= 0),
  CONSTRAINT "ItineraryNode_kind_place" CHECK (
    ("kind" = 'PLACE_VISIT' AND "placeId" IS NOT NULL) OR
    ("kind" = 'FREE_ACTION' AND "placeId" IS NULL)
  )
);

CREATE UNIQUE INDEX "ItineraryNode_tripId_localDate_position_key"
  ON "ItineraryNode"("tripId", "localDate", "position");
CREATE INDEX "ItineraryNode_tripId_localDate_position_idx"
  ON "ItineraryNode"("tripId", "localDate", "position");
CREATE INDEX "ItineraryNode_placeId_idx" ON "ItineraryNode"("placeId");

ALTER TABLE "Trip"
  ADD CONSTRAINT "Trip_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DateOwnership"
  ADD CONSTRAINT "DateOwnership_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DateOwnership"
  ADD CONSTRAINT "DateOwnership_tripId_ownerUserId_fkey"
  FOREIGN KEY ("tripId", "ownerUserId") REFERENCES "Trip"("id", "ownerUserId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Place"
  ADD CONSTRAINT "Place_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ItineraryNode"
  ADD CONSTRAINT "ItineraryNode_tripId_fkey"
  FOREIGN KEY ("tripId") REFERENCES "Trip"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ItineraryNode"
  ADD CONSTRAINT "ItineraryNode_placeId_fkey"
  FOREIGN KEY ("placeId") REFERENCES "Place"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
