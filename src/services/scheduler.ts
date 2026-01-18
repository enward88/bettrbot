import cron from 'node-cron';
import { prisma } from '../db/prisma.js';
import { refreshTodaysGames, checkGameResults } from './sports.js';
import { getWalletBalance } from './wallet.js';
import { settleCompletedGames } from './settlement.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('scheduler');

// Monitor wallets for deposits
async function pollWalletDeposits(): Promise<void> {
  // Get all open rounds
  const rounds = await prisma.round.findMany({
    where: { status: 'OPEN' },
    include: {
      wagers: true,
    },
  });

  for (const round of rounds) {
    try {
      const balance = await getWalletBalance(round.walletAddress);

      if (balance !== round.totalPot) {
        // Balance changed - update and notify
        await prisma.round.update({
          where: { id: round.id },
          data: { totalPot: balance },
        });

        logger.info(
          {
            roundId: round.id,
            oldBalance: round.totalPot.toString(),
            newBalance: balance.toString(),
          },
          'Wallet balance changed'
        );

        // TODO: Update wager amounts based on detected deposits
        // This requires tracking individual deposits via transaction signatures
      }
    } catch (error) {
      logger.error({ error, roundId: round.id }, 'Failed to poll wallet');
    }
  }
}

// Lock bets when games start
async function lockExpiredRounds(): Promise<void> {
  const now = new Date();

  const expiredRounds = await prisma.round.findMany({
    where: {
      status: 'OPEN',
      expiresAt: { lte: now },
    },
  });

  for (const round of expiredRounds) {
    await prisma.round.update({
      where: { id: round.id },
      data: { status: 'LOCKED' },
    });

    logger.info({ roundId: round.id }, 'Round locked (game started)');
  }
}

// Start all scheduled tasks
export function startScheduler(): void {
  logger.info('Starting scheduler');

  // Refresh games every hour
  cron.schedule('0 * * * *', async () => {
    logger.info('Running scheduled game refresh');
    await refreshTodaysGames();
  });

  // Poll wallets every 30 seconds
  cron.schedule('*/30 * * * * *', async () => {
    await pollWalletDeposits();
  });

  // Lock expired rounds every minute
  cron.schedule('* * * * *', async () => {
    await lockExpiredRounds();
  });

  // Check game results every 2 minutes
  cron.schedule('*/2 * * * *', async () => {
    await checkGameResults();
  });

  // Settle completed games every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    await settleCompletedGames();
  });

  // Initial game refresh on startup
  refreshTodaysGames().catch((error) => {
    logger.error({ error }, 'Failed initial game refresh');
  });

  logger.info('Scheduler started');
}
