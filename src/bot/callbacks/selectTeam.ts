import { type BotContext } from '../bot.js';
import { prisma } from '../../db/prisma.js';
import { createRoundWallet } from '../../services/wallet.js';
import { subscribeToWallet } from '../../services/walletSubscription.js';
import { MIN_BET_SOL, MAX_P2P_BET_SOL } from '../../utils/constants.js';
import { createChildLogger } from '../../utils/logger.js';
import { withLock } from '../../utils/locks.js';

const logger = createChildLogger('cb:selectTeam');

export async function handleTeamSelection(ctx: BotContext) {
  const callbackData = ctx.callbackQuery?.data;
  const telegramUser = ctx.from;

  if (!callbackData?.startsWith('bet:team:') || !telegramUser) {
    return;
  }

  const teamPick = callbackData.replace('bet:team:', '') as 'home' | 'away';
  const gameId = ctx.session.selectedGameId;

  if (!gameId) {
    await ctx.answerCallbackQuery({ text: 'Session expired. Please start over with /bet' });
    return;
  }

  try {
    // Get game
    const game = await prisma.game.findUnique({
      where: { id: gameId },
    });

    if (!game) {
      await ctx.answerCallbackQuery({ text: 'Game not found.' });
      return;
    }

    // Get or create user
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(telegramUser.id) },
    });

    if (!user) {
      await ctx.answerCallbackQuery({ text: 'Please /start first to register.' });
      return;
    }

    if (!user.solanaAddress) {
      await ctx.editMessageText(
        'You need to set your payout wallet first!\n\n' +
          'Use /wallet <your-solana-address> to set it.'
      );
      await ctx.answerCallbackQuery();
      return;
    }

    const chatId = ctx.chat?.id;
    if (!chatId) {
      await ctx.answerCallbackQuery({ text: 'Could not identify chat.' });
      return;
    }

    // Use lock to prevent race condition on round/wager creation
    const result = await withLock(`bet:${game.id}:${chatId}:${user.id}`, async () => {
      // Use transaction to atomically find/create round and wager
      return await prisma.$transaction(async (tx) => {
        // Find existing open round for this game/chat
        let round = await tx.round.findFirst({
          where: {
            gameId: game.id,
            chatId: BigInt(chatId),
            status: 'OPEN',
          },
        });

        if (!round) {
          // Create new round with unique wallet
          const { address, encryptedSecretKey } = await createRoundWallet();

          try {
            round = await tx.round.create({
              data: {
                gameId: game.id,
                chatId: BigInt(chatId),
                walletAddress: address,
                walletSecretKey: encryptedSecretKey,
                expiresAt: game.startTime,
              },
            });
            logger.info({ roundId: round.id, gameId, chatId }, 'Created new betting round');
            // Subscribe to wallet for real-time deposit detection
            const roundIdForSubscription = round.id;
            subscribeToWallet(address, roundIdForSubscription).catch((err) => {
              logger.warn({ error: err, roundId: roundIdForSubscription }, 'Failed to subscribe to wallet');
            });
          } catch (createError) {
            // If unique constraint violation, another user just created it - fetch it
            if ((createError as { code?: string }).code === 'P2002') {
              round = await tx.round.findFirst({
                where: {
                  gameId: game.id,
                  chatId: BigInt(chatId),
                  status: 'OPEN',
                },
              });
              if (!round) throw createError; // Re-throw if still not found
            } else {
              throw createError;
            }
          }
        }

        // Check if user already has a wager in this round (using unique constraint)
        const existingWager = await tx.wager.findUnique({
          where: {
            roundId_userId: {
              roundId: round.id,
              userId: user.id,
            },
          },
        });

        if (existingWager) {
          return { type: 'existing' as const, wager: existingWager, round };
        }

        // Create pending wager (amount will be set when deposit is detected)
        try {
          await tx.wager.create({
            data: {
              roundId: round.id,
              userId: user.id,
              teamPick,
              amount: BigInt(0),
            },
          });
        } catch (wagerError) {
          // If unique constraint violation, user already has a wager (race condition)
          if ((wagerError as { code?: string }).code === 'P2002') {
            const existingWager = await tx.wager.findUnique({
              where: {
                roundId_userId: {
                  roundId: round.id,
                  userId: user.id,
                },
              },
            });
            if (existingWager) {
              return { type: 'existing' as const, wager: existingWager, round };
            }
          }
          throw wagerError;
        }

        return { type: 'created' as const, round };
      });
    }, 30000); // 30 second lock timeout

    if (result === null) {
      await ctx.answerCallbackQuery({ text: 'Processing... please try again.' });
      return;
    }

    if (result.type === 'existing') {
      const teamName = result.wager.teamPick === 'home' ? game.homeTeam : game.awayTeam;
      await ctx.editMessageText(
        `You already have a bet on ${teamName} in this round.\n\n` +
          `Wallet: \`${result.round.walletAddress}\`\n\n` +
          `Send more SOL to increase your wager.`,
        { parse_mode: 'Markdown' }
      );
      await ctx.answerCallbackQuery();
      return;
    }

    const round = result.round;

    const teamName = teamPick === 'home' ? game.homeTeam : game.awayTeam;

    await ctx.editMessageText(
      `Bet placed on ${teamName}!\n\n` +
        `Send SOL to this wallet:\n\`${round.walletAddress}\`\n\n` +
        `Bet limits: ${MIN_BET_SOL} - ${MAX_P2P_BET_SOL} SOL\n\n` +
        `Your wager will be confirmed once the deposit is detected.\n` +
        `Bets lock when the game starts.`,
      { parse_mode: 'Markdown' }
    );

    await ctx.answerCallbackQuery({ text: 'Bet registered! Send SOL to confirm.' });

    logger.info(
      { userId: user.id, roundId: round.id, teamPick },
      'User placed bet'
    );
  } catch (error) {
    logger.error({ error, gameId }, 'Failed to handle team selection');
    await ctx.answerCallbackQuery({ text: 'Something went wrong. Please try again.' });
  }
}
