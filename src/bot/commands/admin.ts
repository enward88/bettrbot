import { InlineKeyboard } from 'grammy';
import { type BotContext } from '../bot.js';
import { prisma } from '../../db/prisma.js';
import { config } from '../../utils/config.js';
import { LAMPORTS_PER_SOL } from '../../utils/constants.js';
import { formatOdds } from '../../services/odds.js';
import { createChildLogger } from '../../utils/logger.js';

const logger = createChildLogger('cmd:admin');

// Check if user is admin
function isAdmin(telegramId: bigint | number): boolean {
  if (!config.ADMIN_TELEGRAM_ID) return false;
  return config.ADMIN_TELEGRAM_ID === String(telegramId);
}

export async function adminCommand(ctx: BotContext) {
  const telegramUser = ctx.from;
  if (!telegramUser) {
    await ctx.reply('Could not identify user.');
    return;
  }

  if (!isAdmin(telegramUser.id)) {
    await ctx.reply('You do not have permission to access admin commands.');
    return;
  }

  await ctx.reply(
    '🔧 Admin Dashboard\n\n' +
      'Commands:\n' +
      '/admin bets - View all active bets\n' +
      '/admin pending - View pending settlements\n' +
      '/admin settle <betId> <WIN|LOSS|PUSH> - Manually settle\n' +
      '/admin refund <betId> - Cancel/refund a bet\n' +
      '/admin exposure - View house exposure\n' +
      '/admin stats - View betting statistics\n\n' +
      'Test Commands:\n' +
      '/admin testgame - Create a fake test game\n' +
      '/admin simstart <gameId> - Simulate game starting (LIVE)\n' +
      '/admin simend <gameId> <homeScore> <awayScore> - Simulate game ending'
  );
}

