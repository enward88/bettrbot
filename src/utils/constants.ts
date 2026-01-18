// Fee percentage taken from each bet (1%)
export const FEE_PERCENTAGE = 0.01;

// Minimum bet amount in SOL
export const MIN_BET_SOL = 0.01;

// Minimum bet amount in lamports (1 SOL = 1,000,000,000 lamports)
export const LAMPORTS_PER_SOL = 1_000_000_000;
export const MIN_BET_LAMPORTS = MIN_BET_SOL * LAMPORTS_PER_SOL;

// Wallet polling interval in milliseconds
export const WALLET_POLL_INTERVAL_MS = 30_000;

// Game refresh interval (how often to fetch new games)
export const GAME_REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// Game result polling interval during live games
export const RESULT_POLL_INTERVAL_MS = 60_000; // 1 minute

// All sports in schema
export const SUPPORTED_SPORTS = ['NBA', 'NFL', 'NHL', 'NCAAF', 'MMA'] as const;
export type Sport = (typeof SUPPORTED_SPORTS)[number];

// Sports available on free API tier
export const FREE_TIER_SPORTS: Sport[] = ['NBA', 'NFL', 'MMA'];

// How long before game start to lock bets (in milliseconds)
export const BET_LOCK_BUFFER_MS = 5 * 60 * 1000; // 5 minutes before game

// Timeout for bets with no opposing wagers (in hours)
export const BET_TIMEOUT_HOURS = 24;
