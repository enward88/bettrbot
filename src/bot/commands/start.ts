import { type BotContext } from '../bot.js';
import { prisma } from '../../db/prisma.js';
import { createChildLogger } from '../../utils/logger.js';

const logger = createChildLogger('cmd:start');

const GITHUB_README_URL = 'https://github.com/enward88/bettrbot#readme';

export async function startCommand(ctx: BotContext) {
  const telegramUser = ctx.from;

  if (!telegramUser) {
    await ctx.reply('Could not identify user.');
    return;
  }

  try {
    // Upsert user in database
    const user = await prisma.user.upsert({
      where: { telegramId: BigInt(telegramUser.id) },
      update: {
        username: telegramUser.username ?? null,
      },
      create: {
        telegramId: BigInt(telegramUser.id),
        username: telegramUser.username ?? null,
      },
    });

    logger.info({ userId: user.id, telegramId: telegramUser.id }, 'User registered/updated');

    // Check if this is a group chat or private chat
    const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';

    if (isGroup) {
      // Group onboarding message
      await ctx.reply(
        `🎲 Bettr is now active in this group!\n\n` +
        `📋 SETUP GUIDE\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `Step 1️⃣ - Everyone registers\n` +
        `Each person should tap /start in this chat or DM @${ctx.me?.username} to register.\n\n` +
        `Step 2️⃣ - Set your payout wallet\n` +
        `DM @${ctx.me?.username} with:\n` +
        `/wallet YOUR_SOLANA_ADDRESS\n\n` +
        `Step 3️⃣ - View available games\n` +
        `/games - See today's matchups\n\n` +
        `Step 4️⃣ - Place bets!\n` +
        `Just type naturally:\n` +
        `• "bet 1 sol lakers ML"\n` +
        `• "bet 0.5 sol chiefs -3.5"\n` +
        `• "2 sol over 220.5 celtics"\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📖 Full docs: ${GITHUB_README_URL}\n\n` +
        `Need help? /help`
      );
    } else {
      // Private chat welcome message
      const existingWallet = user.solanaAddress;

      let walletStatus = '';
      if (existingWallet) {
        walletStatus = `\n✅ Payout wallet: ${existingWallet.slice(0, 8)}...${existingWallet.slice(-4)}`;
      } else {
        walletStatus = `\n⚠️ No payout wallet set! Use /wallet <address> to set one.`;
      }

      await ctx.reply(
        `🎲 Welcome to Bettr!\n\n` +
        `You're registered and ready to bet on sports using SOL.${walletStatus}\n\n` +
        `📋 QUICK START\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `1. Set your payout wallet (if not set):\n` +
        `   /wallet YOUR_SOLANA_ADDRESS\n\n` +
        `2. Add me to a group chat with friends\n\n` +
        `3. View games: /games\n\n` +
        `4. Place bets naturally:\n` +
        `   • "bet 1 sol lakers ML"\n` +
        `   • "bet 0.5 sol chiefs -3.5"\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `Commands:\n` +
        `/games - View today's games\n` +
        `/mybets - Your active bets\n` +
        `/wallet - Set payout address\n` +
        `/help - Get help\n\n` +
        `📖 Full docs: ${GITHUB_README_URL}`
      );
    }
  } catch (error) {
    logger.error({ error, telegramId: telegramUser.id }, 'Failed to register user');
    await ctx.reply('Something went wrong. Please try again later.');
  }
}
