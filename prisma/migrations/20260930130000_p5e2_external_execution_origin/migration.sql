-- CreateEnum
CREATE TYPE "ExternalExecutionOriginKind" AS ENUM ('TRANSIT_HUB');

-- CreateEnum
CREATE TYPE "ExternalExecutionOriginStatus" AS ENUM ('ARRIVED', 'DEPARTED', 'INVALIDATED');

-- CreateEnum
CREATE TYPE "ExternalExecutionOriginTransition" AS ENUM ('ARRIVAL', 'DEPARTURE', 'INVALIDATION');

CREATE TYPE "ExternalExecutionOriginInvalidationReason" AS ENUM ('SUPERSEDED_BY_LATER_EXECUTION');

-- CreateTable
CREATE TABLE "ExternalExecutionOrigin" (
    "id" UUID NOT NULL,
    "ownerUserId" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "kind" "ExternalExecutionOriginKind" NOT NULL DEFAULT 'TRANSIT_HUB',
    "sourceAdoptedRouteId" UUID NOT NULL,
    "sourceTransportEdgeId" UUID NOT NULL,
    "sourceGroundTransitLegExecutionId" UUID NOT NULL,
    "sourceGroundTransitObservationId" UUID NOT NULL,
    "sourceObservationIdentity" VARCHAR(300) NOT NULL,
    "sourceObservationFetchedAt" TIMESTAMPTZ(3) NOT NULL,
    "sourceObservationFactsHash" VARCHAR(64) NOT NULL,
    "provider" VARCHAR(100) NOT NULL,
    "providerHubRef" VARCHAR(300) NOT NULL,
    "canonicalHubRef" VARCHAR(300) NOT NULL,
    "name" VARCHAR(300) NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "timeZone" VARCHAR(100) NOT NULL,
    "status" "ExternalExecutionOriginStatus" NOT NULL DEFAULT 'ARRIVED',
    "arrivedAt" TIMESTAMPTZ(3) NOT NULL,
    "departedAt" TIMESTAMPTZ(3),
    "invalidatedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ExternalExecutionOrigin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalExecutionOriginReceipt" (
    "id" UUID NOT NULL,
    "ownerUserId" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "externalOriginId" UUID NOT NULL,
    "transition" "ExternalExecutionOriginTransition" NOT NULL,
    "idempotencyKey" VARCHAR(200),
    "triggeringReceiptId" UUID,
    "invalidationReason" "ExternalExecutionOriginInvalidationReason",
    "requestHash" VARCHAR(64) NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "resultingTripVersion" INTEGER NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalExecutionOriginReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExternalExecutionOrigin_tripId_status_idx" ON "ExternalExecutionOrigin"("tripId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalExecutionOrigin_id_tripId_key" ON "ExternalExecutionOrigin"("id", "tripId");

-- CreateIndex
CREATE INDEX "ExternalExecutionOriginReceipt_tripId_occurredAt_idx" ON "ExternalExecutionOriginReceipt"("tripId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalExecutionOriginReceipt_ownerUserId_idempotencyKey_key" ON "ExternalExecutionOriginReceipt"("ownerUserId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "ExternalExecutionOrigin" ADD CONSTRAINT "ExternalExecutionOrigin_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalExecutionOrigin" ADD CONSTRAINT "ExternalExecutionOrigin_tripId_ownerUserId_fkey" FOREIGN KEY ("tripId", "ownerUserId") REFERENCES "Trip"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalExecutionOriginReceipt" ADD CONSTRAINT "ExternalExecutionOriginReceipt_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalExecutionOriginReceipt" ADD CONSTRAINT "ExternalExecutionOriginReceipt_tripId_ownerUserId_fkey" FOREIGN KEY ("tripId", "ownerUserId") REFERENCES "Trip"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalExecutionOriginReceipt" ADD CONSTRAINT "ExternalExecutionOriginReceipt_externalOriginId_tripId_fkey" FOREIGN KEY ("externalOriginId", "tripId") REFERENCES "ExternalExecutionOrigin"("id", "tripId") ON DELETE CASCADE ON UPDATE CASCADE;


-- Resolver metadata and execution lifecycle are also checked at the storage boundary.
ALTER TABLE "ExternalExecutionOrigin" ADD CONSTRAINT "ExternalExecutionOrigin_coordinates_check" CHECK ("latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180);
ALTER TABLE "ExternalExecutionOrigin" ADD CONSTRAINT "ExternalExecutionOrigin_lifecycle_check" CHECK (
  ("status" = 'ARRIVED' AND "departedAt" IS NULL AND "invalidatedAt" IS NULL) OR
  ("status" = 'DEPARTED' AND "departedAt" IS NOT NULL AND "departedAt" >= "arrivedAt" AND "invalidatedAt" IS NULL) OR
  ("status" = 'INVALIDATED' AND "departedAt" IS NULL AND "invalidatedAt" IS NOT NULL AND "invalidatedAt" >= "arrivedAt")
);

-- Automatic transitions are audit rows, not client idempotency entries. The
-- triggering receipt identity is retained without a new historical FK cascade.
ALTER TABLE "ExternalExecutionOriginReceipt" ADD CONSTRAINT "ExternalExecutionOriginReceipt_audit_check" CHECK (
  ("transition" = 'INVALIDATION' AND "idempotencyKey" IS NULL AND "triggeringReceiptId" IS NOT NULL AND "invalidationReason" IS NOT NULL) OR
  ("transition" <> 'INVALIDATION' AND "idempotencyKey" IS NOT NULL AND "triggeringReceiptId" IS NULL AND "invalidationReason" IS NULL)
);
