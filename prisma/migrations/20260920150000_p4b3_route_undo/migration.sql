ALTER TYPE "AdoptedRouteStatus" ADD VALUE 'UNDONE';
ALTER TYPE "OperationType" ADD VALUE 'ROUTE_UNDO';
ALTER TYPE "OutboxEventType" ADD VALUE 'ROUTE_UNDONE';

ALTER TABLE "AdoptedRoute"
  ADD COLUMN "undoneAt" TIMESTAMPTZ(3);

CREATE UNIQUE INDEX "AdoptedRoute_active_corridor_key"
  ON "AdoptedRoute"("tripId", "anchorFromNodeId", "anchorToNodeId")
  WHERE "status" = 'ACTIVE';

ALTER TABLE "OperationReceipt"
  ADD COLUMN "targetOperationReceiptId" UUID,
  ADD COLUMN "undoExpiresAt" TIMESTAMPTZ(3);

CREATE UNIQUE INDEX "OperationReceipt_targetOperationReceiptId_key"
  ON "OperationReceipt"("targetOperationReceiptId");

ALTER TABLE "OperationReceipt"
  ADD CONSTRAINT "OperationReceipt_targetOperationReceiptId_fkey"
  FOREIGN KEY ("targetOperationReceiptId") REFERENCES "OperationReceipt"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OperationReceipt"
  ADD CONSTRAINT "OperationReceipt_operation_target_check"
  CHECK (
    ("operationType" = 'ROUTE_ADOPT' AND "targetOperationReceiptId" IS NULL)
    OR
    ("operationType" = 'ROUTE_UNDO' AND "targetOperationReceiptId" IS NOT NULL)
  );
