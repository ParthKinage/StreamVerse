-- Per-second billing: creators set a rate per minute, and a viewer pays once for each piece of a video the player is
-- sent. Pieces already paid for are free to watch again, forever. Replaces the one-price 48-hour unlock.
ALTER TABLE "Video" ADD COLUMN "ratePerMinuteSTRM" DECIMAL(38,18) NOT NULL DEFAULT 1;

-- Existing videos keep the cost of watching them in full: rate = old price spread over the video's length.
UPDATE "Video"
SET "ratePerMinuteSTRM" = CASE
    WHEN "durationSeconds" > 0 THEN ROUND("priceSTRM" * 60 / "durationSeconds", 18)
    ELSE "priceSTRM"
END;

-- One row per (viewer, video, 4-second piece) the viewer has paid for.
CREATE TABLE "PaidSegment" (
    "userId" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "segmentIndex" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "amountSTRM" DECIMAL(38,18) NOT NULL,
    "sessionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaidSegment_pkey" PRIMARY KEY ("userId","videoId","segmentIndex")
);

-- CreateIndex
CREATE INDEX "PaidSegment_sessionId_idx" ON "PaidSegment"("sessionId");
CREATE INDEX "PaidSegment_videoId_idx" ON "PaidSegment"("videoId");

-- AddForeignKey
ALTER TABLE "PaidSegment" ADD CONSTRAINT "PaidSegment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaidSegment" ADD CONSTRAINT "PaidSegment_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
