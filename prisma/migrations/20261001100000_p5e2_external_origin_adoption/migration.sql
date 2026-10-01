CREATE TYPE "AdoptedRouteAnchorOriginKind" AS ENUM ('ITINERARY_NODE', 'EXTERNAL_EXECUTION_ORIGIN');
ALTER TABLE "AdoptedRoute"
  ALTER COLUMN "anchorFromNodeId" DROP NOT NULL,
  ADD COLUMN "anchorOriginKind" "AdoptedRouteAnchorOriginKind" NOT NULL DEFAULT 'ITINERARY_NODE',
  ADD COLUMN "anchorFromExternalOriginId" UUID,
  ADD COLUMN "anchorFromSnapshot" JSONB;
-- Keep the existing composite same-Trip Restrict FK unchanged.
ALTER TABLE "AdoptedRoute" ADD CONSTRAINT "AdoptedRoute_anchor_origin_shape" CHECK (
  ("anchorOriginKind" = 'ITINERARY_NODE' AND "anchorFromNodeId" IS NOT NULL
    AND "anchorFromExternalOriginId" IS NULL AND "anchorFromSnapshot" IS NULL)
  OR
  ("anchorOriginKind" = 'EXTERNAL_EXECUTION_ORIGIN'
    AND "anchorFromExternalOriginId" IS NOT NULL AND "anchorFromSnapshot" IS NOT NULL
    AND jsonb_typeof("anchorFromSnapshot") = 'object'
    AND (("status" = 'ACTIVE' AND "anchorFromNodeId" IS NOT NULL)
      OR ("status" = 'UNDONE' AND "anchorFromNodeId" IS NULL)
      OR "status" = 'REPLACED'))
);
