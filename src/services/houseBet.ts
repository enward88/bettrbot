import { prisma } from '../db/prisma.js';
import { config } from '../utils/config.js';
import { LAMPORTS_PER_SOL } from '../utils/constants.js';
import { sendSol, getWalletBalance, createRoundWallet } from './wallet.js';
import { calculatePayout, formatOdds } from './odds.js';
import { createChildLogger } from '../utils/logger.js';
import { bot } from '../bot/bot.js';
import type { BetType, HouseBetResult } from '@prisma/client';

const logger = createChildLogger('houseBet');

// Create a new house bet (user betting against treasury)
export async function createHouseBet(params: {
  gameId: string;
  userId: string;
  chatId: bigint;
  betType: BetType;
  pick: string; // "home", "away", "over", "under"
  amount: bigint;
}): Promise<{
  id: string;
  depositAddress: string;
  odds: number;
  line: number | null;
  potentialWin: bigint;
} | null> {
  const { gameId, userId, chatId, betType, pick, amount } = params;

  // Get game with current odds
  const game = await prisma.game.findUnique({
    where: { id: gameId },
  });

  if (!game) {
    logger.warn({ gameId }, 'Game not found for house bet');
    return null;
  }

  if (game.status !== 'SCHEDULED') {
    logger.warn({ gameId, status: game.status }, 'Game not available for betting');
    return null;
  }

  // Determine odds and line based on bet type and pick
  let odds: number | null = null;
  let line: number | null = null;

  switch (betType) {
    case 'MONEYLINE':
      odds = pick === 'home' ? game.homeMoneyline : game.awayMoneyline;
      break;
    case 'SPREAD':
      odds = game.spreadOdds;
      line = pick === 'home' ? game.homeSpread : game.awaySpread;
      break;
    case 'TOTAL_OVER':
      odds = game.overOdds;
      line = game.totalLine;
      break;
    case 'TOTAL_UNDER':
      odds = game.underOdds;
      line = game.totalLine;
      break;
  }

  if (odds === null) {
    logger.warn({ gameId, betType, pick }, 'Odds not available for this bet type');
    return null;
  }

  // Calculate potential win
  const potentialWin = calculatePayout(amount, odds);

  // Create unique deposit wallet for this bet
  const { address: depositAddress, encryptedSecretKey: depositSecretKey } = await createRoundWallet();

  // Create the house bet with unique deposit wallet
  const houseBet = await prisma.houseBet.create({
    data: {
      gameId,
      userId,
      chatId,
      betType,
      pick,
      odds,
      line,
      amount,
      potentialWin,
      depositAddress,
      depositSecretKey,
      status: 'PENDING',
    },
  });

  logger.info(
    {
      houseBetId: houseBet.id,
      gameId,
      userId,
      betType,
      pick,
      odds,
      amount: amount.toString(),
      potentialWin: potentialWin.toString(),
    },
    'House bet created'
  );

  return {
    id: houseBet.id,
    depositAddress,
    odds,
    line,
    potentialWin,
  };
}

// Confirm a house bet deposit (called when deposit detected)
export async function confirmHouseBetDeposit(
  houseBetId: string,
  txSignature: string
): Promise<boolean> {
  try {
    await prisma.houseBet.update({
      where: { id: houseBetId },
      data: {
        txSignature,
        status: 'ACTIVE',
      },
    });

    logger.info({ houseBetId, txSignature }, 'House bet deposit confirmed');
    return true;
  } catch (error) {
    logger.error({ error, houseBetId }, 'Failed to confirm house bet deposit');
    return false;
  }
}

// Settle all house bets for completed games
export async function settleHouseBets(): Promise<void> {
  // Find all games that are FINAL with active house bets
  const games = await prisma.game.findMany({
    where: {
      status: 'FINAL',
      houseBets: {
        some: {
          status: 'ACTIVE',
        },
      },
    },
    include: {
      houseBets: {
        where: {
          status: 'ACTIVE',
        },
        include: {
          user: true,
        },
      },
    },
  });

  for (const game of games) {
    for (const bet of game.houseBets) {
      try {
        await settleHouseBet(bet, game);
      } catch (error) {
        logger.error({ error, houseBetId: bet.id }, 'Failed to settle house bet');
      }
    }
  }
}

