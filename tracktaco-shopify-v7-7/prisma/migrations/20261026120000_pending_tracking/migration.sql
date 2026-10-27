CREATE TABLE "PendingTracking" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "shop" TEXT NOT NULL,
 "orderId" TEXT NOT NULL,
 "orderName" TEXT NOT NULL,
 "tnId" TEXT NOT NULL,
 "trackingNumber" TEXT NOT NULL,
 "carrier" TEXT NOT NULL,
 "destinationCity" TEXT NOT NULL,
 "destinationState" TEXT,
 "destinationCountry" TEXT NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'PENDING',
 "verificationNote" TEXT,
 "reviewedAt" TIMESTAMP(3),
 "lastError" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "PendingTracking_shop_orderId_tnId_key" ON "PendingTracking"("shop","orderId","tnId");
CREATE INDEX "PendingTracking_shop_status_createdAt_idx" ON "PendingTracking"("shop","status","createdAt");
