import { prisma } from '../db/prisma.js';
import { FEE_PERCENTAGE, LAMPORTS_PER_SOL } from '../utils/constants.js';
import { config } from '../utils/config.js';
import { sendSol, getWalletBalance } from './wallet.js';
import { createChildLogger } from '../utils/logger.js';
import { bot } from '../bot/bot.js';
import { withLock } from '../utils/locks.js';

const logger = createChildLogger('settlement');

// Settle all rounds for completed games
export async function settleCompletedGames(): Promise<void> {
  // Use distributed lock for entire settlement process
  const result = await withLock('scheduler:settlement', async () => {
    // Find all games that are FINAL with active rounds
    const games = await prisma.game.findMany({
      where: {
        status: 'FINAL',
        winner: { not: null },
        rounds: {
          some: {
            status: 'LOCKED',
          },
        },
      },
      include: {
        rounds: {
          where: {
            status: 'LOCKED',
          },
          include: {
            wagers: {
              include: {
                user: true,
              },
            },
          },
        },
      },
    });

    for (const game of games) {
      for (const round of game.rounds) {
        try {
          await settleRound(round, game.winner!, game);
        } catch (error) {
          logger.error({ error, roundId: round.id }, 'Failed to settle round');
        }
      }
    }
    return true;
  }, 300000); // 5 minute lock timeout for settlement

  if (result === null) {
    logger.debug('Skipping settlement - another instance is already settling');
  }
}

// Settle a single round
async function settleRound(
  round: {
    id: string;
    chatId: bigint;
    walletAddress: string;
    walletSecretKey: string;
    wagers: Array<{
      id: string;
      teamPick: string;
      amount: bigint;
      paidOut?: boolean;
      user: {
        id: string;
        username: string | null;
        solanaAddress: string | null;
      };
    }>;
  },
  winner: string,
  game: { homeTeam: string; awayTeam: string }
): Promise<void> {
  // Use per-round lock to prevent concurrent settlement of same round
  const result = await withLock(`round:settle:${round.id}`, async () => {
    // Re-check round status inside lock (idempotency check)
    const currentRound = await prisma.round.findUnique({
      where: { id: round.id },
      select: { status: true },
    });

    if (!currentRound || currentRound.status !== 'LOCKED') {
      logger.info({ roundId: round.id, status: currentRound?.status }, 'Round already settled or not locked');
      return { skipped: true };
    }

    logger.info({ roundId: round.id, winner }, 'Settling round');

    // Get current wallet balance
    const balance = await getWalletBalance(round.walletAddress);

    if (balance === BigInt(0)) {
      logger.warn({ roundId: round.id }, 'Round wallet is empty, marking as settled');
      await prisma.round.update({
        where: { id: round.id },
        data: { status: 'SETTLED', settledAt: new Date() },
      });
      return { skipped: true };
    }

    return { skipped: false, balance };
  }, 120000); // 2 minute lock timeout

  if (result === null) {
    logger.debug({ roundId: round.id }, 'Skipping round - another instance is settling it');
    return;
  }

  if (result.skipped || !result.balance) {
    return;
  }

  const balance = result.balance;

  // Calculate fee
  const fee = (balance * BigInt(Math.floor(FEE_PERCENTAGE * 10000))) / BigInt(10000);
  const remainingPot = balance - fee;

  // Find winning wagers
  const winningWagers = round.wagers.filter((w) => w.teamPick === winner);
  const totalWinningAmount = winningWagers.reduce((sum, w) => sum + w.amount, BigInt(0));
  const winningTeam = winner === 'home' ? game.homeTeam : game.awayTeam;

  if (winningWagers.length === 0 || totalWinningAmount === BigInt(0)) {
    // No winners - this shouldn't happen normally
    // Could refund all bettors, but for now just send to treasury
    logger.warn({ roundId: round.id }, 'No winning wagers found');

    if (fee > BigInt(0)) {
      await sendSol(round.walletSecretKey, config.TREASURY_WALLET_ADDRESS, balance);
    }

    await prisma.round.update({
      where: { id: round.id },
      data: { status: 'SETTLED', settledAt: new Date() },
    });
    return;
  }

  // Send fee to treasury
  if (fee > BigInt(5000)) {
    // Only if fee covers tx cost
    try {
      await sendSol(round.walletSecretKey, config.TREASURY_WALLET_ADDRESS, fee);
      logger.info({ roundId: round.id, fee: fee.toString() }, 'Fee sent to treasury');
    } catch (error) {
      logger.error({ error, roundId: round.id }, 'Failed to send fee to treasury');
    }
  }

  // Calculate and send payouts to winners
  let payoutsSuccessful = true;
  const payoutResults: Array<{ username: string | null; payout: number }> = [];

  for (const wager of winningWagers) {
    if (!wager.user.solanaAddress) {
      logger.warn(
        { wagerId: wager.id, userId: wager.user.id },
        'Winner has no payout address'
      );
      continue;
    }

    // Calculate proportional payout
    // payout = (wager.amount / totalWinningAmount) * remainingPot
    const payout = (wager.amount * remainingPot) / totalWinningAmount;

    if (payout <= BigInt(5000)) {
      // Skip if payout doesn't cover tx cost
      logger.warn({ wagerId: wager.id, payout: payout.toString() }, 'Payout too small');
      continue;
    }

    try {
      const signature = await sendSol(
        round.walletSecretKey,
        wager.user.solanaAddress,
        payout
      );

      await prisma.wager.update({
        where: { id: wager.id },
        data: {
          paidOut: true,
          payoutTx: signature,
        },
      });

      payoutResults.push({
        username: wager.user.username,
        payout: Number(payout) / LAMPORTS_PER_SOL,
      });

      logger.info(
        {
          wagerId: wager.id,
          payout: payout.toString(),
          signature,
        },
        'Payout sent'
      );
    } catch (error) {
      logger.error({ error, wagerId: wager.id }, 'Failed to send payout');
      payoutsSuccessful = false;
    }
  }

  // Mark round as settled
  if (payoutsSuccessful) {
    await prisma.round.update({
      where: { id: round.id },
      data: { status: 'SETTLED', settledAt: new Date() },
    });

    // Send notification to chat about settlement
    try {
      // Build winners list
      const winnerLines = payoutResults.map((p) => {
        const name = p.username ? `@${p.username}` : 'User';
        return `  ${name}: +${p.payout.toFixed(4)} SOL`;
      }).join('\n');

      // Build losers list
      const losingWagers = round.wagers.filter((w) => w.teamPick !== winner && w.amount > BigInt(0));
      const loserLines = losingWagers.map((w) => {
        const name = w.user.username ? `@${w.user.username}` : 'User';
        const lost = Number(w.amount) / LAMPORTS_PER_SOL;
        return `  ${name}: -${lost.toFixed(4)} SOL`;
      }).join('\n');

      const losingTeam = winner === 'home' ? game.awayTeam : game.homeTeam;

      let message = `🎉 ${winningTeam} wins!\n\n` +
        `${game.awayTeam} @ ${game.homeTeam}\n\n`;

      if (winnerLines) {
        message += `Winners:\n${winnerLines}\n\n`;
      }

      if (loserLines) {
        message += `Losers:\n${loserLines}\n\n`;
      }

      message += `Thanks for using Bettr!`;

      await bot.api.sendMessage(round.chatId.toString(), message);
    } catch (notifyError) {
      logger.warn({ error: notifyError, chatId: round.chatId }, 'Failed to send settlement notification');
    }

    logger.info({ roundId: round.id }, 'Round settled successfully');
  }
}

