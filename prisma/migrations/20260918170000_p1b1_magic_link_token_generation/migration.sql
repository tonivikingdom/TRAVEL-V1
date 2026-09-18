ALTER TABLE "MagicLinkDeliveryRequest"
  ADD COLUMN "tokenGeneration" INTEGER NOT NULL DEFAULT 0;

UPDATE "MagicLinkDeliveryRequest" AS delivery
SET "tokenGeneration" = 1
WHERE EXISTS (
  SELECT 1
  FROM "MagicLinkToken" AS token
  WHERE token."deliveryRequestId" = delivery."id"
);

ALTER TABLE "MagicLinkDeliveryRequest"
  ADD CONSTRAINT "MagicLinkDeliveryRequest_tokenGeneration_check"
  CHECK ("tokenGeneration" >= 0);
