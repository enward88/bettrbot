import { InlineKeyboard } from 'grammy';
import { type BotContext } from '../bot.js';
import { prisma } from '../../db/prisma.js';
import { SUPPORTED_SPORTS, SPORT_EMOJIS } from '../../utils/constants.js';
import { formatOdds } from '../../services/odds.js';
import { createChildLogger } from '../../utils/logger.js';

const logger = createChildLogger('cmd:games');

export async function gamesCommand(ctx: BotContext) {
  try {
    // Get upcoming games (next 24 hours from now)
    const now = new Date();
    const next24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    // Fetch games from database - upcoming scheduled games
    const games = await prisma.game.findMany({
      where: {
        startTime: {
          gte: now,
          lt: next24Hours,
        },
        status: 'SCHEDULED',
      },
      orderBy: [{ sport: 'asc' }, { startTime: 'asc' }],
    });

    // Also get live games
    const liveGames = await prisma.game.findMany({
      where: {
        status: 'LIVE',
      },
      orderBy: [{ sport: 'asc' }, { startTime: 'asc' }],
    });

    const allGames = [...liveGames, ...games];

    if (allGames.length === 0) {
      await ctx.reply(
        "No games scheduled in the next 24 hours. Check back later!\n\nSupported sports: " +
          SUPPORTED_SPORTS.join(', ')
      );
      return;
    }

    // Group games by sport
    const gamesBySport = allGames.reduce(
      (acc, game) => {
        const sport = game.sport;
        if (!acc[sport]) {
          acc[sport] = [];
        }
        acc[sport].push(game);
        return acc;
      },
      {} as Record<string, typeof games>
    );

    // Build message
    let message = "Upcoming Games:\n\n";

    for (const sport of SUPPORTED_SPORTS) {
      const sportGames = gamesBySport[sport];
      if (!sportGames || sportGames.length === 0) continue;

      const emoji = SPORT_EMOJIS[sport] ?? '🎮';
      message += `${emoji} ${sport}\n`;

      for (const game of sportGames) {
        const time = game.startTime.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
          timeZone: 'America/New_York',
        });
        const statusLabel = game.status === 'LIVE' ? ' 🔴 LIVE' : '';

        // Build odds display
        let oddsStr = '';
        if (game.homeMoneyline !== null && game.awayMoneyline !== null) {
          oddsStr = ` [${formatOdds(game.awayMoneyline)}/${formatOdds(game.homeMoneyline)}]`;
        }

        message += `  ${game.awayTeam} @ ${game.homeTeam} - ${time} ET${statusLabel}${oddsStr}\n`;
      }
      message += '\n';
    }

    message += 'Use /bet to place a wager on any game!';

    // Create inline keyboard with game buttons
    const keyboard = new InlineKeyboard();
    let buttonCount = 0;

    for (const game of allGames) {
      if (buttonCount >= 10) break; // Limit buttons

      const label = `${game.awayTeam} @ ${game.homeTeam}`;
      keyboard.text(label, `game:${game.id}`);

      buttonCount++;
      if (buttonCount % 1 === 0) {
        keyboard.row();
      }
    }

    await ctx.reply(message, { reply_markup: keyboard });
  } catch (error) {
    logger.error({ error }, 'Failed to fetch games');
    await ctx.reply('Failed to load games. Please try again later.');
  }
}
