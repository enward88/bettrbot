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
} from './bot/commands/index.js';
import {
  handleGameSelection,
  handleTeamSelection,
  handleChallengeGameSelection,
  handleChallengeTeamSelection,
  handleChallengeAccept,
  handleChallengeDecline,
} from './bot/callbacks/index.js';
import { handleConversationalBet } from './bot/handlers/index.js';
import { startScheduler } from './services/scheduler.js';
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

// Register callback handlers
bot.callbackQuery(/^bet:game:/, handleGameSelection);
bot.callbackQuery(/^bet:team:/, handleTeamSelection);
bot.callbackQuery(/^game:/, handleGameSelection);
bot.callbackQuery(/^challenge:game:/, handleChallengeGameSelection);
bot.callbackQuery(/^challenge:team:/, handleChallengeTeamSelection);
bot.callbackQuery(/^challenge:accept:/, handleChallengeAccept);
bot.callbackQuery(/^challenge:decline:/, handleChallengeDecline);

// Register conversational bet handler for @mentions
bot.on('message:text', handleConversationalBet);

// Start bot
async function main() {
  logger.info('Starting Bettr bot...');

  // Start the scheduler for background tasks
  startScheduler();

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
process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down...');
  bot.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down...');
  bot.stop();
  process.exit(0);
});
