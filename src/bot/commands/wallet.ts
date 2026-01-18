import { PublicKey } from '@solana/web3.js';
import { type BotContext } from '../bot.js';
import { prisma } from '../../db/prisma.js';
import { createChildLogger } from '../../utils/logger.js';

const logger = createChildLogger('cmd:wallet');

export async function walletCommand(ctx: BotContext) {
  const telegramUser = ctx.from;

  if (!telegramUser) {
    await ctx.reply('Could not identify user.');
    return;
  }

  // Extract wallet address from message
  const text = ctx.message?.text ?? '';
  const parts = text.split(/\s+/);
  const address = parts[1];

  if (!address) {
    // Show current wallet
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(telegramUser.id) },
    });

    if (!user) {
      await ctx.reply('You need to /start first to register.');
      return;
    }

    if (user.solanaAddress) {
      await ctx.reply(
        `Your current payout wallet:\n\`${user.solanaAddress}\`\n\nTo change it, use:\n/wallet <new-address>`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await ctx.reply(
        'You have not set a payout wallet yet.\n\nUse:\n/wallet <your-solana-address>\n\nThis is where your winnings will be sent.'
      );
    }
    return;
  }

  // Validate Solana address
  try {
    new PublicKey(address);
  } catch {
    await ctx.reply(
      'Invalid Solana address. Please provide a valid wallet address.\n\nExample:\n/wallet 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
    );
    return;
  }

  try {
    // Update user's wallet
    await prisma.user.update({
      where: { telegramId: BigInt(telegramUser.id) },
      data: { solanaAddress: address },
    });

    logger.info({ telegramId: telegramUser.id, address }, 'User wallet updated');

    await ctx.reply(
      `Payout wallet set to:\n\`${address}\`\n\nYour winnings will be sent to this address.`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    logger.error({ error, telegramId: telegramUser.id }, 'Failed to update wallet');
    await ctx.reply('Failed to update wallet. Please try again.');
  }
}
