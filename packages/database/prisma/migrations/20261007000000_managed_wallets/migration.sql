-- Built-in wallets: one blockchain address per user, derived from the platform's master seed (no keys stored).
CREATE TABLE "ManagedWallet" (
    "index" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManagedWallet_pkey" PRIMARY KEY ("index")
);

-- Coins bought by viewers, credited on-chain by the relayer.
CREATE TABLE "CoinOrder" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "amountSTRM" DECIMAL(38,18) NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'demo-bank',
    "bankAccountId" TEXT,
    "label" TEXT NOT NULL,
    "status" "RewardStatus" NOT NULL DEFAULT 'PENDING',
    "txHash" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoinOrder_pkey" PRIMARY KEY ("id")
);

-- Facts about this installation.
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "ManagedWallet_userId_key" ON "ManagedWallet"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ManagedWallet_address_key" ON "ManagedWallet"("address");

-- CreateIndex
CREATE INDEX "CoinOrder_status_createdAt_idx" ON "CoinOrder"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CoinOrder_userId_createdAt_idx" ON "CoinOrder"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "ManagedWallet" ADD CONSTRAINT "ManagedWallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoinOrder" ADD CONSTRAINT "CoinOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
