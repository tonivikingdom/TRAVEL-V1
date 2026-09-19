CREATE TABLE "RouteCandidateSnapshot" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ownerUserId" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "basisVersion" INTEGER NOT NULL,
    "fromNodeId" UUID NOT NULL,
    "toNodeId" UUID NOT NULL,
    "provider" VARCHAR(100) NOT NULL,
    "providerCandidateRef" VARCHAR(300),
    "observedAt" TIMESTAMPTZ(3) NOT NULL,
    "providerValidUntil" TIMESTAMPTZ(3),
    "candidatePayload" JSONB NOT NULL,
    "candidateHash" VARCHAR(64) NOT NULL,
    "queryTimeCondition" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RouteCandidateSnapshot_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RouteCandidateSnapshot_basisVersion_check" CHECK ("basisVersion" > 0),
    CONSTRAINT "RouteCandidateSnapshot_distinct_endpoints_check" CHECK ("fromNodeId" <> "toNodeId"),
    CONSTRAINT "RouteCandidateSnapshot_expiry_check" CHECK ("expiresAt" > "createdAt"),
    CONSTRAINT "RouteCandidateSnapshot_provider_validity_check" CHECK ("providerValidUntil" IS NULL OR "expiresAt" <= "providerValidUntil"),
    CONSTRAINT "RouteCandidateSnapshot_hash_check" CHECK ("candidateHash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "RouteCandidateSnapshot_id_tripId_ownerUserId_key"
    ON "RouteCandidateSnapshot"("id", "tripId", "ownerUserId");
CREATE INDEX "RouteCandidateSnapshot_ownerUserId_tripId_expiresAt_idx"
    ON "RouteCandidateSnapshot"("ownerUserId", "tripId", "expiresAt");
CREATE INDEX "RouteCandidateSnapshot_expiresAt_idx"
    ON "RouteCandidateSnapshot"("expiresAt");

ALTER TABLE "RouteCandidateSnapshot"
    ADD CONSTRAINT "RouteCandidateSnapshot_ownerUserId_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RouteCandidateSnapshot"
    ADD CONSTRAINT "RouteCandidateSnapshot_tripId_ownerUserId_fkey"
    FOREIGN KEY ("tripId", "ownerUserId") REFERENCES "Trip"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RouteCandidateSnapshot"
    ADD CONSTRAINT "RouteCandidateSnapshot_fromNodeId_tripId_fkey"
    FOREIGN KEY ("fromNodeId", "tripId") REFERENCES "ItineraryNode"("id", "tripId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RouteCandidateSnapshot"
    ADD CONSTRAINT "RouteCandidateSnapshot_toNodeId_tripId_fkey"
    FOREIGN KEY ("toNodeId", "tripId") REFERENCES "ItineraryNode"("id", "tripId") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "RoutePreview" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ownerUserId" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "basisVersion" INTEGER NOT NULL,
    "candidateSnapshotId" UUID NOT NULL,
    "candidateHash" VARCHAR(64) NOT NULL,
    "policyVersion" VARCHAR(100) NOT NULL,
    "previewPayload" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RoutePreview_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RoutePreview_basisVersion_check" CHECK ("basisVersion" > 0),
    CONSTRAINT "RoutePreview_expiry_check" CHECK ("expiresAt" > "createdAt"),
    CONSTRAINT "RoutePreview_hash_check" CHECK ("candidateHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "RoutePreview_policy_check" CHECK (length("policyVersion") > 0)
);

CREATE UNIQUE INDEX "RoutePreview_id_tripId_ownerUserId_key"
    ON "RoutePreview"("id", "tripId", "ownerUserId");
CREATE INDEX "RoutePreview_ownerUserId_tripId_expiresAt_idx"
    ON "RoutePreview"("ownerUserId", "tripId", "expiresAt");
CREATE INDEX "RoutePreview_expiresAt_idx" ON "RoutePreview"("expiresAt");
CREATE INDEX "RoutePreview_candidateSnapshotId_idx"
    ON "RoutePreview"("candidateSnapshotId");

ALTER TABLE "RoutePreview"
    ADD CONSTRAINT "RoutePreview_ownerUserId_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoutePreview"
    ADD CONSTRAINT "RoutePreview_tripId_ownerUserId_fkey"
    FOREIGN KEY ("tripId", "ownerUserId") REFERENCES "Trip"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoutePreview"
    ADD CONSTRAINT "RoutePreview_candidateSnapshotId_tripId_ownerUserId_fkey"
    FOREIGN KEY ("candidateSnapshotId", "tripId", "ownerUserId")
    REFERENCES "RouteCandidateSnapshot"("id", "tripId", "ownerUserId")
    ON DELETE CASCADE ON UPDATE CASCADE;
