import { bot } from './bot/bot.js';
import {
  startCommand,
  helpCommand,
  gamesCommand,
  betCommand,
  mybetsCommand,
  walletCommand,
  potCommand,
  challengeCommand,
  adminCommand,
  adminBetsCommand,
  adminPendingCommand,
  adminSettleCommand,
  adminRefundCommand,
  adminExposureCommand,
  adminStatsCommand,
  adminTestGameCommand,
  adminSimStartCommand,
  adminSimEndCommand,
  handleAdminCallback,
} from './bot/commands/index.js';
import {
  handleGameSelection,
  handleTeamSelection,
  handleChallengeGameSelection,
  handleChallengeTeamSelection,
  handleChallengeAccept,
  handleChallengeDecline,
  handleHouseBetSelection,
  handleHouseBetAmount,
} from './bot/callbacks/index.js';
import { handleConversationalBet } from './bot/handlers/index.js';
import { startScheduler, stopScheduler } from './services/scheduler.js';
import { logger } from './utils/logger.js';

// Register commands
bot.command('start', startCommand);
bot.command('help', helpCommand);
bot.command('games', gamesCommand);
bot.command('bet', betCommand);
bot.command('mybets', mybetsCommand);
bot.command('wallet', walletCommand);
bot.command('pot', potCommand);
bot.command('challenge', challengeCommand);

// Admin commands (restricted to ADMIN_TELEGRAM_ID)
bot.command('admin', async (ctx) => {
  const text = ctx.message?.text || '';
  const parts = text.split(/\s+/);
  const subcommand = parts[1]?.toLowerCase();

  switch (subcommand) {
    case 'bets':
      await adminBetsCommand(ctx);
      break;
    case 'pending':
      await adminPendingCommand(ctx);
      break;
    case 'settle':
      await adminSettleCommand(ctx);
      break;
    case 'refund':
      await adminRefundCommand(ctx);
      break;
    case 'exposure':
      await adminExposureCommand(ctx);
      break;
    case 'stats':
      await adminStatsCommand(ctx);
      break;
    case 'testgame':
      await adminTestGameCommand(ctx);
      break;
    case 'simstart':
      await adminSimStartCommand(ctx);
      break;
    case 'simend':
      await adminSimEndCommand(ctx);
      break;
    default:
      await adminCommand(ctx);
  }
});

// Register callback handlers
bot.callbackQuery(/^bet:game:/, handleGameSelection);
bot.callbackQuery(/^bet:team:/, handleTeamSelection);
bot.callbackQuery(/^game:/, handleGameSelection);
bot.callbackQuery(/^challenge:game:/, handleChallengeGameSelection);
bot.callbackQuery(/^challenge:team:/, handleChallengeTeamSelection);
bot.callbackQuery(/^challenge:accept:/, handleChallengeAccept);
bot.callbackQuery(/^challenge:decline:/, handleChallengeDecline);
bot.callbackQuery(/^house:/, handleHouseBetSelection);
bot.callbackQuery(/^admin:/, handleAdminCallback);

// Register text handlers
bot.on('message:text', async (ctx, next) => {
  // Check for pending house bet amount first
  if (ctx.session.pendingHouseBet) {
    await handleHouseBetAmount(ctx);
    return;
  }
  // Otherwise try conversational betting
  await handleConversationalBet(ctx);
  await next();
});

// Start bot
async function main() {
  logger.info('Starting Bettr bot...');

  // Start the scheduler for background tasks (including WebSocket subscriptions)
  await startScheduler();

  // Start bot polling
  await bot.start({
    onStart: (botInfo) => {
      logger.info({ username: botInfo.username }, 'Bot started');
    },
  });
}

main().catch((error) => {
  logger.error({ error }, 'Fatal error');
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down...');
  await stopScheduler();
  bot.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down...');
  await stopScheduler();
  bot.stop();
  process.exit(0);
});
