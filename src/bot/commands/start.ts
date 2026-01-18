import { type BotContext } from '../bot.js';
import { prisma } from '../../db/prisma.js';
import { createChildLogger } from '../../utils/logger.js';

const logger = createChildLogger('cmd:start');

export async function startCommand(ctx: BotContext) {
  const telegramUser = ctx.from;

  if (!telegramUser) {
    await ctx.reply('Could not identify user.');
    return;
  }

  try {
    // Upsert user in database
    const user = await prisma.user.upsert({
      where: { telegramId: BigInt(telegramUser.id) },
      update: {
        username: telegramUser.username ?? null,
      },
      create: {
        telegramId: BigInt(telegramUser.id),
        username: telegramUser.username ?? null,
      },
    });

    logger.info({ userId: user.id, telegramId: telegramUser.id }, 'User registered/updated');

    const welcomeMessage = `Welcome to Bettr!

You're now registered and ready to bet on sports with your friends using SOL.

Commands:
/games - View today's games
/bet - Start or join a bet
/mybets - View your active bets
/wallet <address> - Set your payout wallet
/help - Get help

To get started, use /games to see today's matchups!`;

    await ctx.reply(welcomeMessage);
  } catch (error) {
    logger.error({ error, telegramId: telegramUser.id }, 'Failed to register user');
    await ctx.reply('Something went wrong. Please try again later.');
  }
}
