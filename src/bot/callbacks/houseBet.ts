import { type BotContext } from '../bot.js';
import { prisma } from '../../db/prisma.js';
import { createHouseBet } from '../../services/houseBet.js';
import { formatOdds } from '../../services/odds.js';
import { createChildLogger } from '../../utils/logger.js';
import { LAMPORTS_PER_SOL, MIN_BET_SOL, MAX_HOUSE_BET_SOL } from '../../utils/constants.js';

const logger = createChildLogger('cb:houseBet');

export async function handleHouseBetSelection(ctx: BotContext) {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith('house:')) {
    return;
  }

  const fromId = ctx.from?.id;
  if (!fromId) {
    await ctx.answerCallbackQuery({ text: 'Could not identify user.' });
    return;
  }

  // Check user is registered
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(fromId) },
  });

  if (!user) {
    await ctx.answerCallbackQuery({ text: 'Please /start first to register.' });
    return;
  }

  try {
    // Parse callback: house:ml:home:gameId or house:over:gameId
    const parts = callbackData.split(':');

    let betType: 'MONEYLINE' | 'SPREAD' | 'TOTAL_OVER' | 'TOTAL_UNDER';
    let pick: string;
    let gameId: string;

    if (parts[1] === 'ml') {
      betType = 'MONEYLINE';
      pick = parts[2]!; // home or away
      gameId = parts[3]!;
    } else if (parts[1] === 'over') {
      betType = 'TOTAL_OVER';
      pick = 'over';
      gameId = parts[2]!;
    } else if (parts[1] === 'under') {
      betType = 'TOTAL_UNDER';
      pick = 'under';
      gameId = parts[2]!;
    } else {
      await ctx.answerCallbackQuery({ text: 'Invalid bet type.' });
      return;
    }

    // Get game
    const game = await prisma.game.findUnique({
      where: { id: gameId },
    });

    if (!game) {
      await ctx.answerCallbackQuery({ text: 'Game not found.' });
      return;
    }

    if (game.status !== 'SCHEDULED') {
      await ctx.answerCallbackQuery({ text: 'Game is no longer available.' });
      return;
    }

    // Store pending bet in session
    ctx.session.pendingHouseBet = { gameId, betType, pick };

    // Get odds for display
    let odds: number | null = null;
    let line: number | null = null;
    let betDescription: string;

    if (betType === 'MONEYLINE') {
      odds = pick === 'home' ? game.homeMoneyline : game.awayMoneyline;
      const team = pick === 'home' ? game.homeTeam : game.awayTeam;
      betDescription = `${team} ML`;
    } else if (betType === 'TOTAL_OVER') {
      odds = game.overOdds;
      line = game.totalLine;
      betDescription = `Over ${line}`;
    } else {
      odds = game.underOdds;
      line = game.totalLine;
      betDescription = `Under ${line}`;
    }

    if (odds === null) {
      await ctx.answerCallbackQuery({ text: 'Odds not available.' });
      return;
    }

    // Ask for bet amount
    await ctx.editMessageText(
      `House Bet: ${betDescription} (${formatOdds(odds)})\n` +
        `${game.awayTeam} @ ${game.homeTeam}\n\n` +
        `Reply with your bet amount in SOL:\n` +
        `(e.g., "0.5" or "1")`,
    );

    await ctx.answerCallbackQuery();
  } catch (error) {
    logger.error({ error, callbackData }, 'Failed to handle house bet selection');
    await ctx.answerCallbackQuery({ text: 'Something went wrong.' });
  }
}

// Handle bet amount reply for house bets
export async function handleHouseBetAmount(ctx: BotContext) {
  const pendingBet = ctx.session.pendingHouseBet;
  if (!pendingBet) {
    return; // No pending house bet
  }

  const text = ctx.message?.text;
  if (!text) {
    return;
  }

  // Parse amount
  const amount = parseFloat(text.replace(/[^0-9.]/g, ''));
  if (isNaN(amount) || amount < MIN_BET_SOL || amount > MAX_HOUSE_BET_SOL) {
    await ctx.reply(`House bets must be between ${MIN_BET_SOL} and ${MAX_HOUSE_BET_SOL} SOL.`);
    return;
  }

  const fromId = ctx.from?.id;
  if (!fromId) {
    return;
  }

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(fromId) },
  });

  if (!user) {
    await ctx.reply('Please /start first to register.');
    return;
  }

  try {
    const amountLamports = BigInt(Math.floor(amount * LAMPORTS_PER_SOL));

    const houseBet = await createHouseBet({
      gameId: pendingBet.gameId,
      userId: user.id,
      chatId: BigInt(ctx.chat!.id),
      betType: pendingBet.betType,
      pick: pendingBet.pick,
      amount: amountLamports,
    });

    if (!houseBet) {
      await ctx.reply('Failed to create house bet. Odds may no longer be available.');
      ctx.session.pendingHouseBet = undefined;
      return;
    }

    const game = await prisma.game.findUnique({
      where: { id: pendingBet.gameId },
    });

    const potentialWinSol = Number(houseBet.potentialWin) / LAMPORTS_PER_SOL;

    let betDescription: string;
    if (pendingBet.betType === 'MONEYLINE') {
      const team = pendingBet.pick === 'home' ? game?.homeTeam : game?.awayTeam;
      betDescription = `${team} ML`;
    } else if (pendingBet.betType === 'TOTAL_OVER') {
      betDescription = `Over ${houseBet.line}`;
    } else {
      betDescription = `Under ${houseBet.line}`;
    }

    await ctx.reply(
      `House Bet Created!\n\n` +
        `${game?.awayTeam} @ ${game?.homeTeam}\n` +
        `Your pick: ${betDescription} (${formatOdds(houseBet.odds)})\n` +
        `Amount: ${amount} SOL\n` +
        `Potential win: ${potentialWinSol.toFixed(4)} SOL\n\n` +
        `Send exactly ${amount} SOL to:\n` +
        `\`${houseBet.depositAddress}\`\n\n` +
        `Bet ID: ${houseBet.id.slice(0, 8)}\n` +
        `⏰ Deposit within 30 minutes`,
      { parse_mode: 'Markdown' }
    );

    // Clear pending bet
    ctx.session.pendingHouseBet = undefined;

    logger.info(
      {
        houseBetId: houseBet.id,
        user: ctx.from?.username,
        amount,
        betType: pendingBet.betType,
        pick: pendingBet.pick,
      },
      'House bet created via UI'
    );
  } catch (error) {
    logger.error({ error }, 'Failed to create house bet');
    await ctx.reply('Failed to create bet. Please try again.');
    ctx.session.pendingHouseBet = undefined;
  }
}
