CREATE TYPE "ExecutionEvidenceReliability" AS ENUM ('SUFFICIENT', 'WEAK', 'INDETERMINATE');

ALTER TABLE "ExecutionEvent"
  ADD COLUMN "evidenceReliability" "ExecutionEvidenceReliability",
  ADD COLUMN "evidencePolicyVersion" VARCHAR(80),
  ADD COLUMN "evidenceReasonCodes" JSONB,
  ADD COLUMN "evidenceCompetingNodeIds" JSONB;

ALTER TABLE "ExecutionEvent"
  ADD CONSTRAINT "ExecutionEvent_evidence_consistency_check" CHECK (
    (
      "evidenceReliability" IS NULL AND
      "evidencePolicyVersion" IS NULL AND
      "evidenceReasonCodes" IS NULL AND
      "evidenceCompetingNodeIds" IS NULL
    ) OR (
      "source" = 'LOCATION' AND
      "evidenceReliability" = 'SUFFICIENT' AND
      "evidencePolicyVersion" IS NOT NULL AND
      jsonb_typeof("evidenceReasonCodes") = 'array' AND
      jsonb_typeof("evidenceCompetingNodeIds") = 'array'
    )
  );

ALTER TABLE "NotificationEvent"
  ADD COLUMN "presentationGroupKey" VARCHAR(200),
  ADD COLUMN "presentationActive" BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX "NotificationEvent_ownerUserId_presentationGroupKey_idx"
  ON "NotificationEvent" ("ownerUserId", "presentationGroupKey");

CREATE UNIQUE INDEX "NotificationEvent_one_active_group_idx"
  ON "NotificationEvent" ("ownerUserId", "presentationGroupKey")
  WHERE "presentationGroupKey" IS NOT NULL AND "presentationActive" = TRUE;
