-- Additive authoring idempotency only; existing itinerary/date/route facts are unchanged.
CREATE TABLE "TripAuthoringReceipt" (
  "id" UUID NOT NULL,
  "ownerUserId" UUID NOT NULL,
  "tripId" UUID NOT NULL,
  "idempotencyKey" VARCHAR(200) NOT NULL,
  "requestHash" VARCHAR(64) NOT NULL,
  "baseTripVersion" INTEGER NOT NULL,
  "resultingTripVersion" INTEGER NOT NULL,
  "result" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TripAuthoringReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TripAuthoringReceipt_versions_check" CHECK ("baseTripVersion" >= 0 AND "resultingTripVersion" = "baseTripVersion" + 1),
  CONSTRAINT "TripAuthoringReceipt_result_check" CHECK (jsonb_typeof("result") = 'object'),
  CONSTRAINT "TripAuthoringReceipt_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TripAuthoringReceipt_tripId_ownerUserId_fkey" FOREIGN KEY ("tripId", "ownerUserId") REFERENCES "Trip"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TripAuthoringReceipt_ownerUserId_idempotencyKey_key" ON "TripAuthoringReceipt"("ownerUserId", "idempotencyKey");
CREATE INDEX "TripAuthoringReceipt_tripId_createdAt_idx" ON "TripAuthoringReceipt"("tripId", "createdAt");
