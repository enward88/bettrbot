import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { config } from '../utils/config.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('wallet');

// Encryption algorithm
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

// Solana connection
let connection: Connection | null = null;

export function getConnection(): Connection {
  if (!connection) {
    connection = new Connection(config.SOLANA_RPC_URL, 'confirmed');
  }
  return connection;
}

// Encrypt secret key for storage
export function encryptSecretKey(secretKey: Uint8Array): string {
  const key = Buffer.from(config.ENCRYPTION_KEY, 'hex');
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(Buffer.from(secretKey)), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Format: iv:authTag:encrypted (all base64)
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

// Decrypt secret key
export function decryptSecretKey(encryptedData: string): Uint8Array {
  const [ivB64, authTagB64, encryptedB64] = encryptedData.split(':');

  if (!ivB64 || !authTagB64 || !encryptedB64) {
    throw new Error('Invalid encrypted data format');
  }

  const key = Buffer.from(config.ENCRYPTION_KEY, 'hex');
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const encrypted = Buffer.from(encryptedB64, 'base64');

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return new Uint8Array(decrypted);
}

// Generate a new wallet for a betting round
export async function createRoundWallet(): Promise<{
  address: string;
  encryptedSecretKey: string;
}> {
  const keypair = Keypair.generate();
  const address = keypair.publicKey.toBase58();
  const encryptedSecretKey = encryptSecretKey(keypair.secretKey);

  logger.info({ address }, 'Created new round wallet');

  return { address, encryptedSecretKey };
}

// Get wallet balance in lamports
export async function getWalletBalance(address: string): Promise<bigint> {
  const conn = getConnection();
  const publicKey = new PublicKey(address);
  const balance = await conn.getBalance(publicKey);
  return BigInt(balance);
}

// Get wallet balance in SOL
export async function getWalletBalanceSol(address: string): Promise<number> {
  const lamports = await getWalletBalance(address);
  return Number(lamports) / LAMPORTS_PER_SOL;
}

// Send SOL from round wallet to recipient
export async function sendSol(
  fromEncryptedSecretKey: string,
  toAddress: string,
  amountLamports: bigint
): Promise<string> {
  const conn = getConnection();
  const secretKey = decryptSecretKey(fromEncryptedSecretKey);
  const fromKeypair = Keypair.fromSecretKey(secretKey);
  const toPublicKey = new PublicKey(toAddress);

  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: fromKeypair.publicKey,
      toPubkey: toPublicKey,
      lamports: amountLamports,
    })
  );

  const signature = await sendAndConfirmTransaction(conn, transaction, [fromKeypair]);

  logger.info(
    {
      from: fromKeypair.publicKey.toBase58(),
      to: toAddress,
      amount: amountLamports.toString(),
      signature,
    },
    'Sent SOL'
  );

  return signature;
}

// Get recent transactions for a wallet
export async function getRecentTransactions(
  address: string,
  limit = 10
): Promise<
  Array<{
    signature: string;
    slot: number;
    timestamp: number | null;
  }>
> {
  const conn = getConnection();
  const publicKey = new PublicKey(address);

  const signatures = await conn.getSignaturesForAddress(publicKey, { limit });

  return signatures.map((sig) => ({
    signature: sig.signature,
    slot: sig.slot,
    timestamp: sig.blockTime ?? null,
  }));
}