// Settle a single house bet
async function settleHouseBet(
  bet: {
    id: string;
    chatId: bigint;
    betType: BetType;
    pick: string;
    odds: number;
    line: number | null;
    amount: bigint;
    potentialWin: bigint;
    user: {
      id: string;
      username: string | null;
      solanaAddress: string | null;
    };
  },
  game: {
    homeTeam: string;
    awayTeam: string;
    homeScore: number | null;
    awayScore: number | null;
    winner: string | null;
    homeSpread: number | null;
    totalLine: number | null;
  }
): Promise<void> {
  logger.info({ houseBetId: bet.id, betType: bet.betType, pick: bet.pick }, 'Settling house bet');

  const result = determineHouseBetResult(bet, game);

  if (result === null) {
    logger.warn({ houseBetId: bet.id }, 'Could not determine bet result');
    return;
  }

  let payoutTx: string | null = null;

  if (result === 'WIN' && bet.user.solanaAddress) {
    // Pay out winner from treasury
    const payout = bet.potentialWin;

    if (payout > BigInt(5000)) {
      try {
        // Note: In production, this would need proper treasury wallet signing
        // For now, we log it as needing manual payout or would use a stored treasury key
        logger.info(
          {
            houseBetId: bet.id,
            payout: payout.toString(),
            recipient: bet.user.solanaAddress,
          },
          'House bet payout needed'
        );

        // TODO: Implement actual treasury payout when multisig is ready
        // For now, mark as needing payout
        payoutTx = 'PENDING_TREASURY_PAYOUT';
      } catch (error) {
        logger.error({ error, houseBetId: bet.id }, 'Failed to send house bet payout');
      }
    }
  } else if (result === 'PUSH' && bet.user.solanaAddress) {
    // Refund on push
    const refund = bet.amount;

    if (refund > BigInt(5000)) {
      try {
        logger.info(
          {
            houseBetId: bet.id,
            refund: refund.toString(),
            recipient: bet.user.solanaAddress,
          },
          'House bet push refund needed'
        );

        payoutTx = 'PENDING_TREASURY_REFUND';
      } catch (error) {
        logger.error({ error, houseBetId: bet.id }, 'Failed to send house bet refund');
      }
    }
  }

  // Update bet status
  await prisma.houseBet.update({
    where: { id: bet.id },
    data: {
      status: 'SETTLED',
      result,
      payoutTx,
      settledAt: new Date(),
    },
  });

  // Send notification
  try {
    const betDescription = formatBetDescription(bet, game);
    const resultEmoji = result === 'WIN' ? '🎉' : result === 'PUSH' ? '🔄' : '❌';
    const resultText =
      result === 'WIN'
        ? `Won ${(Number(bet.potentialWin) / LAMPORTS_PER_SOL).toFixed(4)} SOL!`
        : result === 'PUSH'
        ? `Push - bet refunded (${(Number(bet.amount) / LAMPORTS_PER_SOL).toFixed(4)} SOL)`
        : `Lost ${(Number(bet.amount) / LAMPORTS_PER_SOL).toFixed(4)} SOL`;

    const username = bet.user.username ? `@${bet.user.username}` : 'Bettor';

    const message =
      `${resultEmoji} House Bet Settled\n\n` +
      `${username}'s bet:\n` +
      `${betDescription}\n\n` +
      `Result: ${resultText}`;

    await bot.api.sendMessage(bet.chatId.toString(), message);
  } catch (notifyError) {
    logger.warn({ error: notifyError, chatId: bet.chatId }, 'Failed to send house bet notification');
  }

  logger.info({ houseBetId: bet.id, result }, 'House bet settled');
}