export async function adminBetsCommand(ctx: BotContext) {
  const telegramUser = ctx.from;
  if (!telegramUser || !isAdmin(telegramUser.id)) {
    await ctx.reply('Unauthorized.');
    return;
  }

  try {
    // Get active house bets
    const houseBets = await prisma.houseBet.findMany({
      where: {
        status: { in: ['PENDING', 'ACTIVE'] },
      },
      include: {
        user: true,
        game: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    // Get active P2P rounds
    const rounds = await prisma.round.findMany({
      where: {
        status: { in: ['OPEN', 'LOCKED'] },
      },
      include: {
        game: true,
        wagers: {
          include: { user: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    let message = '📊 Active Bets Dashboard\n\n';

    // House Bets Section
    message += `🏦 HOUSE BETS (${houseBets.length})\n`;
    message += '─'.repeat(30) + '\n';

    if (houseBets.length === 0) {
      message += 'No active house bets\n';
    } else {
      for (const bet of houseBets) {
        const amountSol = Number(bet.amount) / LAMPORTS_PER_SOL;
        const potentialWinSol = Number(bet.potentialWin) / LAMPORTS_PER_SOL;
        const username = bet.user.username ? `@${bet.user.username}` : bet.user.id.slice(0, 8);

        let betDesc: string;
        if (bet.betType === 'MONEYLINE') {
          const team = bet.pick === 'home' ? bet.game.homeTeam : bet.game.awayTeam;
          betDesc = `${team} ML`;
        } else if (bet.betType === 'SPREAD') {
          const team = bet.pick === 'home' ? bet.game.homeTeam : bet.game.awayTeam;
          betDesc = `${team} ${bet.line}`;
        } else if (bet.betType === 'TOTAL_OVER') {
          betDesc = `Over ${bet.line}`;
        } else {
          betDesc = `Under ${bet.line}`;
        }

        const statusEmoji = bet.status === 'PENDING' ? '⏳' : '✅';
        message += `${statusEmoji} ${bet.id.slice(0, 8)}\n`;
        message += `   ${bet.game.awayTeam} @ ${bet.game.homeTeam}\n`;
        message += `   ${username}: ${betDesc} (${formatOdds(bet.odds)})\n`;
        message += `   ${amountSol.toFixed(4)} SOL → ${potentialWinSol.toFixed(4)} SOL\n`;
        message += `   Status: ${bet.status} | Game: ${bet.game.status}\n\n`;
      }
    }

    // P2P Rounds Section
    message += `\n🤝 P2P ROUNDS (${rounds.length})\n`;
    message += '─'.repeat(30) + '\n';

    if (rounds.length === 0) {
      message += 'No active P2P rounds\n';
    } else {
      for (const round of rounds) {
        const totalPot = Number(round.totalPot) / LAMPORTS_PER_SOL;
        const homeWagers = round.wagers.filter((w) => w.teamPick === 'home');
        const awayWagers = round.wagers.filter((w) => w.teamPick === 'away');

        message += `🎯 ${round.id.slice(0, 8)}\n`;
        message += `   ${round.game.awayTeam} @ ${round.game.homeTeam}\n`;
        message += `   Pot: ${totalPot.toFixed(4)} SOL | Status: ${round.status}\n`;
        message += `   Home: ${homeWagers.length} bets | Away: ${awayWagers.length} bets\n\n`;
      }
    }

    // Build keyboard for actions
    const keyboard = new InlineKeyboard();
    keyboard.text('🔄 Refresh', 'admin:refresh');

    await ctx.reply(message, { reply_markup: keyboard });
  } catch (error) {
    logger.error({ error }, 'Failed to fetch admin bets');
    await ctx.reply('Failed to load bets. Please try again.');
  }
}

export async function adminPendingCommand(ctx: BotContext) {
  const telegramUser = ctx.from;
  if (!telegramUser || !isAdmin(telegramUser.id)) {
    await ctx.reply('Unauthorized.');
    return;
  }

  try {
    // Get games that are FINAL but have unsettled bets
    const unsettledGames = await prisma.game.findMany({
      where: {
        status: 'FINAL',
        OR: [
          { houseBets: { some: { status: 'ACTIVE' } } },
          { rounds: { some: { status: 'LOCKED' } } },
        ],
      },
      include: {
        houseBets: {
          where: { status: 'ACTIVE' },
          include: { user: true },
        },
        rounds: {
          where: { status: 'LOCKED' },
          include: { wagers: { include: { user: true } } },
        },
      },
    });

    let message = '⏳ Pending Settlements\n\n';

    if (unsettledGames.length === 0) {
      message += 'No pending settlements! All settled games have been processed.';
    } else {
      for (const game of unsettledGames) {
        message += `🏟️ ${game.awayTeam} @ ${game.homeTeam}\n`;
        message += `   Score: ${game.awayScore} - ${game.homeScore}\n`;
        message += `   Winner: ${game.winner}\n`;

        if (game.houseBets.length > 0) {
          message += `   House Bets: ${game.houseBets.length} unsettled\n`;
          for (const bet of game.houseBets) {
            message += `     • ${bet.id.slice(0, 8)} - ${bet.user.username || bet.user.id.slice(0, 8)}\n`;
          }
        }

        if (game.rounds.length > 0) {
          message += `   P2P Rounds: ${game.rounds.length} unsettled\n`;
        }

        message += '\n';
      }

      message += '\nUse /admin settle <betId> <WIN|LOSS|PUSH> to manually settle.';
    }

    await ctx.reply(message);
  } catch (error) {
    logger.error({ error }, 'Failed to fetch pending settlements');
    await ctx.reply('Failed to load pending settlements.');
  }
}

export async function adminSettleCommand(ctx: BotContext) {
  const telegramUser = ctx.from;
  if (!telegramUser || !isAdmin(telegramUser.id)) {
    await ctx.reply('Unauthorized.');
    return;
  }

  const text = ctx.message?.text || '';
  const parts = text.split(/\s+/);
  // /admin settle <betId> <result>
  if (parts.length < 4) {
    await ctx.reply('Usage: /admin settle <betId> <WIN|LOSS|PUSH>');
    return;
  }

  const betIdPartial = parts[2];
  const result = parts[3]?.toUpperCase() as 'WIN' | 'LOSS' | 'PUSH';

  if (!['WIN', 'LOSS', 'PUSH'].includes(result)) {
    await ctx.reply('Result must be WIN, LOSS, or PUSH');
    return;
  }

  try {
    // Find bet by partial ID
    const bet = await prisma.houseBet.findFirst({
      where: {
        id: { startsWith: betIdPartial },
        status: 'ACTIVE',
      },
      include: { user: true, game: true },
    });

    if (!bet) {
      await ctx.reply(`No active bet found starting with "${betIdPartial}"`);
      return;
    }

    // Update bet status
    await prisma.houseBet.update({
      where: { id: bet.id },
      data: {
        status: 'SETTLED',
        result,
        settledAt: new Date(),
        payoutTx: `MANUAL_ADMIN_${Date.now()}`,
      },
    });

    const amountSol = Number(bet.amount) / LAMPORTS_PER_SOL;
    const potentialWinSol = Number(bet.potentialWin) / LAMPORTS_PER_SOL;

    await ctx.reply(
      `✅ Manually Settled Bet\n\n` +
        `Bet ID: ${bet.id.slice(0, 8)}\n` +
        `User: ${bet.user.username || bet.user.id.slice(0, 8)}\n` +
        `Game: ${bet.game.awayTeam} @ ${bet.game.homeTeam}\n` +
        `Amount: ${amountSol.toFixed(4)} SOL\n` +
        `Potential Win: ${potentialWinSol.toFixed(4)} SOL\n` +
        `Result: ${result}\n\n` +
        `⚠️ Remember to process payout manually if needed!`
    );

    logger.info({ betId: bet.id, result, admin: telegramUser.id }, 'Bet manually settled');
  } catch (error) {
    logger.error({ error }, 'Failed to manually settle bet');
    await ctx.reply('Failed to settle bet.');
  }
}

export async function adminExposureCommand(ctx: BotContext) {
  const telegramUser = ctx.from;
  if (!telegramUser || !isAdmin(telegramUser.id)) {
    await ctx.reply('Unauthorized.');
    return;
  }

  try {
    const activeBets = await prisma.houseBet.findMany({
      where: { status: 'ACTIVE' },
      select: { amount: true, potentialWin: true },
    });

    const totalStaked = activeBets.reduce((sum, b) => sum + b.amount, BigInt(0));
    const totalExposure = activeBets.reduce((sum, b) => sum + b.potentialWin, BigInt(0));
    const maxLoss = totalExposure - totalStaked;

    const stakedSol = Number(totalStaked) / LAMPORTS_PER_SOL;
    const exposureSol = Number(totalExposure) / LAMPORTS_PER_SOL;
    const maxLossSol = Number(maxLoss) / LAMPORTS_PER_SOL;

    await ctx.reply(
      `💰 House Exposure Report\n\n` +
        `Active Bets: ${activeBets.length}\n` +
        `Total Staked: ${stakedSol.toFixed(4)} SOL\n` +
        `Total Exposure: ${exposureSol.toFixed(4)} SOL\n` +
        `Max Potential Loss: ${maxLossSol.toFixed(4)} SOL\n\n` +
        `(If all active bets win)`
    );
  } catch (error) {
    logger.error({ error }, 'Failed to calculate exposure');
    await ctx.reply('Failed to calculate exposure.');
  }
}

export async function adminStatsCommand(ctx: BotContext) {
  const telegramUser = ctx.from;
  if (!telegramUser || !isAdmin(telegramUser.id)) {
    await ctx.reply('Unauthorized.');
    return;
  }

  try {
    const [
      totalUsers,
      totalHouseBets,
      settledHouseBets,
      totalRounds,
      settledRounds,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.houseBet.count(),
      prisma.houseBet.findMany({ where: { status: 'SETTLED' }, select: { result: true, amount: true, potentialWin: true } }),
      prisma.round.count(),
      prisma.round.count({ where: { status: 'SETTLED' } }),
    ]);

    const wins = settledHouseBets.filter((b) => b.result === 'WIN');
    const losses = settledHouseBets.filter((b) => b.result === 'LOSS');
    const pushes = settledHouseBets.filter((b) => b.result === 'PUSH');

    // Calculate house profit/loss
    const userWinnings = wins.reduce((sum, b) => sum + b.potentialWin, BigInt(0));
    const houseTakes = losses.reduce((sum, b) => sum + b.amount, BigInt(0));
    const houseProfit = houseTakes - (userWinnings - wins.reduce((sum, b) => sum + b.amount, BigInt(0)));

    const profitSol = Number(houseProfit) / LAMPORTS_PER_SOL;

    await ctx.reply(
      `📈 Betting Statistics\n\n` +
        `Users: ${totalUsers}\n\n` +
        `House Bets:\n` +
        `  Total: ${totalHouseBets}\n` +
        `  Settled: ${settledHouseBets.length}\n` +
        `  Wins: ${wins.length} | Losses: ${losses.length} | Pushes: ${pushes.length}\n` +
        `  House P/L: ${profitSol >= 0 ? '+' : ''}${profitSol.toFixed(4)} SOL\n\n` +
        `P2P Rounds:\n` +
        `  Total: ${totalRounds}\n` +
        `  Settled: ${settledRounds}`
    );
  } catch (error) {
    logger.error({ error }, 'Failed to fetch stats');
    await ctx.reply('Failed to load statistics.');
  }
}

export async function adminRefundCommand(ctx: BotContext) {
  const telegramUser = ctx.from;
  if (!telegramUser || !isAdmin(telegramUser.id)) {
    await ctx.reply('Unauthorized.');
    return;
  }

  const text = ctx.message?.text || '';
  const parts = text.split(/\s+/);
  // /admin refund <betId>
  if (parts.length < 3) {
    await ctx.reply('Usage: /admin refund <betId>');
    return;
  }

  const betIdPartial = parts[2];

  try {
    // Find bet by partial ID
    const bet = await prisma.houseBet.findFirst({
      where: {
        id: { startsWith: betIdPartial },
        status: { in: ['PENDING', 'ACTIVE'] },
      },
      include: { user: true, game: true },
    });

    if (!bet) {
      await ctx.reply(`No pending/active bet found starting with "${betIdPartial}"`);
      return;
    }

    // Mark as cancelled (refunded)
    await prisma.houseBet.update({
      where: { id: bet.id },
      data: {
        status: 'CANCELLED',
        settledAt: new Date(),
        payoutTx: `REFUND_ADMIN_${Date.now()}`,
      },
    });

    const amountSol = Number(bet.amount) / LAMPORTS_PER_SOL;

    await ctx.reply(
      `🔄 Bet Refunded/Cancelled\n\n` +
        `Bet ID: ${bet.id.slice(0, 8)}\n` +
        `User: ${bet.user.username || bet.user.id.slice(0, 8)}\n` +
        `Game: ${bet.game.awayTeam} @ ${bet.game.homeTeam}\n` +
        `Amount: ${amountSol.toFixed(4)} SOL\n\n` +
        `⚠️ If funds were deposited, refund manually from:\n` +
        `${bet.depositAddress || 'N/A'}`
    );

    logger.info({ betId: bet.id, admin: telegramUser.id }, 'Bet refunded by admin');
  } catch (error) {
    logger.error({ error }, 'Failed to refund bet');
    await ctx.reply('Failed to refund bet.');
  }
}

// Create a fake test game for testing settlement
export async function adminTestGameCommand(ctx: BotContext) {
  const telegramUser = ctx.from;
  if (!telegramUser || !isAdmin(telegramUser.id)) {
    await ctx.reply('Unauthorized.');
    return;
  }

  try {
    // Create a test game starting in 1 hour
    const startTime = new Date(Date.now() + 60 * 60 * 1000);

    const game = await prisma.game.create({
      data: {
        externalId: `TEST_${Date.now()}`,
        sport: 'NBA',
        homeTeam: 'Test Home',
        awayTeam: 'Test Away',
        startTime,
        status: 'SCHEDULED',
        homeMoneyline: -110,
        awayMoneyline: -110,
        homeSpread: -3.5,
        awaySpread: 3.5,
        spreadOdds: -110,
        totalLine: 220.5,
        overOdds: -110,
        underOdds: -110,
        oddsUpdatedAt: new Date(),
      },
    });

    await ctx.reply(
      `🧪 Test Game Created\n\n` +
        `Game ID: ${game.id.slice(0, 8)}\n` +
        `${game.awayTeam} @ ${game.homeTeam}\n` +
        `Starts: ${startTime.toLocaleString()}\n\n` +
        `Odds:\n` +
        `  ML: Away ${game.awayMoneyline} / Home ${game.homeMoneyline}\n` +
        `  Spread: Away +3.5 / Home -3.5\n` +
        `  Total: O/U 220.5\n\n` +
        `Now place bets using: "bet X sol test home ML"\n\n` +
        `Then simulate:\n` +
        `/admin simstart ${game.id.slice(0, 8)}\n` +
        `/admin simend ${game.id.slice(0, 8)} 110 108`
    );

    logger.info({ gameId: game.id }, 'Test game created by admin');
  } catch (error) {
    logger.error({ error }, 'Failed to create test game');
    await ctx.reply('Failed to create test game.');
  }
}

// Simulate game starting (set to LIVE)
export async function adminSimStartCommand(ctx: BotContext) {
  const telegramUser = ctx.from;
  if (!telegramUser || !isAdmin(telegramUser.id)) {
    await ctx.reply('Unauthorized.');
    return;
  }

  const text = ctx.message?.text || '';
  const parts = text.split(/\s+/);
  if (parts.length < 3) {
    await ctx.reply('Usage: /admin simstart <gameId>');
    return;
  }

  const gameIdPartial = parts[2];

  try {
    const game = await prisma.game.findFirst({
      where: {
        id: { startsWith: gameIdPartial },
      },
      include: {
        houseBets: { where: { status: { in: ['PENDING', 'ACTIVE'] } } },
        rounds: { where: { status: { in: ['OPEN', 'LOCKED'] } } },
      },
    });

    if (!game) {
      await ctx.reply(`No game found starting with "${gameIdPartial}"`);
      return;
    }

    // Update game to LIVE
    await prisma.game.update({
      where: { id: game.id },
      data: { status: 'LIVE' },
    });

    // Lock any open rounds (simulating game start)
    const lockedRounds = await prisma.round.updateMany({
      where: {
        gameId: game.id,
        status: 'OPEN',
      },
      data: { status: 'LOCKED' },
    });

    await ctx.reply(
      `🏀 Game Started (Simulated)\n\n` +
        `${game.awayTeam} @ ${game.homeTeam}\n` +
        `Status: LIVE\n\n` +
        `House bets: ${game.houseBets.length} active\n` +
        `P2P rounds locked: ${lockedRounds.count}\n\n` +
        `Next: /admin simend ${game.id.slice(0, 8)} <homeScore> <awayScore>`
    );

    logger.info({ gameId: game.id }, 'Game simulated to LIVE by admin');
  } catch (error) {
    logger.error({ error }, 'Failed to simulate game start');
    await ctx.reply('Failed to simulate game start.');
  }
}

// Simulate game ending with final score
export async function adminSimEndCommand(ctx: BotContext) {
  const telegramUser = ctx.from;
  if (!telegramUser || !isAdmin(telegramUser.id)) {
    await ctx.reply('Unauthorized.');
    return;
  }

  const text = ctx.message?.text || '';
  const parts = text.split(/\s+/);
  if (parts.length < 5) {
    await ctx.reply('Usage: /admin simend <gameId> <homeScore> <awayScore>');
    return;
  }

  const gameIdPartial = parts[2];
  const homeScore = parseInt(parts[3] ?? '0', 10);
  const awayScore = parseInt(parts[4] ?? '0', 10);

  if (isNaN(homeScore) || isNaN(awayScore)) {
    await ctx.reply('Scores must be numbers');
    return;
  }

  try {
    const game = await prisma.game.findFirst({
      where: {
        id: { startsWith: gameIdPartial },
      },
      include: {
        houseBets: { where: { status: 'ACTIVE' } },
        rounds: { where: { status: 'LOCKED' } },
      },
    });

    if (!game) {
      await ctx.reply(`No game found starting with "${gameIdPartial}"`);
      return;
    }

    // Determine winner
    const winner = homeScore > awayScore ? 'home' : homeScore < awayScore ? 'away' : null;

    // Update game to FINAL
    await prisma.game.update({
      where: { id: game.id },
      data: {
        status: 'FINAL',
        homeScore,
        awayScore,
        winner,
      },
    });

    const winnerTeam = winner === 'home' ? game.homeTeam : winner === 'away' ? game.awayTeam : 'TIE';

    await ctx.reply(
      `🏁 Game Ended (Simulated)\n\n` +
        `${game.awayTeam} ${awayScore} @ ${game.homeTeam} ${homeScore}\n` +
        `Winner: ${winnerTeam}\n\n` +
        `House bets to settle: ${game.houseBets.length}\n` +
        `P2P rounds to settle: ${game.rounds.length}\n\n` +
        `Settlement will run automatically within 5 minutes.\n` +
        `Or run settlement manually in the scheduler.`
    );

    logger.info(
      { gameId: game.id, homeScore, awayScore, winner },
      'Game simulated to FINAL by admin'
    );
  } catch (error) {
    logger.error({ error }, 'Failed to simulate game end');
    await ctx.reply('Failed to simulate game end.');
  }
}

// Handle admin callback queries
export async function handleAdminCallback(ctx: BotContext) {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  const telegramUser = ctx.from;
  if (!telegramUser || !isAdmin(telegramUser.id)) {
    await ctx.answerCallbackQuery('Unauthorized');
    return;
  }

  if (data === 'admin:refresh') {
    await ctx.answerCallbackQuery('Refreshing...');
    // Re-run the bets command by simulating it
    await adminBetsCommand(ctx);
  }
}
