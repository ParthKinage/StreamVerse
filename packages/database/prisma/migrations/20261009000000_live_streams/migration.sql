-- Live streaming from the browser. A live stream owns a normal "Video" row: viewers' sessions and per-second charges
-- attach to that video, and when the stream ends the video becomes the recording.
CREATE TYPE "LiveStatus" AS ENUM ('CREATED', 'STARTING', 'LIVE', 'ENDING', 'ENDED', 'FAILED');

CREATE TABLE "LiveStream" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "status" "LiveStatus" NOT NULL DEFAULT 'CREATED',
    "saveAsVod" BOOLEAN NOT NULL DEFAULT true,
    "codecs" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "bandwidth" INTEGER,
    "initSeq" INTEGER NOT NULL DEFAULT 0,
    "peakViewers" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "lastPieceAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LiveStream_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LiveSegment" (
    "liveStreamId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "initSeq" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LiveSegment_pkey" PRIMARY KEY ("liveStreamId","index")
);

-- CreateIndex
CREATE UNIQUE INDEX "LiveStream_videoId_key" ON "LiveStream"("videoId");
CREATE INDEX "LiveStream_status_startedAt_idx" ON "LiveStream"("status", "startedAt");
CREATE INDEX "LiveStream_creatorId_createdAt_idx" ON "LiveStream"("creatorId", "createdAt");

-- AddForeignKey
ALTER TABLE "LiveStream" ADD CONSTRAINT "LiveStream_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LiveStream" ADD CONSTRAINT "LiveStream_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LiveSegment" ADD CONSTRAINT "LiveSegment_liveStreamId_fkey" FOREIGN KEY ("liveStreamId") REFERENCES "LiveStream"("id") ON DELETE CASCADE ON UPDATE CASCADE;
