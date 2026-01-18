-- CreateEnum
CREATE TYPE "BetType" AS ENUM ('MONEYLINE', 'SPREAD', 'TOTAL_OVER', 'TOTAL_UNDER');

-- CreateEnum
CREATE TYPE "HouseBetStatus" AS ENUM ('PENDING', 'ACTIVE', 'SETTLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "HouseBetResult" AS ENUM ('WIN', 'LOSS', 'PUSH');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "Sport" ADD VALUE 'MLB';
ALTER TYPE "Sport" ADD VALUE 'WNBA';
ALTER TYPE "Sport" ADD VALUE 'NCAAB';
ALTER TYPE "Sport" ADD VALUE 'EPL';
ALTER TYPE "Sport" ADD VALUE 'MLS';
ALTER TYPE "Sport" ADD VALUE 'LALIGA';
ALTER TYPE "Sport" ADD VALUE 'SERIEA';
ALTER TYPE "Sport" ADD VALUE 'BUNDESLIGA';
ALTER TYPE "Sport" ADD VALUE 'LIGUE1';
ALTER TYPE "Sport" ADD VALUE 'UCL';
ALTER TYPE "Sport" ADD VALUE 'CS2';
ALTER TYPE "Sport" ADD VALUE 'LOL';
ALTER TYPE "Sport" ADD VALUE 'DOTA2';

-- AlterTable
ALTER TABLE "Game" ADD COLUMN     "awayMoneyline" INTEGER,
ADD COLUMN     "awaySpread" DOUBLE PRECISION,
ADD COLUMN     "homeMoneyline" INTEGER,
ADD COLUMN     "homeSpread" DOUBLE PRECISION,
ADD COLUMN     "oddsUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "overOdds" INTEGER,
ADD COLUMN     "spreadOdds" INTEGER,
ADD COLUMN     "totalLine" DOUBLE PRECISION,
ADD COLUMN     "underOdds" INTEGER;

-- CreateTable
CREATE TABLE "HouseBet" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "betType" "BetType" NOT NULL,
    "pick" TEXT NOT NULL,
    "odds" INTEGER NOT NULL,
    "line" DOUBLE PRECISION,
    "amount" BIGINT NOT NULL,
    "potentialWin" BIGINT NOT NULL,
    "txSignature" TEXT,
    "status" "HouseBetStatus" NOT NULL DEFAULT 'PENDING',
    "result" "HouseBetResult",
    "payoutTx" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "HouseBet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HouseBet_gameId_idx" ON "HouseBet"("gameId");

-- CreateIndex
CREATE INDEX "HouseBet_userId_idx" ON "HouseBet"("userId");

-- CreateIndex
CREATE INDEX "HouseBet_status_idx" ON "HouseBet"("status");

-- AddForeignKey
ALTER TABLE "HouseBet" ADD CONSTRAINT "HouseBet_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HouseBet" ADD CONSTRAINT "HouseBet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
