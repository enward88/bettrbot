import { InlineKeyboard } from 'grammy';
import { type BotContext } from '../bot.js';
import { prisma } from '../../db/prisma.js';
import { createRoundWallet } from '../../services/wallet.js';
import { LAMPORTS_PER_SOL, MIN_BET_SOL } from '../../utils/constants.js';
import { createChildLogger } from '../../utils/logger.js';
import { withLock } from '../../utils/locks.js';

const logger = createChildLogger('cb:challenge');

// Handle game selection for challenge
export async function handleChallengeGameSelection(ctx: BotContext) {
  const callbackData = ctx.callbackQuery?.data;
  const telegramUser = ctx.from;

  if (!callbackData?.startsWith('challenge:game:') || !telegramUser) {
    return;
  }

  const gameId = callbackData.replace('challenge:game:', '');
  const challengeData = ctx.session.challengeData;

  if (!challengeData) {
    await ctx.answerCallbackQuery({ text: 'Session expired. Please start over with /challenge' });
    return;
  }

  try {
    const game = await prisma.game.findUnique({
      where: { id: gameId },
    });

    if (!game) {
      await ctx.answerCallbackQuery({ text: 'Game not found.' });
      return;
    }

    // Store game selection
    ctx.session.selectedGameId = gameId;

    // Show team selection
    const keyboard = new InlineKeyboard()
      .text(game.homeTeam, 'challenge:team:home')
      .text(game.awayTeam, 'challenge:team:away');

    const amount = Number(BigInt(challengeData.amount)) / LAMPORTS_PER_SOL;

    await ctx.editMessageText(
      `Challenge @${challengeData.opponentUsername} for ${amount} SOL\n\n` +
      `${game.awayTeam} @ ${game.homeTeam}\n\n` +
      'Pick YOUR team:',
      { reply_markup: keyboard }
    );

    await ctx.answerCallbackQuery();
  } catch (error) {
    logger.error({ error }, 'Failed to handle challenge game selection');
    await ctx.answerCallbackQuery({ text: 'Something went wrong.' });
  }
}

// Handle team selection for challenge
export async function handleChallengeTeamSelection(ctx: BotContext) {
  const callbackData = ctx.callbackQuery?.data;
  const telegramUser = ctx.from;
  const chatId = ctx.chat?.id;

  if (!callbackData?.startsWith('challenge:team:') || !telegramUser || !chatId) {
    return;
  }

  const teamPick = callbackData.replace('challenge:team:', '') as 'home' | 'away';
  const gameId = ctx.session.selectedGameId;
  const challengeData = ctx.session.challengeData;

  if (!gameId || !challengeData) {
    await ctx.answerCallbackQuery({ text: 'Session expired. Please start over.' });
    return;
  }

  try {
    const game = await prisma.game.findUnique({
      where: { id: gameId },
    });

    if (!game) {
      await ctx.answerCallbackQuery({ text: 'Game not found.' });
      return;
    }

    const challenger = await prisma.user.findUnique({
      where: { telegramId: BigInt(telegramUser.id) },
    });

    if (!challenger) {
      await ctx.answerCallbackQuery({ text: 'Please /start first.' });
      return;
    }

    const amountLamports = BigInt(challengeData.amount);
    const amountSol = Number(amountLamports) / LAMPORTS_PER_SOL;

    // Create the challenge (expires in 10 minutes)
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    const challenge = await prisma.challenge.create({
      data: {
        gameId: game.id,
        chatId: BigInt(chatId),
        challengerId: challenger.id,
        challengerTeam: teamPick,
        opponentId: challengeData.opponentId,
        amount: amountLamports,
        expiresAt,
      },
    });

    const challengerTeamName = teamPick === 'home' ? game.homeTeam : game.awayTeam;
    const opponentTeamName = teamPick === 'home' ? game.awayTeam : game.homeTeam;

    // Create accept/decline buttons
    const keyboard = new InlineKeyboard()
      .text('Accept', `challenge:accept:${challenge.id}`)
      .text('Decline', `challenge:decline:${challenge.id}`);

    await ctx.editMessageText(
      `Challenge sent!\n\n` +
      `@${challengeData.opponentUsername} - you've been challenged!\n\n` +
      `${game.awayTeam} @ ${game.homeTeam}\n` +
      `Amount: ${amountSol} SOL each\n\n` +
      `@${challenger.username ?? 'Challenger'} picks: ${challengerTeamName}\n` +
      `@${challengeData.opponentUsername} would get: ${opponentTeamName}\n\n` +
      `Challenge expires in 10 minutes.`,
      { reply_markup: keyboard }
    );

    await ctx.answerCallbackQuery({ text: 'Challenge sent!' });

    // Clear session data
    ctx.session.challengeData = undefined;
    ctx.session.selectedGameId = undefined;

    logger.info(
      { challengeId: challenge.id, challengerId: challenger.id, opponentId: challengeData.opponentId },
      'Challenge created'
    );
  } catch (error) {
    logger.error({ error }, 'Failed to create challenge');
    await ctx.answerCallbackQuery({ text: 'Something went wrong.' });
  }
}

