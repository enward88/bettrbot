import { prisma } from '../db/prisma.js';
import { FEE_PERCENTAGE, LAMPORTS_PER_SOL } from '../utils/constants.js';
import { config } from '../utils/config.js';
import { sendSol, getWalletBalance } from './wallet.js';
import { createChildLogger } from '../utils/logger.js';
import { bot } from '../bot/bot.js';

const logger = createChildLogger('settlement');

// Settle all rounds for completed games
export async function settleCompletedGames(): Promise<void> {
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
  logger.info({ roundId: round.id, winner }, 'Settling round');

  // Get current wallet balance
  const balance = await getWalletBalance(round.walletAddress);

  if (balance === BigInt(0)) {
    logger.warn({ roundId: round.id }, 'Round wallet is empty, marking as settled');
    await prisma.round.update({
      where: { id: round.id },
      data: { status: 'SETTLED', settledAt: new Date() },
    });
    return;
  }

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
    if (payoutResults.length > 0) {
      try {
        const payoutLines = payoutResults.map((p) => {
          const name = p.username ? `@${p.username}` : 'User';
          return `  ${name}: ${p.payout.toFixed(4)} SOL`;
        }).join('\n');

        await bot.api.sendMessage(
          round.chatId.toString(),
          `🎉 ${winningTeam} wins!\n\n` +
          `${game.awayTeam} @ ${game.homeTeam}\n\n` +
          `Payouts sent:\n${payoutLines}\n\n` +
          `Thanks for using Bettr!`
        );
      } catch (notifyError) {
        logger.warn({ error: notifyError, chatId: round.chatId }, 'Failed to send settlement notification');
      }
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
      user: {
        solanaAddress: string | null;
      };
    }>;
  }
): Promise<void> {
  logger.info({ roundId: round.id }, 'Refunding round');

  for (const wager of round.wagers) {
    if (!wager.user.solanaAddress || wager.amount <= BigInt(5000)) {
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