// Refund a cancelled game
export async function refundCancelledGame(gameId: string): Promise<void> {
  const rounds = await prisma.round.findMany({
    where: {
      gameId,
      status: { in: ['OPEN', 'LOCKED'] },
    },
    include: {
      wagers: {
        include: {
          user: true,
        },
      },
    },
  });

  for (const round of rounds) {
    try {
      await refundRound(round);
    } catch (error) {
      logger.error({ error, roundId: round.id }, 'Failed to refund round');
    }
  }
}

// Refund all wagers in a round
async function refundRound(
  round: {
    id: string;
    walletAddress: string;
    walletSecretKey: string;
    wagers: Array<{
      id: string;
      amount: bigint;
      paidOut?: boolean;
      user: {
        solanaAddress: string | null;
      };
    }>;
  }
): Promise<void> {
  // Use same lock as settlement to prevent refund/payout race condition
  const result = await withLock(`round:settle:${round.id}`, async () => {
    // Re-check round status inside lock
    const currentRound = await prisma.round.findUnique({
      where: { id: round.id },
      select: { status: true },
    });

    // Don't refund if already settled or cancelled
    if (!currentRound || currentRound.status === 'SETTLED' || currentRound.status === 'CANCELLED') {
      logger.info({ roundId: round.id, status: currentRound?.status }, 'Round already settled/cancelled, skipping refund');
      return { skipped: true };
    }

    return { skipped: false };
  }, 120000);

  if (result === null) {
    logger.debug({ roundId: round.id }, 'Skipping refund - another operation in progress');
    return;
  }

  if (result.skipped) {
    return;
  }

  logger.info({ roundId: round.id }, 'Refunding round');

  for (const wager of round.wagers) {
    // Skip if already paid out or no address
    if (wager.paidOut || !wager.user.solanaAddress || wager.amount <= BigInt(5000)) {
      continue;
    }

    try {
      const signature = await sendSol(
        round.walletSecretKey,
        wager.user.solanaAddress,
        wager.amount
      );

      await prisma.wager.update({
        where: { id: wager.id },
        data: {
          paidOut: true,
          payoutTx: signature,
        },
      });

      logger.info({ wagerId: wager.id, signature }, 'Refund sent');
    } catch (error) {
      logger.error({ error, wagerId: wager.id }, 'Failed to send refund');
    }
  }

  await prisma.round.update({
    where: { id: round.id },
    data: { status: 'CANCELLED', settledAt: new Date() },
  });
}
