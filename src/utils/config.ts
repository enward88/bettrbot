import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),

  // Database
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Solana
  SOLANA_RPC_URL: z.string().url().default('https://api.devnet.solana.com'),
  SOLANA_NETWORK: z.enum(['devnet', 'mainnet-beta']).default('devnet'),
  TREASURY_WALLET_ADDRESS: z.string().min(1, 'TREASURY_WALLET_ADDRESS is required'),

  // Encryption
  ENCRYPTION_KEY: z.string().length(64, 'ENCRYPTION_KEY must be 64 hex characters (32 bytes)'),

  // Sports API
  BALLDONTLIE_API_KEY: z.string().min(1, 'BALLDONTLIE_API_KEY is required'),

  // Odds API (the-odds-api.com)
  ODDS_API_KEY: z.string().default(''),

  // Optional
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

export type Config = z.infer<typeof envSchema>;

function loadConfig(): Config {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('Invalid environment configuration:');
    for (const issue of result.error.issues) {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }

  return result.data;
}

export const config = loadConfig();
