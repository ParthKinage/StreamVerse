-- Reports and moderation: viewers report videos, chat messages and channels; admins hide videos and suspend accounts.
CREATE TYPE "ReportTarget" AS ENUM ('VIDEO', 'CHAT_MESSAGE', 'CHANNEL');
CREATE TYPE "ReportReason" AS ENUM ('SPAM', 'ABUSE', 'SEXUAL', 'COPYRIGHT', 'OTHER');
CREATE TYPE "ReportStatus" AS ENUM ('OPEN', 'DISMISSED', 'ACTIONED');

ALTER TABLE "User" ADD COLUMN "suspendedAt" TIMESTAMP(3),
ADD COLUMN "suspendReason" TEXT;

ALTER TABLE "Video" ADD COLUMN "hiddenAt" TIMESTAMP(3),
ADD COLUMN "hiddenReason" TEXT;

CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "targetType" "ReportTarget" NOT NULL,
    "targetId" TEXT NOT NULL,
    "reason" "ReportReason" NOT NULL,
    "details" TEXT,
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Report_reporterId_targetType_targetId_key" ON "Report"("reporterId", "targetType", "targetId");
CREATE INDEX "Report_status_targetType_targetId_idx" ON "Report"("status", "targetType", "targetId");
CREATE INDEX "Report_createdAt_idx" ON "Report"("createdAt");

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
