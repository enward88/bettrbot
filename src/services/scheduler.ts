import cron from 'node-cron';
import { prisma } from '../db/prisma.js';
import { refreshTodaysGames, checkGameResults } from './sports.js';
import { getRecentTransactions, getConnection } from './wallet.js';
import { settleCompletedGames } from './settlement.js';
import { settleHouseBets, cancelExpiredHouseBets, pollHouseBetWallets, sweepSettledHouseBets } from './houseBet.js';
import { createChildLogger } from '../utils/logger.js';
import { bot } from '../bot/bot.js';
import { MIN_BET_LAMPORTS, LAMPORTS_PER_SOL } from '../utils/constants.js';

const logger = createChildLogger('scheduler');

// Track processed transactions to avoid duplicates
const processedTxSignatures = new Set<string>();

// Monitor wallets for deposits
async function pollWalletDeposits(): Promise<void> {
  // Get all open rounds with their wagers
  const rounds = await prisma.round.findMany({
    where: { status: 'OPEN' },
    include: {
      wagers: {
        include: {
          user: true,
        },
      },
      game: true,
    },
  });

  for (const round of rounds) {
    try {
      // Get recent transactions to the wallet
      const transactions = await getRecentTransactions(round.walletAddress, 20);

      for (const tx of transactions) {
        // Skip if already processed
        if (processedTxSignatures.has(tx.signature)) {
          continue;
        }

        // Get transaction details to find deposit amount
        const conn = getConnection();
        const txDetails = await conn.getTransaction(tx.signature, {
          maxSupportedTransactionVersion: 0,
        });

        if (!txDetails || !txDetails.meta) {
          continue;
        }

        // Find the deposit amount by checking account balance changes
        const accountKeys = txDetails.transaction.message.getAccountKeys().staticAccountKeys;
        let depositAmount = BigInt(0);

        for (let i = 0; i < accountKeys.length; i++) {
          const key = accountKeys[i];
          if (key && key.toBase58() === round.walletAddress) {
            const pre = BigInt(txDetails.meta.preBalances[i] ?? 0);
            const post = BigInt(txDetails.meta.postBalances[i] ?? 0);
            if (post > pre) {
              depositAmount = post - pre;
            }
            break;
          }
        }

        if (depositAmount < MIN_BET_LAMPORTS) {
          processedTxSignatures.add(tx.signature);
          continue;
        }

        // Find a pending wager (amount = 0) without a tx signature to assign this to
        const pendingWager = round.wagers.find(
          (w) => w.amount === BigInt(0) && !w.txSignature
        );

        if (pendingWager) {
          // Update the wager with the deposit
          await prisma.wager.update({
            where: { id: pendingWager.id },
            data: {
              amount: depositAmount,
              txSignature: tx.signature,
            },
          });

          // Update round total
          const updatedRound = await prisma.round.update({
            where: { id: round.id },
            data: {
              totalPot: { increment: depositAmount },
            },
          });

          const solAmount = Number(depositAmount) / LAMPORTS_PER_SOL;
          const teamName = pendingWager.teamPick === 'home'
            ? round.game.homeTeam
            : round.game.awayTeam;

          // Notify the chat
          try {
            const username = pendingWager.user.username
              ? `@${pendingWager.user.username}`
              : 'Someone';

            await bot.api.sendMessage(
              round.chatId.toString(),
              `${username} bet ${solAmount.toFixed(4)} SOL on ${teamName}!\n\n` +
              `${round.game.awayTeam} @ ${round.game.homeTeam}\n` +
              `Total pot: ${(Number(updatedRound.totalPot) / LAMPORTS_PER_SOL).toFixed(4)} SOL`
            );
          } catch (notifyError) {
            logger.warn({ error: notifyError, chatId: round.chatId }, 'Failed to send deposit notification');
          }

          logger.info(
            {
              roundId: round.id,
              wagerId: pendingWager.id,
              amount: depositAmount.toString(),
              txSignature: tx.signature,
            },
            'Deposit linked to wager'
          );
        } else {
          // No pending wager - log and notify about unattributed deposit
          logger.warn(
            {
              roundId: round.id,
              amount: depositAmount.toString(),
              txSignature: tx.signature,
            },
            'Deposit received but no pending wager to assign'
          );

          // Still update the round total
          await prisma.round.update({
            where: { id: round.id },
            data: {
              totalPot: { increment: depositAmount },
            },
          });
        }

        processedTxSignatures.add(tx.signature);
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
    include: {
      game: true,
      wagers: {
        where: { amount: { gt: 0 } },
      },
    },
  });

  for (const round of expiredRounds) {
    await prisma.round.update({
      where: { id: round.id },
      data: { status: 'LOCKED' },
    });

    // Notify the chat that bets are locked
    if (round.wagers.length > 0) {
      try {
        const homeWagers = round.wagers.filter((w) => w.teamPick === 'home');
        const awayWagers = round.wagers.filter((w) => w.teamPick === 'away');
        const homeTotalSol = homeWagers.reduce((sum, w) => sum + Number(w.amount), 0) / LAMPORTS_PER_SOL;
        const awayTotalSol = awayWagers.reduce((sum, w) => sum + Number(w.amount), 0) / LAMPORTS_PER_SOL;

        await bot.api.sendMessage(
          round.chatId.toString(),
          `🔒 Bets are LOCKED for ${round.game.awayTeam} @ ${round.game.homeTeam}!\n\n` +
          `${round.game.homeTeam}: ${homeTotalSol.toFixed(4)} SOL (${homeWagers.length} bets)\n` +
          `${round.game.awayTeam}: ${awayTotalSol.toFixed(4)} SOL (${awayWagers.length} bets)\n\n` +
          `Total pot: ${(Number(round.totalPot) / LAMPORTS_PER_SOL).toFixed(4)} SOL\n\n` +
          `Winners will be paid when the game ends!`
        );
      } catch (notifyError) {
        logger.warn({ error: notifyError, chatId: round.chatId }, 'Failed to send lock notification');
      }
    }

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
    await pollHouseBetWallets();
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
    await settleHouseBets();
  });

  // Cancel expired pending house bets every 10 minutes
  cron.schedule('*/10 * * * *', async () => {
    await cancelExpiredHouseBets();
  });

  // Sweep settled house bet wallets to treasury daily at 4 AM
  cron.schedule('0 4 * * *', async () => {
    logger.info('Running daily house bet wallet sweep');
    await sweepSettledHouseBets();
  });

  // Mark stale games as cancelled (games that started 6+ hours ago but still SCHEDULED)
  cron.schedule('0 * * * *', async () => {
    await cleanupStaleGames();
  });

  // Initial game refresh on startup
  refreshTodaysGames().catch((error) => {
    logger.error({ error }, 'Failed initial game refresh');
  });

  // Initial stale game cleanup
  cleanupStaleGames().catch((error) => {
    logger.error({ error }, 'Failed initial stale game cleanup');
  });

  logger.info('Scheduler started');
}

// Mark games as cancelled if they started 6+ hours ago but are still SCHEDULED
// This handles cases where the API fails to update game status
async function cleanupStaleGames(): Promise<void> {
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);

  const staleGames = await prisma.game.updateMany({
    where: {
      status: 'SCHEDULED',
      startTime: { lt: sixHoursAgo },
    },
    data: {
      status: 'CANCELLED',
    },
  });

  if (staleGames.count > 0) {
    logger.info({ count: staleGames.count }, 'Marked stale scheduled games as cancelled');
  }
}
