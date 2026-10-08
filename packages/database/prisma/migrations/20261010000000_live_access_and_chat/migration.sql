-- Live streams are sold by one price for permanent access (owner request, 2026-10-08) instead of per minute.
-- Buyers keep a "VideoPurchase" row whose expiry lies far in the future.
ALTER TABLE "Video" ADD COLUMN "accessPriceSTRM" DECIMAL(38,18);

-- Chat under live streams.
CREATE TABLE "LiveChatMessage" (
    "id" SERIAL NOT NULL,
    "liveStreamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "LiveChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LiveChatMessage_liveStreamId_id_idx" ON "LiveChatMessage"("liveStreamId", "id");
CREATE INDEX "LiveChatMessage_liveStreamId_removedAt_idx" ON "LiveChatMessage"("liveStreamId", "removedAt");

-- AddForeignKey
ALTER TABLE "LiveChatMessage" ADD CONSTRAINT "LiveChatMessage_liveStreamId_fkey" FOREIGN KEY ("liveStreamId") REFERENCES "LiveStream"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LiveChatMessage" ADD CONSTRAINT "LiveChatMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
