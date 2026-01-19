import { InlineKeyboard } from 'grammy';
import { type BotContext } from '../bot.js';
import { prisma } from '../../db/prisma.js';
import { createChildLogger } from '../../utils/logger.js';

const logger = createChildLogger('cmd:bet');

export async function betCommand(ctx: BotContext) {
  try {
    // Get today's date range
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Fetch upcoming games
    const games = await prisma.game.findMany({
      where: {
        startTime: {
          gte: new Date(), // Only future games
          lt: tomorrow,
        },
        status: 'SCHEDULED',
      },
      orderBy: [{ startTime: 'asc' }],
      take: 10,
    });

    if (games.length === 0) {
      await ctx.reply('No upcoming games available for betting right now.');
      return;
    }

    const keyboard = new InlineKeyboard();

    for (const game of games) {
      const time = game.startTime.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: 'America/New_York',
      });
      const label = `${game.awayTeam} @ ${game.homeTeam} (${time} ET)`;
      keyboard.text(label, `bet:game:${game.id}`).row();
    }

    await ctx.reply('Select a game to bet on:', { reply_markup: keyboard });
  } catch (error) {
    logger.error({ error }, 'Failed to show bet options');
    await ctx.reply('Failed to load betting options. Please try again.');
  }
}
