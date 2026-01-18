// Fee percentage taken from P2P bets (1%)
export const FEE_PERCENTAGE = 0.01;

// House edge on house bets (2%) - reduces payouts by this percentage
export const HOUSE_EDGE_PERCENTAGE = 0.02;

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
export const SUPPORTED_SPORTS = [
  // US Major Sports
  'NBA', 'NFL', 'NHL', 'MLB', 'WNBA',
  // College
  'NCAAF', 'NCAAB',
  // Combat Sports
  'MMA',
  // Soccer
  'EPL', 'MLS', 'LALIGA', 'SERIEA', 'BUNDESLIGA', 'LIGUE1', 'UCL',
  // Esports
  'CS2', 'LOL', 'DOTA2',
] as const;
export type Sport = (typeof SUPPORTED_SPORTS)[number];

// Display names for sports
export const SPORT_DISPLAY_NAMES: Record<Sport, string> = {
  NBA: 'NBA',
  NFL: 'NFL',
  NHL: 'NHL',
  MLB: 'MLB',
  WNBA: 'WNBA',
  NCAAF: 'College Football',
  NCAAB: 'College Basketball',
  MMA: 'MMA/UFC',
  EPL: 'Premier League',
  MLS: 'MLS',
  LALIGA: 'La Liga',
  SERIEA: 'Serie A',
  BUNDESLIGA: 'Bundesliga',
  LIGUE1: 'Ligue 1',
  UCL: 'Champions League',
  CS2: 'CS2',
  LOL: 'League of Legends',
  DOTA2: 'Dota 2',
};

// Sport emojis
export const SPORT_EMOJIS: Record<Sport, string> = {
  NBA: '🏀',
  NFL: '🏈',
  NHL: '🏒',
  MLB: '⚾',
  WNBA: '🏀',
  NCAAF: '🏈',
  NCAAB: '🏀',
  MMA: '🥊',
  EPL: '⚽',
  MLS: '⚽',
  LALIGA: '⚽',
  SERIEA: '⚽',
  BUNDESLIGA: '⚽',
  LIGUE1: '⚽',
  UCL: '⚽',
  CS2: '🎮',
  LOL: '🎮',
  DOTA2: '🎮',
};

// How long before game start to lock bets (in milliseconds)
export const BET_LOCK_BUFFER_MS = 5 * 60 * 1000; // 5 minutes before game

// Timeout for bets with no opposing wagers (in hours)
export const BET_TIMEOUT_HOURS = 24;
