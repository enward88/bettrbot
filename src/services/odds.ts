import { config } from '../utils/config.js';
import { createChildLogger } from '../utils/logger.js';
import { prisma } from '../db/prisma.js';

const logger = createChildLogger('odds');

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

// Map our sport enum to the-odds-api sport keys
const SPORT_KEY_MAP: Record<string, string> = {
  NBA: 'basketball_nba',
  NFL: 'americanfootball_nfl',
  NHL: 'icehockey_nhl',
  MLB: 'baseball_mlb',
  WNBA: 'basketball_wnba',
  NCAAF: 'americanfootball_ncaaf',
  NCAAB: 'basketball_ncaab',
  MMA: 'mma_mixed_martial_arts',
  EPL: 'soccer_epl',
  MLS: 'soccer_usa_mls',
  LALIGA: 'soccer_spain_la_liga',
  SERIEA: 'soccer_italy_serie_a',
  BUNDESLIGA: 'soccer_germany_bundesliga',
  LIGUE1: 'soccer_france_ligue_one',
  UCL: 'soccer_uefa_champs_league',
};

interface OddsApiGame {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: Bookmaker[];
}

interface Bookmaker {
  key: string;
  title: string;
  markets: Market[];
}

interface Market {
  key: string; // h2h, spreads, totals
  outcomes: Outcome[];
}

interface Outcome {
  name: string;
  price: number;
  point?: number; // For spreads and totals
}

