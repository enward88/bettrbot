import { Connection, PublicKey } from '@solana/web3.js';
import { prisma } from '../db/prisma.js';
import { config } from '../utils/config.js';
import { createChildLogger } from '../utils/logger.js';
import { bot } from '../bot/bot.js';
import { MIN_BET_LAMPORTS, MAX_P2P_BET_SOL, LAMPORTS_PER_SOL } from '../utils/constants.js';
import { isTransactionProcessed, markTransactionProcessed, withLock } from '../utils/locks.js';

const logger = createChildLogger('walletSubscription');

// Track active subscriptions by wallet address
const activeSubscriptions = new Map<string, number>();

// WebSocket connection for subscriptions
let wsConnection: Connection | null = null;

function getWsConnection(): Connection {
  if (!wsConnection) {
    // Use WebSocket URL (wss://) for subscriptions
    const wsUrl = config.SOLANA_RPC_URL.replace('https://', 'wss://').replace('http://', 'ws://');
    wsConnection = new Connection(wsUrl, {
      commitment: 'confirmed',
      wsEndpoint: wsUrl,
    });
  }
  return wsConnection;
}

/**
 * Subscribe to account changes for a wallet address.
 * When a deposit is detected, it processes it immediately.
 */
export async function subscribeToWallet(walletAddress: string, roundId: string): Promise<void> {
  // Don't subscribe twice to the same wallet
  if (activeSubscriptions.has(walletAddress)) {
    logger.debug({ walletAddress }, 'Already subscribed to wallet');
    return;
  }

  try {
    const conn = getWsConnection();
    const publicKey = new PublicKey(walletAddress);

    const subscriptionId = conn.onAccountChange(
      publicKey,
      async (accountInfo, context) => {
        logger.info(
          { walletAddress, slot: context.slot, balance: accountInfo.lamports },
          'Account change detected'
        );

        // Process the deposit
        await processWalletDeposit(walletAddress, roundId, BigInt(accountInfo.lamports));
      },
      'confirmed'
    );

    activeSubscriptions.set(walletAddress, subscriptionId);
    logger.info({ walletAddress, subscriptionId }, 'Subscribed to wallet');
  } catch (error) {
    logger.error({ error, walletAddress }, 'Failed to subscribe to wallet');
  }
}

/**
 * Unsubscribe from a wallet when the round is closed/settled.
 */
export async function unsubscribeFromWallet(walletAddress: string): Promise<void> {
  const subscriptionId = activeSubscriptions.get(walletAddress);
  if (subscriptionId === undefined) {
    return;
  }

  try {
    const conn = getWsConnection();
    await conn.removeAccountChangeListener(subscriptionId);
    activeSubscriptions.delete(walletAddress);
    logger.info({ walletAddress, subscriptionId }, 'Unsubscribed from wallet');
  } catch (error) {
    logger.error({ error, walletAddress }, 'Failed to unsubscribe from wallet');
  }
}

/**
 * Process a detected deposit on a wallet.
 */
async function processWalletDeposit(
  walletAddress: string,
  roundId: string,
  newBalance: bigint
): Promise<void> {
  // Use lock to prevent concurrent processing
  await withLock(`deposit:${walletAddress}`, async () => {
    // Get the round with wagers
    const round = await prisma.round.findUnique({
      where: { id: roundId },
      include: {
        wagers: {
          include: { user: true },
        },
        game: true,
      },
    });

    if (!round || round.status !== 'OPEN') {
      logger.debug({ roundId, status: round?.status }, 'Round not open, ignoring deposit');
      return;
    }

    // Find pending wager without amount
    const pendingWager = round.wagers.find((w) => w.amount === BigInt(0) && !w.txSignature);
    if (!pendingWager) {
      logger.debug({ roundId }, 'No pending wager found');
      return;
    }

    // Calculate deposit amount (new balance - current total pot - rent exempt minimum)
    const RENT_EXEMPT_MIN = BigInt(890880); // Minimum rent-exempt balance
    const expectedPreviousBalance = round.totalPot + RENT_EXEMPT_MIN;

    if (newBalance <= expectedPreviousBalance) {
      // Balance didn't increase enough
      return;
    }

    const depositAmount = newBalance - expectedPreviousBalance;
    const maxP2pLamports = BigInt(MAX_P2P_BET_SOL * LAMPORTS_PER_SOL);

    if (depositAmount < MIN_BET_LAMPORTS) {
      logger.debug({ depositAmount: depositAmount.toString() }, 'Deposit too small');
      return;
    }

    // Cap deposit at max
    const cappedAmount = depositAmount > maxP2pLamports ? maxP2pLamports : depositAmount;

    // Update wager and round atomically
    try {
      await prisma.$transaction(async (tx) => {
        await tx.wager.update({
          where: { id: pendingWager.id },
          data: {
            amount: cappedAmount,
            txSignature: `ws_${Date.now()}`, // Mark as processed via websocket
          },
        });

        await tx.round.update({
          where: { id: round.id },
          data: {
            totalPot: { increment: cappedAmount },
          },
        });
      });

      const solAmount = Number(cappedAmount) / LAMPORTS_PER_SOL;
      const teamName = pendingWager.teamPick === 'home' ? round.game.homeTeam : round.game.awayTeam;
      const username = pendingWager.user.username ? `@${pendingWager.user.username}` : 'Someone';

      // Notify chat
      try {
        await bot.api.sendMessage(
          round.chatId.toString(),
          `${username} bet ${solAmount.toFixed(4)} SOL on ${teamName}!\n\n` +
            `${round.game.awayTeam} @ ${round.game.homeTeam}\n` +
            `Total pot: ${(Number(round.totalPot + cappedAmount) / LAMPORTS_PER_SOL).toFixed(4)} SOL`
        );
      } catch (notifyError) {
        logger.warn({ error: notifyError }, 'Failed to send deposit notification');
      }

      logger.info(
        { roundId, wagerId: pendingWager.id, amount: cappedAmount.toString() },
        'Deposit processed via WebSocket'
      );
    } catch (error) {
      logger.error({ error, roundId }, 'Failed to process deposit');
    }
  }, 30000);
}

/**
 * Subscribe to all open round wallets on startup.
 */
export async function subscribeToAllOpenRounds(): Promise<void> {
  const openRounds = await prisma.round.findMany({
    where: { status: 'OPEN' },
    select: { id: true, walletAddress: true },
  });

  logger.info({ count: openRounds.length }, 'Subscribing to open round wallets');

  for (const round of openRounds) {
    await subscribeToWallet(round.walletAddress, round.id);
  }
}

/**
 * Clean up all subscriptions (for graceful shutdown).
 */
export async function unsubscribeAll(): Promise<void> {
  logger.info({ count: activeSubscriptions.size }, 'Unsubscribing from all wallets');

  for (const walletAddress of activeSubscriptions.keys()) {
    await unsubscribeFromWallet(walletAddress);
  }
}

/**
 * Check if WebSocket subscriptions are healthy.
 */
export function getSubscriptionCount(): number {
  return activeSubscriptions.size;
}
