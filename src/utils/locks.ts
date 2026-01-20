import { prisma } from '../db/prisma.js';
import { createChildLogger } from './logger.js';
import { randomUUID } from 'crypto';

const logger = createChildLogger('locks');

// Unique instance identifier for this process
const INSTANCE_ID = randomUUID();

// Default lock timeout in milliseconds
const DEFAULT_LOCK_TIMEOUT_MS = 60000; // 1 minute

/**
 * Acquire a distributed lock on a resource.
 * Returns true if lock acquired, false if resource is already locked.
 */
export async function acquireLock(
  resourceId: string,
  timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS
): Promise<boolean> {
  const expiresAt = new Date(Date.now() + timeoutMs);

  try {
    // Clean up any expired locks first
    await prisma.resourceLock.deleteMany({
      where: {
        expiresAt: { lt: new Date() },
      },
    });

    // Try to create lock - will fail if resource already locked (unique constraint)
    await prisma.resourceLock.create({
      data: {
        resourceId,
        lockedBy: INSTANCE_ID,
        expiresAt,
      },
    });

    logger.debug({ resourceId, instanceId: INSTANCE_ID }, 'Lock acquired');
    return true;
  } catch (error) {
    // Unique constraint violation means resource is locked
    if ((error as { code?: string }).code === 'P2002') {
      logger.debug({ resourceId }, 'Lock already held by another process');
      return false;
    }
    logger.error({ error, resourceId }, 'Failed to acquire lock');
    return false;
  }
}

/**
 * Release a distributed lock on a resource.
 */
export async function releaseLock(resourceId: string): Promise<void> {
  try {
    await prisma.resourceLock.deleteMany({
      where: {
        resourceId,
        lockedBy: INSTANCE_ID,
      },
    });
    logger.debug({ resourceId, instanceId: INSTANCE_ID }, 'Lock released');
  } catch (error) {
    logger.error({ error, resourceId }, 'Failed to release lock');
  }
}

/**
 * Execute a function while holding a lock.
 * Automatically acquires and releases the lock.
 * Returns null if lock could not be acquired.
 */
export async function withLock<T>(
  resourceId: string,
  fn: () => Promise<T>,
  timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS
): Promise<T | null> {
  const acquired = await acquireLock(resourceId, timeoutMs);
  if (!acquired) {
    return null;
  }

  try {
    return await fn();
  } finally {
    await releaseLock(resourceId);
  }
}

/**
 * Check if a Solana transaction has already been processed.
 */
export async function isTransactionProcessed(signature: string): Promise<boolean> {
  const existing = await prisma.processedTransaction.findUnique({
    where: { signature },
  });
  return existing !== null;
}

/**
 * Mark a Solana transaction as processed.
 * Returns true if marked successfully, false if already processed (duplicate).
 */
export async function markTransactionProcessed(
  signature: string,
  amount: bigint,
  roundId?: string,
  houseBetId?: string
): Promise<boolean> {
  try {
    await prisma.processedTransaction.create({
      data: {
        signature,
        amount,
        roundId,
        houseBetId,
      },
    });
    logger.debug({ signature, roundId, houseBetId }, 'Transaction marked as processed');
    return true;
  } catch (error) {
    // Unique constraint violation means already processed
    if ((error as { code?: string }).code === 'P2002') {
      logger.warn({ signature }, 'Transaction already processed (duplicate detected)');
      return false;
    }
    logger.error({ error, signature }, 'Failed to mark transaction as processed');
    throw error;
  }
}

/**
 * Get recently processed transactions for a round (for rehydrating in-memory cache).
 */
export async function getProcessedTransactionsForRound(roundId: string): Promise<string[]> {
  const txs = await prisma.processedTransaction.findMany({
    where: { roundId },
    select: { signature: true },
  });
  return txs.map((tx) => tx.signature);
}

/**
 * Acquire a wallet-level lock to prevent concurrent operations on the same wallet.
 * This prevents race conditions like refunding and settling the same wallet simultaneously.
 */
export async function withWalletLock<T>(
  walletAddress: string,
  fn: () => Promise<T>,
  timeoutMs: number = 120000
): Promise<T | null> {
  return withLock(`wallet:${walletAddress}`, fn, timeoutMs);
}
