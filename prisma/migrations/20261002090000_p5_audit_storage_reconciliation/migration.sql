ALTER TABLE "StoredObject"
  ADD COLUMN "storageDeletedAt" TIMESTAMPTZ(3),
  ADD COLUMN "cleanupAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "cleanupNextAttemptAt" TIMESTAMPTZ(3),
  ADD COLUMN "cleanupLastErrorCode" VARCHAR(64);

ALTER TABLE "StoredObject" ADD CONSTRAINT "StoredObject_cleanup_attempts_check"
  CHECK ("cleanupAttempts" >= 0);
ALTER TABLE "StoredObject" ADD CONSTRAINT "StoredObject_storage_deleted_state_check"
  CHECK ("storageDeletedAt" IS NULL OR "state" IN ('FAILED', 'DELETED'));
CREATE INDEX "StoredObject_cleanup_scan_idx"
  ON "StoredObject" ("state", "storageDeletedAt", "cleanupNextAttemptAt", "createdAt");
