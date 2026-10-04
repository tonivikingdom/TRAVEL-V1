CREATE TABLE "TripStaticBackup" (
  "id" UUID NOT NULL,
  "ownerUserId" UUID NOT NULL,
  "tripId" UUID NOT NULL,
  "tripVersion" INTEGER NOT NULL CHECK ("tripVersion" > 0),
  "generatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "idempotencyKey" VARCHAR(80) NOT NULL,
  "artifact" JSONB NOT NULL CHECK (octet_length("artifact"::text) <= 1048576),
  CONSTRAINT "TripStaticBackup_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TripStaticBackup_tripId_ownerUserId_fkey" FOREIGN KEY ("tripId", "ownerUserId") REFERENCES "Trip"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TripStaticBackup_ownerUserId_tripId_idempotencyKey_key" ON "TripStaticBackup"("ownerUserId", "tripId", "idempotencyKey");
CREATE INDEX "TripStaticBackup_ownerUserId_tripId_generatedAt_id_idx" ON "TripStaticBackup"("ownerUserId", "tripId", "generatedAt" DESC, "id" DESC);
