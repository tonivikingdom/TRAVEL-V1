CREATE TYPE "RouteQueryOriginKind" AS ENUM ('ITINERARY_NODE', 'EXTERNAL_EXECUTION_ORIGIN');
ALTER TABLE "RouteCandidateSnapshot"
  ADD COLUMN "originKind" "RouteQueryOriginKind" NOT NULL DEFAULT 'ITINERARY_NODE',
  ADD COLUMN "fromExternalOriginId" UUID,
  ADD COLUMN "externalOriginSnapshot" JSONB,
  ALTER COLUMN "fromNodeId" DROP NOT NULL;
ALTER TABLE "RouteCandidateSnapshot" ADD CONSTRAINT "RouteCandidateSnapshot_origin_shape_check" CHECK (
  ("originKind" = 'ITINERARY_NODE' AND "fromNodeId" IS NOT NULL AND "fromExternalOriginId" IS NULL AND "externalOriginSnapshot" IS NULL)
  OR
  ("originKind" = 'EXTERNAL_EXECUTION_ORIGIN' AND "fromNodeId" IS NULL AND "fromExternalOriginId" IS NOT NULL AND "externalOriginSnapshot" IS NOT NULL AND jsonb_typeof("externalOriginSnapshot") = 'object')
);
