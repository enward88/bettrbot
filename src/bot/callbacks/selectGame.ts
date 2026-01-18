import { InlineKeyboard } from 'grammy';
import { type BotContext } from '../bot.js';
import { prisma } from '../../db/prisma.js';
import { createChildLogger } from '../../utils/logger.js';

const logger = createChildLogger('cb:selectGame');

export async function handleGameSelection(ctx: BotContext) {
  const callbackData = ctx.callbackQuery?.data;

  if (!callbackData) {
    return;
  }

  // Handle both 'bet:game:' and 'game:' prefixes
  let gameId: string;
  if (callbackData.startsWith('bet:game:')) {
    gameId = callbackData.replace('bet:game:', '');
  } else if (callbackData.startsWith('game:')) {
    gameId = callbackData.replace('game:', '');
  } else {
    return;
  }

  try {
    const game = await prisma.game.findUnique({
      where: { id: gameId },
    });

    if (!game) {
      await ctx.answerCallbackQuery({ text: 'Game not found.' });
      return;
    }

    if (game.status !== 'SCHEDULED') {
      await ctx.answerCallbackQuery({ text: 'This game is no longer available for betting.' });
      return;
    }

    if (game.startTime <= new Date()) {
      await ctx.answerCallbackQuery({ text: 'This game has already started.' });
      return;
    }

    // Store selected game in session
    ctx.session.selectedGameId = gameId;

    // Show team selection
    const keyboard = new InlineKeyboard()
      .text(`${game.awayTeam} (Away)`, `bet:team:away`)
      .text(`${game.homeTeam} (Home)`, `bet:team:home`);

    const gameTime = game.startTime.toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

    await ctx.editMessageText(
      `${game.awayTeam} @ ${game.homeTeam}\n` +
        `${gameTime}\n\n` +
        `Select your team:`,
      { reply_markup: keyboard }
    );

    await ctx.answerCallbackQuery();
  } catch (error) {
    logger.error({ error, gameId }, 'Failed to handle game selection');
    await ctx.answerCallbackQuery({ text: 'Something went wrong. Please try again.' });
  }
}
