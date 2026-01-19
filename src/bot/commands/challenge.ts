import { InlineKeyboard } from 'grammy';
import { type BotContext } from '../bot.js';
import { prisma } from '../../db/prisma.js';
import { LAMPORTS_PER_SOL, MIN_BET_SOL } from '../../utils/constants.js';
import { createChildLogger } from '../../utils/logger.js';

const logger = createChildLogger('cmd:challenge');

// /challenge @username 1 SOL Lakers vs Celtics
// /challenge @username 0.5
export async function challengeCommand(ctx: BotContext) {
  const chatId = ctx.chat?.id;
  const telegramUser = ctx.from;

  if (!chatId || !telegramUser) {
    await ctx.reply('This command can only be used in a group chat.');
    return;
  }

  // Check if it's a group chat
  if (ctx.chat?.type === 'private') {
    await ctx.reply('Challenges can only be made in group chats.');
    return;
  }

  try {
    // Parse the command: /challenge @username amount
    const text = ctx.message?.text ?? '';
    const parts = text.split(/\s+/);

    // Remove /challenge
    parts.shift();

    if (parts.length < 2) {
      await ctx.reply(
        'Usage: /challenge @username <amount>\n\n' +
        'Example: /challenge @bob 1\n' +
        '(challenges @bob for 1 SOL)\n\n' +
        'After challenging, you\'ll select which game and team.'
      );
      return;
    }

    // Extract opponent username
    let opponentUsername = parts[0];
    if (!opponentUsername) {
      await ctx.reply('Please mention a user to challenge. Example: /challenge @bob 1');
      return;
    }

    // Remove @ if present
    opponentUsername = opponentUsername.replace('@', '');

    // Extract amount
    const amountStr = parts[1];
    const amount = parseFloat(amountStr ?? '0');

    if (isNaN(amount) || amount < MIN_BET_SOL) {
      await ctx.reply(`Invalid amount. Minimum bet is ${MIN_BET_SOL} SOL.`);
      return;
    }

    const amountLamports = BigInt(Math.floor(amount * LAMPORTS_PER_SOL));

    // Get challenger user
    const challenger = await prisma.user.findUnique({
      where: { telegramId: BigInt(telegramUser.id) },
    });

    if (!challenger) {
      await ctx.reply('Please /start first to register.');
      return;
    }

    if (!challenger.solanaAddress) {
      await ctx.reply('You need to set your payout wallet first. Use /wallet <address>');
      return;
    }

    // Find opponent by username
    const opponent = await prisma.user.findFirst({
      where: { username: opponentUsername },
    });

    if (!opponent) {
      await ctx.reply(
        `User @${opponentUsername} hasn't registered yet.\n` +
        'They need to /start the bot first.'
      );
      return;
    }

    if (opponent.id === challenger.id) {
      await ctx.reply("You can't challenge yourself!");
      return;
    }

    if (!opponent.solanaAddress) {
      await ctx.reply(
        `@${opponentUsername} hasn't set their payout wallet yet.\n` +
        'They need to use /wallet <address> first.'
      );
      return;
    }

    // Store challenge info in session for game selection
    ctx.session.challengeData = {
      opponentId: opponent.id,
      opponentUsername: opponentUsername,
      amount: amountLamports.toString(),
    };

    // Show game selection
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const games = await prisma.game.findMany({
      where: {
        startTime: { gte: now, lt: tomorrow },
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
      keyboard.text(label, `challenge:game:${game.id}`).row();
    }

    await ctx.reply(
      `Challenging @${opponentUsername} for ${amount} SOL!\n\n` +
      'Select a game:',
      { reply_markup: keyboard }
    );
  } catch (error) {
    logger.error({ error }, 'Failed to process challenge');
    await ctx.reply('Something went wrong. Please try again.');
  }
}
