import { type BotContext } from '../bot.js';
import { prisma } from '../../db/prisma.js';
import { LAMPORTS_PER_SOL } from '../../utils/constants.js';
import { createChildLogger } from '../../utils/logger.js';

const logger = createChildLogger('cmd:mybets');

export async function mybetsCommand(ctx: BotContext) {
  const telegramUser = ctx.from;

  if (!telegramUser) {
    await ctx.reply('Could not identify user.');
    return;
  }

  try {
    // Find user
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(telegramUser.id) },
    });

    if (!user) {
      await ctx.reply('You need to /start first to register.');
      return;
    }

    // Get active wagers
    const wagers = await prisma.wager.findMany({
      where: {
        userId: user.id,
        round: {
          status: {
            in: ['OPEN', 'LOCKED'],
          },
        },
      },
      include: {
        round: {
          include: {
            game: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    if (wagers.length === 0) {
      await ctx.reply('You have no active bets. Use /bet to place one!');
      return;
    }

    let message = 'Your Active Bets:\n\n';

    for (const wager of wagers) {
      const game = wager.round.game;
      const teamName = wager.teamPick === 'home' ? game.homeTeam : game.awayTeam;
      const amountSol = Number(wager.amount) / LAMPORTS_PER_SOL;
      const potSol = Number(wager.round.totalPot) / LAMPORTS_PER_SOL;
      const status = wager.round.status === 'OPEN' ? '🟢 Open' : '🔒 Locked';

      const gameTime = game.startTime.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: 'America/New_York',
      });

      message += `${game.awayTeam} @ ${game.homeTeam}\n`;
      message += `  Your pick: ${teamName}\n`;
      message += `  Your wager: ${amountSol.toFixed(4)} SOL\n`;
      message += `  Total pot: ${potSol.toFixed(4)} SOL\n`;
      message += `  Status: ${status}\n`;
      message += `  Game time: ${gameTime} ET\n\n`;
    }

    await ctx.reply(message);
  } catch (error) {
    logger.error({ error, telegramId: telegramUser.id }, 'Failed to fetch user bets');
    await ctx.reply('Failed to load your bets. Please try again.');
  }
}