// Fetch odds for a specific sport
export async function fetchOddsForSport(sportKey: string): Promise<OddsApiGame[]> {
  if (!config.ODDS_API_KEY) {
    logger.warn('ODDS_API_KEY not configured, skipping odds fetch');
    return [];
  }

  const oddsApiSport = SPORT_KEY_MAP[sportKey];
  if (!oddsApiSport) {
    logger.debug({ sport: sportKey }, 'Sport not mapped for odds API');
    return [];
  }

  try {
    const url = new URL(`${ODDS_API_BASE}/sports/${oddsApiSport}/odds`);
    url.searchParams.set('apiKey', config.ODDS_API_KEY);
    url.searchParams.set('regions', 'us');
    url.searchParams.set('markets', 'h2h,spreads,totals');
    url.searchParams.set('oddsFormat', 'american');

    const response = await fetch(url.toString());

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Odds API error: ${response.status} - ${text}`);
    }

    const data = await response.json() as OddsApiGame[];
    logger.info({ sport: sportKey, count: data.length }, 'Fetched odds');
    return data;
  } catch (error) {
    logger.error({ error, sport: sportKey }, 'Failed to fetch odds');
    return [];
  }
}

// Update odds for all games in our database
export async function refreshOdds(): Promise<void> {
  if (!config.ODDS_API_KEY) {
    return;
  }

  logger.info('Refreshing odds for all sports');

  // Get all scheduled games
  const games = await prisma.game.findMany({
    where: {
      status: 'SCHEDULED',
      startTime: { gte: new Date() },
    },
  });

  // Group by sport
  const gamesBySport = games.reduce((acc, game) => {
    if (!acc[game.sport]) acc[game.sport] = [];
    acc[game.sport]!.push(game);
    return acc;
  }, {} as Record<string, typeof games>);

  // Fetch odds for each sport that has games
  for (const sport of Object.keys(gamesBySport)) {
    const oddsData = await fetchOddsForSport(sport);

    if (oddsData.length === 0) continue;

    // Match odds to our games
    for (const game of gamesBySport[sport] ?? []) {
      const matchingOdds = findMatchingOdds(game.homeTeam, game.awayTeam, oddsData);

      if (matchingOdds) {
        await updateGameOdds(game.id, matchingOdds);
      }
    }
  }

  logger.info('Odds refresh complete');
}

// Find matching odds data for a game
function findMatchingOdds(
  homeTeam: string,
  awayTeam: string,
  oddsData: OddsApiGame[]
): OddsApiGame | null {
  // Normalize team names for matching
  const normalizeTeam = (name: string) =>
    name.toLowerCase().replace(/[^a-z0-9]/g, '');

  const homeNorm = normalizeTeam(homeTeam);
  const awayNorm = normalizeTeam(awayTeam);

  for (const odds of oddsData) {
    const oddsHomeNorm = normalizeTeam(odds.home_team);
    const oddsAwayNorm = normalizeTeam(odds.away_team);

    // Check if team names match (partial match for flexibility)
    const homeMatch = homeNorm.includes(oddsHomeNorm) || oddsHomeNorm.includes(homeNorm);
    const awayMatch = awayNorm.includes(oddsAwayNorm) || oddsAwayNorm.includes(awayNorm);

    if (homeMatch && awayMatch) {
      return odds;
    }
  }

  return null;
}

// Update a game with odds data
async function updateGameOdds(gameId: string, oddsData: OddsApiGame): Promise<void> {
  // Get the first available bookmaker (prefer DraftKings or FanDuel)
  const preferredBooks = ['draftkings', 'fanduel', 'betmgm', 'caesars'];
  let bookmaker = oddsData.bookmakers.find(b => preferredBooks.includes(b.key));
  if (!bookmaker && oddsData.bookmakers.length > 0) {
    bookmaker = oddsData.bookmakers[0];
  }

  if (!bookmaker) {
    logger.debug({ gameId }, 'No bookmaker data available');
    return;
  }

  // Extract odds from markets
  let homeMoneyline: number | null = null;
  let awayMoneyline: number | null = null;
  let homeSpread: number | null = null;
  let awaySpread: number | null = null;
  let spreadOdds: number | null = null;
  let totalLine: number | null = null;
  let overOdds: number | null = null;
  let underOdds: number | null = null;

  for (const market of bookmaker.markets) {
    if (market.key === 'h2h') {
      // Moneyline
      for (const outcome of market.outcomes) {
        if (outcome.name === oddsData.home_team) {
          homeMoneyline = outcome.price;
        } else if (outcome.name === oddsData.away_team) {
          awayMoneyline = outcome.price;
        }
      }
    } else if (market.key === 'spreads') {
      // Point spread
      for (const outcome of market.outcomes) {
        if (outcome.name === oddsData.home_team) {
          homeSpread = outcome.point ?? null;
          spreadOdds = outcome.price;
        } else if (outcome.name === oddsData.away_team) {
          awaySpread = outcome.point ?? null;
        }
      }
    } else if (market.key === 'totals') {
      // Over/Under
      for (const outcome of market.outcomes) {
        if (outcome.name === 'Over') {
          totalLine = outcome.point ?? null;
          overOdds = outcome.price;
        } else if (outcome.name === 'Under') {
          underOdds = outcome.price;
        }
      }
    }
  }

  await prisma.game.update({
    where: { id: gameId },
    data: {
      homeMoneyline,
      awayMoneyline,
      homeSpread,
      awaySpread,
      spreadOdds,
      totalLine,
      overOdds,
      underOdds,
      oddsUpdatedAt: new Date(),
    },
  });

  logger.debug({ gameId, homeMoneyline, awayMoneyline }, 'Updated game odds');
}

// Format odds for display (American format)
export function formatOdds(odds: number): string {
  if (odds >= 0) {
    return `+${odds}`;
  }
  return odds.toString();
}

// Calculate potential payout from American odds
export function calculatePayout(amount: bigint, odds: number): bigint {
  let profit: bigint;

  if (odds > 0) {
    // Positive odds: profit = (amount * odds) / 100
    profit = (amount * BigInt(odds)) / BigInt(100);
  } else {
    // Negative odds: profit = (amount * 100) / |odds|
    profit = (amount * BigInt(100)) / BigInt(Math.abs(odds));
  }

  return amount + profit;
}

// Get all available sports from the odds API
export async function getAvailableSports(): Promise<string[]> {
  if (!config.ODDS_API_KEY) {
    return [];
  }

  try {
    const url = new URL(`${ODDS_API_BASE}/sports`);
    url.searchParams.set('apiKey', config.ODDS_API_KEY);

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Odds API error: ${response.status}`);
    }

    const sports = await response.json() as Array<{ key: string; title: string; active: boolean }>;
    return sports.filter(s => s.active).map(s => s.key);
  } catch (error) {
    logger.error({ error }, 'Failed to get available sports');
    return [];
  }
}
