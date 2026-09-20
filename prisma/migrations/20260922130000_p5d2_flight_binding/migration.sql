CREATE TYPE "FlightStatus" AS ENUM (
  'SCHEDULED',
  'BOARDING',
  'DEPARTED',
  'EN_ROUTE',
  'LANDED',
  'ARRIVED',
  'DELAYED',
  'CANCELLED',
  'DIVERTED',
  'UNKNOWN'
);

CREATE TABLE "FlightBinding" (
  "id" UUID NOT NULL,
  "ownerUserId" UUID NOT NULL,
  "tripId" UUID NOT NULL,
  "transportEdgeId" UUID NOT NULL,
  "provider" VARCHAR(100) NOT NULL,
  "providerFlightRef" VARCHAR(300) NOT NULL,
  "canonicalFlightNumber" VARCHAR(16) NOT NULL,
  "displayFlightNumber" VARCHAR(32) NOT NULL,
  "serviceDate" DATE NOT NULL,
  "selectedSnapshot" JSONB NOT NULL,
  "latestSnapshot" JSONB NOT NULL,
  "status" "FlightStatus" NOT NULL,
  "lastRefreshedAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "FlightBinding_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FlightBinding_provider_check" CHECK ("provider" = 'aerodatabox'),
  CONSTRAINT "FlightBinding_flight_number_check" CHECK ("canonicalFlightNumber" ~ '^[A-Z0-9]{2,3}[0-9]{1,4}[A-Z]?$')
);

CREATE UNIQUE INDEX "FlightBinding_transportEdgeId_key" ON "FlightBinding"("transportEdgeId");
CREATE UNIQUE INDEX "FlightBinding_id_tripId_ownerUserId_key" ON "FlightBinding"("id", "tripId", "ownerUserId");
CREATE UNIQUE INDEX "FlightBinding_transportEdgeId_tripId_key" ON "FlightBinding"("transportEdgeId", "tripId");
CREATE INDEX "FlightBinding_ownerUserId_tripId_updatedAt_idx" ON "FlightBinding"("ownerUserId", "tripId", "updatedAt" DESC);
CREATE INDEX "FlightBinding_provider_canonicalFlightNumber_serviceDate_idx" ON "FlightBinding"("provider", "canonicalFlightNumber", "serviceDate");

ALTER TABLE "FlightBinding"
  ADD CONSTRAINT "FlightBinding_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FlightBinding"
  ADD CONSTRAINT "FlightBinding_tripId_ownerUserId_fkey"
  FOREIGN KEY ("tripId", "ownerUserId") REFERENCES "Trip"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FlightBinding"
  ADD CONSTRAINT "FlightBinding_transportEdgeId_tripId_fkey"
  FOREIGN KEY ("transportEdgeId", "tripId") REFERENCES "TransportEdge"("id", "tripId") ON DELETE CASCADE ON UPDATE CASCADE;
