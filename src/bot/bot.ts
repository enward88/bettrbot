import { Bot, Context, session } from 'grammy';
import { config } from '../utils/config.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('bot');

// Session data interface
interface SessionData {
  selectedGameId?: string;
  selectedTeam?: 'home' | 'away';
  challengeData?: {
    opponentId: string;
    opponentUsername: string;
    amount: string; // Stored as string to avoid BigInt serialization issues
  };
}

// Custom context type
export type BotContext = Context & {
  session: SessionData;
};

// Create bot instance
export const bot = new Bot<BotContext>(config.TELEGRAM_BOT_TOKEN);

// Initialize session middleware
bot.use(
  session({
    initial: (): SessionData => ({}),
  })
);

// Error handler
bot.catch((err) => {
  logger.error({ err: err.error, ctx: err.ctx?.update }, 'Bot error');
});

// Log all updates in development
if (config.NODE_ENV === 'development') {
  bot.use(async (ctx, next) => {
    logger.debug({ update: ctx.update }, 'Received update');
    await next();
  });
}
