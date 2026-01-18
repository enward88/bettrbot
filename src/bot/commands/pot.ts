import { type BotContext } from '../bot.js';
import { prisma } from '../../db/prisma.js';
import { LAMPORTS_PER_SOL } from '../../utils/constants.js';
import { createChildLogger } from '../../utils/logger.js';

const logger = createChildLogger('cmd:pot');

export async function potCommand(ctx: BotContext) {
  const chatId = ctx.chat?.id;

  if (!chatId) {
    await ctx.reply('Could not identify chat.');
    return;
  }

  try {
    // Get active rounds in this chat
    const rounds = await prisma.round.findMany({
      where: {
        chatId: BigInt(chatId),
        status: { in: ['OPEN', 'LOCKED'] },
      },
      include: {
        game: true,
        wagers: {
          where: { amount: { gt: 0 } },
          include: {
            user: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    if (rounds.length === 0) {
      await ctx.reply('No active bets in this chat. Use /bet to start one!');
      return;
    }

    let message = '🎰 Active Bets in this Chat:\n\n';

    for (const round of rounds) {
      const game = round.game;
      const status = round.status === 'OPEN' ? '🟢 Open' : '🔒 Locked';
      const totalPotSol = Number(round.totalPot) / LAMPORTS_PER_SOL;

      const homeWagers = round.wagers.filter((w) => w.teamPick === 'home');
      const awayWagers = round.wagers.filter((w) => w.teamPick === 'away');

      const homeTotalSol = homeWagers.reduce((sum, w) => sum + Number(w.amount), 0) / LAMPORTS_PER_SOL;
      const awayTotalSol = awayWagers.reduce((sum, w) => sum + Number(w.amount), 0) / LAMPORTS_PER_SOL;

      const gameTime = game.startTime.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: 'America/New_York',
      });

      message += `${game.awayTeam} @ ${game.homeTeam}\n`;
      message += `Status: ${status} | ${gameTime} ET\n`;
      message += `Total pot: ${totalPotSol.toFixed(4)} SOL\n\n`;

      message += `${game.homeTeam}: ${homeTotalSol.toFixed(4)} SOL\n`;
      for (const wager of homeWagers) {
        const username = wager.user.username ? `@${wager.user.username}` : 'Anonymous';
        const amountSol = Number(wager.amount) / LAMPORTS_PER_SOL;
        message += `  └ ${username}: ${amountSol.toFixed(4)} SOL\n`;
      }

      message += `${game.awayTeam}: ${awayTotalSol.toFixed(4)} SOL\n`;
      for (const wager of awayWagers) {
        const username = wager.user.username ? `@${wager.user.username}` : 'Anonymous';
        const amountSol = Number(wager.amount) / LAMPORTS_PER_SOL;
        message += `  └ ${username}: ${amountSol.toFixed(4)} SOL\n`;
      }

      if (round.status === 'OPEN') {
        message += `\nWallet: \`${round.walletAddress}\`\n`;
      }
      message += '\n---\n\n';
    }

    await ctx.reply(message, { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error({ error, chatId }, 'Failed to fetch pot info');
    await ctx.reply('Failed to load pot info. Please try again.');
  }
}
