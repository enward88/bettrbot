import { InlineKeyboard } from 'grammy';
import { type BotContext } from '../bot.js';
import { prisma } from '../../db/prisma.js';
import { formatOdds } from '../../services/odds.js';
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

    const gameTime = game.startTime.toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'America/New_York',
    }) + ' ET';

    // Build keyboard with both P2P and House betting options
    const keyboard = new InlineKeyboard();

    // P2P betting options
    keyboard
      .text(`${game.awayTeam}`, `bet:team:away`)
      .text(`${game.homeTeam}`, `bet:team:home`)
      .row();

    // House betting options (if odds available)
    const hasMoneyline = game.homeMoneyline !== null && game.awayMoneyline !== null;
    const hasTotals = game.totalLine !== null && game.overOdds !== null && game.underOdds !== null;

    if (hasMoneyline) {
      keyboard
        .text(`${game.awayTeam} ML (${formatOdds(game.awayMoneyline!)})`, `house:ml:away:${gameId}`)
        .text(`${game.homeTeam} ML (${formatOdds(game.homeMoneyline!)})`, `house:ml:home:${gameId}`)
        .row();
    }

    if (hasTotals) {
      keyboard
        .text(`Over ${game.totalLine} (${formatOdds(game.overOdds!)})`, `house:over:${gameId}`)
        .text(`Under ${game.totalLine} (${formatOdds(game.underOdds!)})`, `house:under:${gameId}`)
        .row();
    }

    // Build message
    let message = `${game.awayTeam} @ ${game.homeTeam}\n${gameTime}\n\n`;
    message += `P2P Bet (bet against others):\n`;
    message += `Pick a team above\n\n`;

    if (hasMoneyline || hasTotals) {
      message += `House Bet (bet at posted odds):\n`;
      if (hasMoneyline) {
        message += `Moneyline: ${game.awayTeam} ${formatOdds(game.awayMoneyline!)} | ${game.homeTeam} ${formatOdds(game.homeMoneyline!)}\n`;
      }
      if (hasTotals) {
        message += `Total: O/U ${game.totalLine} (${formatOdds(game.overOdds!)}/${formatOdds(game.underOdds!)})\n`;
      }
    }

    await ctx.editMessageText(message, { reply_markup: keyboard });
    await ctx.answerCallbackQuery();
  } catch (error) {
    logger.error({ error, gameId }, 'Failed to handle game selection');
    await ctx.answerCallbackQuery({ text: 'Something went wrong. Please try again.' });
  }
}
