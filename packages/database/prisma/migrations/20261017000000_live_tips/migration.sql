-- Tips during live streams: paid like any payment (one settlement, same platform fee), shown highlighted in the chat.
ALTER TABLE "LiveChatMessage" ADD COLUMN "tipSTRM" DECIMAL(38,18);

CREATE TABLE "Tip" (
    "id" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "liveStreamId" TEXT NOT NULL,
    "amountSTRM" DECIMAL(38,18) NOT NULL,
    "settlementId" TEXT NOT NULL,
    "chatMessageId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tip_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tip_settlementId_key" ON "Tip"("settlementId");
CREATE UNIQUE INDEX "Tip_chatMessageId_key" ON "Tip"("chatMessageId");
CREATE INDEX "Tip_liveStreamId_createdAt_idx" ON "Tip"("liveStreamId", "createdAt");
CREATE INDEX "Tip_fromUserId_idx" ON "Tip"("fromUserId");
CREATE INDEX "Tip_createdAt_idx" ON "Tip"("createdAt");

-- AddForeignKey
ALTER TABLE "Tip" ADD CONSTRAINT "Tip_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Tip" ADD CONSTRAINT "Tip_liveStreamId_fkey" FOREIGN KEY ("liveStreamId") REFERENCES "LiveStream"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Tip" ADD CONSTRAINT "Tip_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "PaymentSettlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Tip" ADD CONSTRAINT "Tip_chatMessageId_fkey" FOREIGN KEY ("chatMessageId") REFERENCES "LiveChatMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
