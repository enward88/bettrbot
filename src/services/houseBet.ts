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

  // First pass: determine results and calculate total needed for payouts
  const betsToSettle: Array<{
    bet: typeof games[0]['houseBets'][0];
    game: typeof games[0];
    result: HouseBetResult;
    payoutNeeded: bigint; // Total payout to user (stake + profit for wins, stake for push)
  }> = [];

  for (const game of games) {
    for (const bet of game.houseBets) {
      const result = determineHouseBetResult(bet, game);
      if (result === null) continue;

      let payoutNeeded = BigInt(0);
      if (result === 'WIN') {
        payoutNeeded = bet.potentialWin; // stake + profit
      } else if (result === 'PUSH') {
        payoutNeeded = bet.amount; // just stake
      }
      // LOSS: no payout needed

      betsToSettle.push({ bet, game, result, payoutNeeded });
    }
  }

  if (betsToSettle.length === 0) return;

  // Calculate total funds available across all these bets' deposit wallets
  let totalAvailable = BigInt(0);
  const walletBalances: Map<string, bigint> = new Map();

  for (const { bet } of betsToSettle) {
    if (bet.depositAddress) {
      try {
        const balance = await getWalletBalance(bet.depositAddress);
        walletBalances.set(bet.id, balance);
        totalAvailable += balance;
      } catch (error) {
        logger.error({ error, houseBetId: bet.id }, 'Failed to get wallet balance');
        walletBalances.set(bet.id, BigInt(0));
      }
    }
  }

  // Calculate total payouts needed
  const totalPayoutsNeeded = betsToSettle.reduce((sum, b) => sum + b.payoutNeeded, BigInt(0));
  const txFeePerPayout = BigInt(5000);
  const payoutCount = betsToSettle.filter(b => b.payoutNeeded > BigInt(0)).length;
  const totalTxFees = txFeePerPayout * BigInt(payoutCount);

  logger.info(
    {
      totalAvailable: totalAvailable.toString(),
      totalPayoutsNeeded: totalPayoutsNeeded.toString(),
      betsCount: betsToSettle.length,
    },
    'Settling house bets batch'
  );

  // Check if we have enough funds
  const canPayAll = totalAvailable >= totalPayoutsNeeded + totalTxFees;

  if (!canPayAll) {
    logger.warn(
      {
        shortfall: (totalPayoutsNeeded + totalTxFees - totalAvailable).toString(),
      },
      'Insufficient funds in deposit wallets - will need treasury top-up for some payouts'
    );
  }

  // Settle each bet
  for (const { bet, game, result, payoutNeeded } of betsToSettle) {
    try {
      await settleHouseBetWithPool(bet, game, result, payoutNeeded, walletBalances, betsToSettle);
    } catch (error) {
      logger.error({ error, houseBetId: bet.id }, 'Failed to settle house bet');
    }
  }
}