// Determine the result of a house bet
function determineHouseBetResult(
  bet: {
    betType: BetType;
    pick: string;
    line: number | null;
  },
  game: {
    homeScore: number | null;
    awayScore: number | null;
    winner: string | null;
    homeSpread: number | null;
    totalLine: number | null;
  }
): HouseBetResult | null {
  const homeScore = game.homeScore;
  const awayScore = game.awayScore;

  if (homeScore === null || awayScore === null) {
    return null;
  }

  switch (bet.betType) {
    case 'MONEYLINE': {
      if (game.winner === bet.pick) {
        return 'WIN';
      }
      return 'LOSS';
    }

    case 'SPREAD': {
      if (bet.line === null) return null;

      // Calculate score with spread applied
      const adjustedHomeScore = homeScore + (bet.pick === 'home' ? bet.line : 0);
      const adjustedAwayScore = awayScore + (bet.pick === 'away' ? -bet.line : 0);

      if (bet.pick === 'home') {
        if (adjustedHomeScore > awayScore) return 'WIN';
        if (adjustedHomeScore === awayScore) return 'PUSH';
        return 'LOSS';
      } else {
        if (adjustedAwayScore > homeScore) return 'WIN';
        if (adjustedAwayScore === homeScore) return 'PUSH';
        return 'LOSS';
      }
    }

    case 'TOTAL_OVER': {
      if (bet.line === null) return null;
      const total = homeScore + awayScore;

      if (total > bet.line) return 'WIN';
      if (total === bet.line) return 'PUSH';
      return 'LOSS';
    }

    case 'TOTAL_UNDER': {
      if (bet.line === null) return null;
      const total = homeScore + awayScore;

      if (total < bet.line) return 'WIN';
      if (total === bet.line) return 'PUSH';
      return 'LOSS';
    }

    default:
      return null;
  }
}

// Format a bet description for display
function formatBetDescription(
  bet: {
    betType: BetType;
    pick: string;
    odds: number;
    line: number | null;
  },
  game: {
    homeTeam: string;
    awayTeam: string;
  }
): string {
  const team = bet.pick === 'home' ? game.homeTeam : game.awayTeam;
  const oddsStr = formatOdds(bet.odds);

  switch (bet.betType) {
    case 'MONEYLINE':
      return `${team} ML (${oddsStr})`;

    case 'SPREAD': {
      const spreadStr = bet.line !== null ? (bet.line > 0 ? `+${bet.line}` : `${bet.line}`) : '';
      return `${team} ${spreadStr} (${oddsStr})`;
    }

    case 'TOTAL_OVER':
      return `Over ${bet.line} (${oddsStr})`;

    case 'TOTAL_UNDER':
      return `Under ${bet.line} (${oddsStr})`;

    default:
      return `${bet.pick} (${oddsStr})`;
  }
}

// Get pending house bets for a user
export async function getUserPendingHouseBets(
  userId: string
): Promise<
  Array<{
    id: string;
    gameId: string;
    betType: BetType;
    pick: string;
    odds: number;
    amount: bigint;
    potentialWin: bigint;
    status: string;
  }>
> {
  return prisma.houseBet.findMany({
    where: {
      userId,
      status: { in: ['PENDING', 'ACTIVE'] },
    },
  });
}

// Cancel expired pending house bets (no deposit received)
export async function cancelExpiredHouseBets(): Promise<void> {
  const expiryTime = new Date(Date.now() - 30 * 60 * 1000); // 30 minutes

  const expired = await prisma.houseBet.findMany({
    where: {
      status: 'PENDING',
      createdAt: { lt: expiryTime },
    },
  });

  if (expired.length > 0) {
    await prisma.houseBet.updateMany({
      where: {
        id: { in: expired.map((b) => b.id) },
      },
      data: {
        status: 'CANCELLED',
      },
    });

    logger.info({ count: expired.length }, 'Cancelled expired pending house bets');
  }
}

// Get house betting exposure (how much treasury could owe)
export async function getHouseExposure(): Promise<{
  totalActiveAmount: bigint;
  totalPotentialPayout: bigint;
  activeBetCount: number;
}> {
  const activeBets = await prisma.houseBet.findMany({
    where: {
      status: 'ACTIVE',
    },
    select: {
      amount: true,
      potentialWin: true,
    },
  });

  return {
    totalActiveAmount: activeBets.reduce((sum, b) => sum + b.amount, BigInt(0)),
    totalPotentialPayout: activeBets.reduce((sum, b) => sum + b.potentialWin, BigInt(0)),
    activeBetCount: activeBets.length,
  };
}

// Check if game has odds for a specific bet type
export function hasOddsForBetType(
  game: {
    homeMoneyline: number | null;
    awayMoneyline: number | null;
    homeSpread: number | null;
    awaySpread: number | null;
    spreadOdds: number | null;
    totalLine: number | null;
    overOdds: number | null;
    underOdds: number | null;
  },
  betType: BetType
): boolean {
  switch (betType) {
    case 'MONEYLINE':
      return game.homeMoneyline !== null && game.awayMoneyline !== null;
    case 'SPREAD':
      return (
        game.homeSpread !== null &&
        game.awaySpread !== null &&
        game.spreadOdds !== null
      );
    case 'TOTAL_OVER':
    case 'TOTAL_UNDER':
      return (
        game.totalLine !== null &&
        game.overOdds !== null &&
        game.underOdds !== null
      );
    default:
      return false;
  }
}

