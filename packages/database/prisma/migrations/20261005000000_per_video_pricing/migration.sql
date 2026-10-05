-- Videos now have one price instead of a per-minute rate. Existing rates are converted to a price for the whole video.
ALTER TABLE "Video" ADD COLUMN "priceSTRM" DECIMAL(38,18) NOT NULL DEFAULT 20;
UPDATE "Video" SET "priceSTRM" = ROUND("ratePerMinuteSTRM" * GREATEST("durationSeconds", 60) / 60.0, 2);
ALTER TABLE "Video" DROP COLUMN "ratePerMinuteSTRM";

-- A settlement can now belong to a purchase instead of a watch session.
ALTER TABLE "PaymentSettlement" DROP CONSTRAINT "PaymentSettlement_sessionId_fkey";
ALTER TABLE "PaymentSettlement" ALTER COLUMN "sessionId" DROP NOT NULL;
ALTER TABLE "PaymentSettlement" ADD CONSTRAINT "PaymentSettlement_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "WatchSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "VideoPurchase" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "amountSTRM" DECIMAL(38,18) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VideoPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VideoPurchase_settlementId_key" ON "VideoPurchase"("settlementId");

-- CreateIndex
CREATE INDEX "VideoPurchase_userId_videoId_expiresAt_idx" ON "VideoPurchase"("userId", "videoId", "expiresAt");

-- CreateIndex
CREATE INDEX "VideoPurchase_videoId_idx" ON "VideoPurchase"("videoId");

-- AddForeignKey
ALTER TABLE "VideoPurchase" ADD CONSTRAINT "VideoPurchase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoPurchase" ADD CONSTRAINT "VideoPurchase_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoPurchase" ADD CONSTRAINT "VideoPurchase_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "PaymentSettlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