// Settle a single house bet using pooled funds from all settling bets
async function settleHouseBetWithPool(
  bet: {
    id: string;
    chatId: bigint;
    betType: BetType;
    pick: string;
    odds: number;
    line: number | null;
    amount: bigint;
    potentialWin: bigint;
    depositAddress: string | null;
    depositSecretKey: string | null;
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
  },
  result: HouseBetResult,
  payoutNeeded: bigint,
  walletBalances: Map<string, bigint>,
  allBets: Array<{ bet: typeof bet; result: HouseBetResult }>
): Promise<void> {
  logger.info({ houseBetId: bet.id, betType: bet.betType, pick: bet.pick, result }, 'Settling house bet');

  let payoutTx: string | null = null;
  let amountPaid = BigInt(0);

  if (payoutNeeded > BigInt(0) && bet.user.solanaAddress) {
    const txFee = BigInt(5000);
    let remainingToPay = payoutNeeded;

    // First, try to pay from this bet's own wallet
    if (bet.depositAddress && bet.depositSecretKey) {
      const ownBalance = walletBalances.get(bet.id) ?? BigInt(0);
      if (ownBalance > txFee) {
        const payFromOwn = ownBalance - txFee > remainingToPay ? remainingToPay : ownBalance - txFee;
        try {
          payoutTx = await sendSol(bet.depositSecretKey, bet.user.solanaAddress, payFromOwn);
          amountPaid += payFromOwn;
          remainingToPay -= payFromOwn;
          walletBalances.set(bet.id, ownBalance - payFromOwn - txFee);
          logger.info({ houseBetId: bet.id, amount: payFromOwn.toString() }, 'Paid from own wallet');
        } catch (error) {
          logger.error({ error, houseBetId: bet.id }, 'Failed to pay from own wallet');
        }
      }
    }

    // If still need more, pull from losing bets' wallets
    if (remainingToPay > BigInt(0)) {
      for (const other of allBets) {
        if (other.result !== 'LOSS') continue; // Only use loser wallets
        if (!other.bet.depositAddress || !other.bet.depositSecretKey) continue;
        if (other.bet.id === bet.id) continue;

        const otherBalance = walletBalances.get(other.bet.id) ?? BigInt(0);
        if (otherBalance <= txFee) continue;

        const available = otherBalance - txFee;
        const toTransfer = available > remainingToPay ? remainingToPay : available;

        try {
          const tx = await sendSol(other.bet.depositSecretKey, bet.user.solanaAddress, toTransfer);
          amountPaid += toTransfer;
          remainingToPay -= toTransfer;
          walletBalances.set(other.bet.id, otherBalance - toTransfer - txFee);
          logger.info(
            {
              from: other.bet.id,
              to: bet.id,
              amount: toTransfer.toString(),
              tx,
            },
            'Transferred from loser wallet to winner'
          );

          if (remainingToPay <= BigInt(0)) break;
        } catch (error) {
          logger.error({ error, fromBet: other.bet.id }, 'Failed to transfer from loser wallet');
        }
      }
    }

    // If still short, flag for manual treasury payout
    if (remainingToPay > BigInt(0)) {
      logger.warn(
        {
          houseBetId: bet.id,
          shortfall: remainingToPay.toString(),
          recipient: bet.user.solanaAddress,
        },
        'MANUAL TREASURY PAYOUT NEEDED - insufficient funds in pool'
      );
      payoutTx = payoutTx ? `${payoutTx}|TREASURY_OWES_${remainingToPay}` : `TREASURY_OWES_${remainingToPay}`;
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
    let resultText: string;

    if (result === 'WIN') {
      const paidSol = Number(amountPaid) / LAMPORTS_PER_SOL;
      const owedSol = Number(payoutNeeded - amountPaid) / LAMPORTS_PER_SOL;
      if (amountPaid >= payoutNeeded) {
        resultText = `Won ${(Number(bet.potentialWin) / LAMPORTS_PER_SOL).toFixed(4)} SOL!`;
      } else {
        resultText = `Won! Paid ${paidSol.toFixed(4)} SOL, ${owedSol.toFixed(4)} SOL pending`;
      }
    } else if (result === 'PUSH') {
      resultText = `Push - bet refunded (${(Number(bet.amount) / LAMPORTS_PER_SOL).toFixed(4)} SOL)`;
    } else {
      resultText = `Lost ${(Number(bet.amount) / LAMPORTS_PER_SOL).toFixed(4)} SOL`;
    }

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

  logger.info({ houseBetId: bet.id, result, amountPaid: amountPaid.toString() }, 'House bet settled');
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
    // Skip bets without deposit wallet (legacy bets)
    if (!bet.depositAddress || !bet.depositSecretKey) {
      continue;
    }

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

        // Just mark as ACTIVE - funds stay in deposit wallet until settlement
        await prisma.houseBet.update({
          where: { id: bet.id },
          data: {
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

        logger.info({ houseBetId: bet.id }, 'House bet activated');
      }
    } catch (error) {
      logger.error({ error, houseBetId: bet.id }, 'Failed to poll house bet wallet');
    }
  }
}

// Sweep settled bet wallets to treasury (run daily)
export async function sweepSettledHouseBets(): Promise<void> {
  // Find all settled bets that haven't been swept yet (no payoutTx or payoutTx is a sweep tx)
  const settledBets = await prisma.houseBet.findMany({
    where: {
      status: 'SETTLED',
      depositAddress: { not: null },
      depositSecretKey: { not: null },
    },
  });

  if (settledBets.length === 0) {
    return;
  }

  logger.info({ count: settledBets.length }, 'Sweeping settled house bet wallets');

  for (const bet of settledBets) {
    if (!bet.depositAddress || !bet.depositSecretKey) continue;

    try {
      const balance = await getWalletBalance(bet.depositAddress);

      // Skip if wallet is empty or near-empty
      if (balance <= BigInt(10000)) {
        continue;
      }

      const txFee = BigInt(5000);
      const sweepAmount = balance - txFee;

      if (sweepAmount <= BigInt(0)) continue;

      const txSignature = await sendSol(bet.depositSecretKey, config.TREASURY_WALLET_ADDRESS, sweepAmount);

      logger.info(
        {
          houseBetId: bet.id,
          from: bet.depositAddress,
          amount: sweepAmount.toString(),
          txSignature,
        },
        'Swept settled house bet to treasury'
      );
    } catch (error) {
      logger.error({ error, houseBetId: bet.id }, 'Failed to sweep settled house bet');
    }
  }
}