// Handle accepting a challenge
export async function handleChallengeAccept(ctx: BotContext) {
  const callbackData = ctx.callbackQuery?.data;
  const telegramUser = ctx.from;
  const chatId = ctx.chat?.id;

  if (!callbackData?.startsWith('challenge:accept:') || !telegramUser || !chatId) {
    return;
  }

  const challengeId = callbackData.replace('challenge:accept:', '');

  try {
    // Use distributed lock to prevent race condition on double-click
    const result = await withLock(`challenge:accept:${challengeId}`, async () => {
      // Use transaction for atomicity
      return await prisma.$transaction(async (tx) => {
        const challenge = await tx.challenge.findUnique({
          where: { id: challengeId },
          include: {
            game: true,
            challenger: true,
            opponent: true,
          },
        });

        if (!challenge) {
          return { error: 'Challenge not found.' };
        }

        // Verify the user accepting is the opponent
        const user = await tx.user.findUnique({
          where: { telegramId: BigInt(telegramUser.id) },
        });

        if (!user || user.id !== challenge.opponentId) {
          return { error: 'Only the challenged user can accept.' };
        }

        if (challenge.status !== 'PENDING') {
          return { error: 'This challenge is no longer active.' };
        }

        if (new Date() > challenge.expiresAt) {
          await tx.challenge.update({
            where: { id: challengeId },
            data: { status: 'EXPIRED' },
          });
          return { error: 'This challenge has expired.' };
        }

        // Create a new round for this challenge
        const { address, encryptedSecretKey } = await createRoundWallet();

        const round = await tx.round.create({
          data: {
            gameId: challenge.gameId,
            chatId: challenge.chatId,
            walletAddress: address,
            walletSecretKey: encryptedSecretKey,
            expiresAt: challenge.game.startTime,
          },
        });

        // Create wagers for both users (pending deposit)
        const opponentTeam = challenge.challengerTeam === 'home' ? 'away' : 'home';

        await tx.wager.createMany({
          data: [
            {
              roundId: round.id,
              userId: challenge.challengerId,
              teamPick: challenge.challengerTeam,
              amount: BigInt(0),
            },
            {
              roundId: round.id,
              userId: challenge.opponentId,
              teamPick: opponentTeam,
              amount: BigInt(0),
            },
          ],
        });

        // Update challenge status
        await tx.challenge.update({
          where: { id: challengeId },
          data: {
            status: 'ACCEPTED',
            roundId: round.id,
          },
        });

        return { success: true, challenge, round, address };
      });
    }, 30000); // 30 second lock timeout

    if (result === null) {
      await ctx.answerCallbackQuery({ text: 'Processing... please wait.' });
      return;
    }

    if ('error' in result) {
      await ctx.answerCallbackQuery({ text: result.error });
      return;
    }

    const { challenge, round, address } = result;
    const amountSol = Number(challenge.amount) / LAMPORTS_PER_SOL;
    const challengerTeamName = challenge.challengerTeam === 'home'
      ? challenge.game.homeTeam
      : challenge.game.awayTeam;
    const opponentTeamName = challenge.challengerTeam === 'home'
      ? challenge.game.awayTeam
      : challenge.game.homeTeam;

    await ctx.editMessageText(
      `Challenge ACCEPTED!\n\n` +
      `${challenge.game.awayTeam} @ ${challenge.game.homeTeam}\n\n` +
      `@${challenge.challenger.username ?? 'Challenger'}: ${challengerTeamName}\n` +
      `@${challenge.opponent.username ?? 'Opponent'}: ${opponentTeamName}\n\n` +
      `Both players send ${amountSol} SOL to:\n` +
      `\`${address}\`\n\n` +
      `Bets lock when the game starts. Winner takes all!`,
      { parse_mode: 'Markdown' }
    );

    await ctx.answerCallbackQuery({ text: 'Challenge accepted!' });

    logger.info({ challengeId, roundId: round.id }, 'Challenge accepted');
  } catch (error) {
    logger.error({ error }, 'Failed to accept challenge');
    await ctx.answerCallbackQuery({ text: 'Something went wrong.' });
  }
}

// Handle declining a challenge
export async function handleChallengeDecline(ctx: BotContext) {
  const callbackData = ctx.callbackQuery?.data;
  const telegramUser = ctx.from;

  if (!callbackData?.startsWith('challenge:decline:') || !telegramUser) {
    return;
  }

  const challengeId = callbackData.replace('challenge:decline:', '');

  try {
    const challenge = await prisma.challenge.findUnique({
      where: { id: challengeId },
      include: {
        challenger: true,
        opponent: true,
      },
    });

    if (!challenge) {
      await ctx.answerCallbackQuery({ text: 'Challenge not found.' });
      return;
    }

    // Verify the user declining is the opponent
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(telegramUser.id) },
    });

    if (!user || user.id !== challenge.opponentId) {
      await ctx.answerCallbackQuery({ text: 'Only the challenged user can decline.' });
      return;
    }

    if (challenge.status !== 'PENDING') {
      await ctx.answerCallbackQuery({ text: 'This challenge is no longer active.' });
      return;
    }

    await prisma.challenge.update({
      where: { id: challengeId },
      data: { status: 'DECLINED' },
    });

    await ctx.editMessageText(
      `Challenge declined.\n\n` +
      `@${challenge.opponent.username ?? 'User'} declined the challenge from ` +
      `@${challenge.challenger.username ?? 'Challenger'}.`
    );

    await ctx.answerCallbackQuery({ text: 'Challenge declined.' });

    logger.info({ challengeId }, 'Challenge declined');
  } catch (error) {
    logger.error({ error }, 'Failed to decline challenge');
    await ctx.answerCallbackQuery({ text: 'Something went wrong.' });
  }
}
