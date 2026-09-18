CREATE TYPE "StoredObjectState" AS ENUM ('PENDING', 'READY', 'FAILED', 'DELETED');

CREATE TABLE "NotificationEvent" (
  "id" UUID NOT NULL,
  "ownerUserId" UUID NOT NULL,
  "kind" VARCHAR(100) NOT NULL,
  "dedupeKey" VARCHAR(200) NOT NULL,
  "title" VARCHAR(200) NOT NULL,
  "body" VARCHAR(4000) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL,
  "dismissedAt" TIMESTAMPTZ(3),
  CONSTRAINT "NotificationEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NotificationEvent_nonempty_fields" CHECK (
    length(btrim("kind")) > 0 AND
    length(btrim("dedupeKey")) > 0 AND
    length(btrim("title")) > 0 AND
    length(btrim("body")) > 0
  )
);

CREATE UNIQUE INDEX "NotificationEvent_ownerUserId_dedupeKey_key"
  ON "NotificationEvent"("ownerUserId", "dedupeKey");
CREATE INDEX "NotificationEvent_ownerUserId_createdAt_id_idx"
  ON "NotificationEvent"("ownerUserId", "createdAt" DESC, "id" DESC);
CREATE INDEX "NotificationEvent_ownerUserId_dismissedAt_idx"
  ON "NotificationEvent"("ownerUserId", "dismissedAt");

ALTER TABLE "NotificationEvent"
  ADD CONSTRAINT "NotificationEvent_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "StoredObject" (
  "id" UUID NOT NULL,
  "ownerUserId" UUID NOT NULL,
  "storageKey" VARCHAR(64) NOT NULL,
  "state" "StoredObjectState" NOT NULL DEFAULT 'PENDING',
  "displayName" VARCHAR(255) NOT NULL,
  "mediaType" VARCHAR(127) NOT NULL,
  "declaredByteSize" BIGINT NOT NULL,
  "byteSize" BIGINT,
  "sha256" VARCHAR(64),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "readyAt" TIMESTAMPTZ(3),
  "deletedAt" TIMESTAMPTZ(3),
  CONSTRAINT "StoredObject_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StoredObject_sizes_nonnegative" CHECK (
    "declaredByteSize" >= 0 AND ("byteSize" IS NULL OR "byteSize" >= 0)
  ),
  CONSTRAINT "StoredObject_ready_integrity" CHECK (
    "state" <> 'READY' OR
    ("byteSize" IS NOT NULL AND "sha256" IS NOT NULL AND "readyAt" IS NOT NULL)
  ),
  CONSTRAINT "StoredObject_deleted_timestamp" CHECK (
    "state" <> 'DELETED' OR "deletedAt" IS NOT NULL
  )
);

CREATE UNIQUE INDEX "StoredObject_storageKey_key"
  ON "StoredObject"("storageKey");
CREATE INDEX "StoredObject_ownerUserId_state_createdAt_idx"
  ON "StoredObject"("ownerUserId", "state", "createdAt");

ALTER TABLE "StoredObject"
  ADD CONSTRAINT "StoredObject_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