// Poll pending house bet wallets for deposits
export async function pollHouseBetWallets(): Promise<void> {
  const pendingBets = await prisma.houseBet.findMany({
    where: {
      status: 'PENDING',
    },
    include: {
      user: true,
      game: true,
    },
  });

  if (pendingBets.length === 0) {
    return;
  }

  logger.debug({ count: pendingBets.length }, 'Polling house bet wallets');

  for (const bet of pendingBets) {
    try {
      const balance = await getWalletBalance(bet.depositAddress);

      // Check if deposit meets or exceeds expected amount
      if (balance >= bet.amount) {
        logger.info(
          {
            houseBetId: bet.id,
            expected: bet.amount.toString(),
            received: balance.toString(),
            depositAddress: bet.depositAddress,
          },
          'House bet deposit detected'
        );

        // Sweep funds to treasury
        const sweepTx = await sweepToTreasury(bet.depositAddress, bet.depositSecretKey, balance);

        if (sweepTx) {
          // Update bet status to ACTIVE
          await prisma.houseBet.update({
            where: { id: bet.id },
            data: {
              txSignature: sweepTx,
              status: 'ACTIVE',
            },
          });

          // Notify user
          try {
            const amountSol = Number(bet.amount) / LAMPORTS_PER_SOL;
            const potentialWinSol = Number(bet.potentialWin) / LAMPORTS_PER_SOL;

            let betDescription: string;
            if (bet.betType === 'MONEYLINE') {
              const team = bet.pick === 'home' ? bet.game.homeTeam : bet.game.awayTeam;
              betDescription = `${team} ML (${formatOdds(bet.odds)})`;
            } else if (bet.betType === 'TOTAL_OVER') {
              betDescription = `Over ${bet.line} (${formatOdds(bet.odds)})`;
            } else if (bet.betType === 'TOTAL_UNDER') {
              betDescription = `Under ${bet.line} (${formatOdds(bet.odds)})`;
            } else {
              const team = bet.pick === 'home' ? bet.game.homeTeam : bet.game.awayTeam;
              betDescription = `${team} ${bet.line} (${formatOdds(bet.odds)})`;
            }

            const username = bet.user.username ? `@${bet.user.username}` : 'Bettor';
            await bot.api.sendMessage(
              bet.chatId.toString(),
              `✅ House Bet Confirmed!\n\n` +
                `${username}'s bet on ${bet.game.awayTeam} @ ${bet.game.homeTeam}:\n` +
                `${betDescription}\n` +
                `Amount: ${amountSol.toFixed(4)} SOL\n` +
                `Potential win: ${potentialWinSol.toFixed(4)} SOL`
            );
          } catch (notifyError) {
            logger.warn({ error: notifyError, houseBetId: bet.id }, 'Failed to send deposit confirmation');
          }

          logger.info({ houseBetId: bet.id, sweepTx }, 'House bet activated and swept to treasury');
        }
      }
    } catch (error) {
      logger.error({ error, houseBetId: bet.id }, 'Failed to poll house bet wallet');
    }
  }
}

// Sweep funds from deposit wallet to treasury
async function sweepToTreasury(
  depositAddress: string,
  depositSecretKey: string,
  balance: bigint
): Promise<string | null> {
  // Leave enough for rent (0.001 SOL = 1,000,000 lamports should be enough for tx fee)
  const txFee = BigInt(5000); // 0.000005 SOL tx fee
  const sweepAmount = balance - txFee;

  if (sweepAmount <= BigInt(0)) {
    logger.warn({ depositAddress, balance: balance.toString() }, 'Balance too low to sweep');
    return null;
  }

  try {
    const txSignature = await sendSol(depositSecretKey, config.TREASURY_WALLET_ADDRESS, sweepAmount);

    logger.info(
      {
        from: depositAddress,
        to: config.TREASURY_WALLET_ADDRESS,
        amount: sweepAmount.toString(),
        txSignature,
      },
      'Swept house bet deposit to treasury'
    );

    return txSignature;
  } catch (error) {
    logger.error({ error, depositAddress }, 'Failed to sweep to treasury');
    return null;
  }
}
