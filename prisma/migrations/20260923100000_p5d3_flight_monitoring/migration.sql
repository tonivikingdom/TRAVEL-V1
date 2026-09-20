ALTER TYPE "JobType" ADD VALUE 'FLIGHT_MONITOR';

CREATE TYPE "FlightMonitorMode" AS ENUM (
  'NORMAL',
  'DELAYED',
  'CANCELLED',
  'BAGGAGE',
  'STOPPED'
);

CREATE TYPE "NotificationPriority" AS ENUM ('NORMAL', 'STRONG');

ALTER TABLE "NotificationEvent"
  ADD COLUMN "tripId" UUID,
  ADD COLUMN "flightBindingId" UUID,
  ADD COLUMN "flightNumber" VARCHAR(32),
  ADD COLUMN "priority" "NotificationPriority" NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN "summary" VARCHAR(500),
  ADD COLUMN "changeKinds" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "hasDownstreamImpact" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "viewedAt" TIMESTAMPTZ(3);

CREATE INDEX "NotificationEvent_flightBindingId_createdAt_idx"
  ON "NotificationEvent"("flightBindingId", "createdAt" DESC);

CREATE TABLE "FlightMonitorState" (
  "flightBindingId" UUID NOT NULL,
  "generation" UUID NOT NULL DEFAULT gen_random_uuid(),
  "mode" "FlightMonitorMode" NOT NULL DEFAULT 'NORMAL',
  "arrivedAtAirportAt" TIMESTAMPTZ(3),
  "arrivedAirportIata" VARCHAR(3),
  "lastSuccessfulMonitorRefreshAt" TIMESTAMPTZ(3),
  "lastNotifiedDelayMinutes" INTEGER,
  "earlyDepartureNotified" BOOLEAN NOT NULL DEFAULT false,
  "lastNotifiedDepartureGate" VARCHAR(100),
  "providerUnavailableWarned" BOOLEAN NOT NULL DEFAULT false,
  "cancellationNotified" BOOLEAN NOT NULL DEFAULT false,
  "baggageWindowStartedAt" TIMESTAMPTZ(3),
  "baggageWindowEndsAt" TIMESTAMPTZ(3),
  "lastNotifiedBaggage" VARCHAR(100),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FlightMonitorState_pkey" PRIMARY KEY ("flightBindingId"),
  CONSTRAINT "FlightMonitorState_flightBindingId_fkey"
    FOREIGN KEY ("flightBindingId") REFERENCES "FlightBinding"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FlightMonitorState_lastNotifiedDelayMinutes_check"
    CHECK ("lastNotifiedDelayMinutes" IS NULL OR "lastNotifiedDelayMinutes" >= 0),
  CONSTRAINT "FlightMonitorState_baggageWindow_check"
    CHECK (
      "baggageWindowEndsAt" IS NULL
      OR (
        "baggageWindowStartedAt" IS NOT NULL
        AND "baggageWindowEndsAt" >= "baggageWindowStartedAt"
      )
    )
);

CREATE OR REPLACE FUNCTION cancel_deleted_flight_monitor_jobs()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "Job"
  SET "status" = 'CANCELLED',
      "cancelRequested" = true,
      "cancelledAt" = clock_timestamp(),
      "completedAt" = clock_timestamp(),
      "leaseOwner" = NULL,
      "leaseUntil" = NULL,
      "updatedAt" = clock_timestamp()
  WHERE "type" = 'FLIGHT_MONITOR'
    AND "payloadRef" = OLD."id"
    AND "status" IN ('QUEUED', 'RUNNING');
  RETURN OLD;
END;
$$;

CREATE TRIGGER "FlightBinding_cancel_monitor_jobs"
BEFORE DELETE ON "FlightBinding"
FOR EACH ROW EXECUTE FUNCTION cancel_deleted_flight_monitor_jobs();
