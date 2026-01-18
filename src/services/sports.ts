import { config } from '../utils/config.js';
import { type Sport } from '../utils/constants.js';
import { createChildLogger } from '../utils/logger.js';
import { prisma } from '../db/prisma.js';

const logger = createChildLogger('sports');

const API_BASE_URL = 'https://api.balldontlie.io';

// NBA game structure
interface NBAGame {
  id: number;
  date: string;
  datetime: string;
  status: string;
  period: number;
  home_team: {
    id: number;
    name: string;
    full_name: string;
    abbreviation: string;
  };
  visitor_team: {
    id: number;
    name: string;
    full_name: string;
    abbreviation: string;
  };
  home_team_score: number;
  visitor_team_score: number;
}

// NFL game structure
interface NFLGame {
  id: number;
  date: string;
  status: string;
  week: number;
  season: number;
  postseason: boolean;
  home_team: {
    id: number;
    name: string;
    full_name: string;
    abbreviation: string;
  };
  visitor_team: {
    id: number;
    name: string;
    full_name: string;
    abbreviation: string;
  };
  home_team_score: number | null;
  visitor_team_score: number | null;
}

// MMA event structure
interface MMAEvent {
  id: number;
  name: string;
  short_name: string;
  date: string;
  status: string;
  venue_name: string | null;
  venue_city: string | null;
  league?: {
    name: string;
    abbreviation: string;
  };
}

interface ApiResponse<T> {
  data: T[];
  meta?: {
    next_cursor?: number;
    per_page?: number;
  };
}

// Sports available on free tier with their endpoints
const SPORT_CONFIG: Partial<Record<Sport, { endpoint: string; available: boolean }>> = {
  NBA: { endpoint: '/v1/games', available: true },
  NFL: { endpoint: '/nfl/v1/games', available: true },
  NHL: { endpoint: '/nhl/v1/games', available: false }, // Requires paid
  NCAAF: { endpoint: '/ncaaf/v1/games', available: false }, // Requires paid
  MMA: { endpoint: '/mma/v1/events', available: true },
};

async function fetchFromApi<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${API_BASE_URL}${endpoint}`);
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.append(key, value);
  });

  logger.debug({ url: url.toString() }, 'Fetching from API');

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: config.BALLDONTLIE_API_KEY,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error: ${response.status} ${response.statusText} - ${text}`);
  }

  return response.json() as Promise<T>;
}

// Fetch NBA games for a date
async function fetchNBAGames(date: Date): Promise<void> {
  const dateStr = date.toISOString().split('T')[0] ?? '';

  try {
    const response = await fetchFromApi<ApiResponse<NBAGame>>('/v1/games', {
      'dates[]': dateStr,
    });

    for (const game of response.data) {
      const externalId = `NBA-${game.id}`;
      const startTime = new Date(game.datetime);

      await prisma.game.upsert({
        where: { externalId },
        update: {
          homeScore: game.home_team_score,
          awayScore: game.visitor_team_score,
          status: mapNBAStatus(game.status, game.period),
          winner: determineWinner(game.home_team_score, game.visitor_team_score, game.status),
        },
        create: {
          externalId,
          sport: 'NBA',
          homeTeam: game.home_team.full_name,
          awayTeam: game.visitor_team.full_name,
          startTime,
          homeScore: game.home_team_score,
          awayScore: game.visitor_team_score,
          status: mapNBAStatus(game.status, game.period),
        },
      });
    }

    logger.info({ sport: 'NBA', count: response.data.length }, 'Updated games');
  } catch (error) {
    logger.error({ error, sport: 'NBA', date: dateStr }, 'Failed to fetch NBA games');
  }
}

// Fetch NFL games for a date
async function fetchNFLGames(date: Date): Promise<void> {
  const dateStr = date.toISOString().split('T')[0] ?? '';

  try {
    const response = await fetchFromApi<ApiResponse<NFLGame>>('/nfl/v1/games', {
      'dates[]': dateStr,
    });

    for (const game of response.data) {
      const externalId = `NFL-${game.id}`;
      const startTime = new Date(game.date);

      await prisma.game.upsert({
        where: { externalId },
        update: {
          homeScore: game.home_team_score,
          awayScore: game.visitor_team_score,
          status: mapNFLStatus(game.status),
          winner: determineWinner(game.home_team_score, game.visitor_team_score, game.status),
        },
        create: {
          externalId,
          sport: 'NFL',
          homeTeam: game.home_team.full_name,
          awayTeam: game.visitor_team.full_name,
          startTime,
          homeScore: game.home_team_score,
          awayScore: game.visitor_team_score,
          status: mapNFLStatus(game.status),
        },
      });
    }

    logger.info({ sport: 'NFL', count: response.data.length }, 'Updated games');
  } catch (error) {
    logger.error({ error, sport: 'NFL', date: dateStr }, 'Failed to fetch NFL games');
  }
}

// Fetch MMA events (upcoming)
async function fetchMMAEvents(): Promise<void> {
  try {
    const response = await fetchFromApi<ApiResponse<MMAEvent>>('/mma/v1/events');

    // Filter to upcoming UFC events only
    const upcomingEvents = response.data.filter(
      (event) =>
        event.status === 'scheduled' &&
        event.league?.abbreviation === 'UFC' &&
        new Date(event.date) > new Date()
    );

    for (const event of upcomingEvents.slice(0, 10)) {
      const externalId = `MMA-${event.id}`;
      const startTime = new Date(event.date);

      // For MMA, we use the event name as both home and away (it's not team vs team)
      await prisma.game.upsert({
        where: { externalId },
        update: {
          status: mapMMAStatus(event.status),
        },
        create: {
          externalId,
          sport: 'MMA',
          homeTeam: event.short_name || event.name,
          awayTeam: 'UFC Event',
          startTime,
          status: mapMMAStatus(event.status),
        },
      });
    }

    logger.info({ sport: 'MMA', count: upcomingEvents.length }, 'Updated events');
  } catch (error) {
    logger.error({ error, sport: 'MMA' }, 'Failed to fetch MMA events');
  }
}

// Map NBA status
function mapNBAStatus(
  status: string,
  period: number
): 'SCHEDULED' | 'LIVE' | 'FINAL' | 'CANCELLED' | 'POSTPONED' {
  if (status.toLowerCase().includes('final')) {
    return 'FINAL';
  }
  if (period > 0) {
    return 'LIVE';
  }
  if (status.toLowerCase().includes('postpone')) {
    return 'POSTPONED';
  }
  if (status.toLowerCase().includes('cancel')) {
    return 'CANCELLED';
  }
  return 'SCHEDULED';
}

// Map NFL status
function mapNFLStatus(
  status: string
): 'SCHEDULED' | 'LIVE' | 'FINAL' | 'CANCELLED' | 'POSTPONED' {
  const s = status.toLowerCase();
  if (s.includes('final')) {
    return 'FINAL';
  }
  if (s.includes('1st') || s.includes('2nd') || s.includes('3rd') || s.includes('4th') || s.includes('ot') || s.includes('half')) {
    return 'LIVE';
  }
  if (s.includes('postpone')) {
    return 'POSTPONED';
  }
  if (s.includes('cancel')) {
    return 'CANCELLED';
  }
  return 'SCHEDULED';
}

// Map MMA status
function mapMMAStatus(
  status: string
): 'SCHEDULED' | 'LIVE' | 'FINAL' | 'CANCELLED' | 'POSTPONED' {
  const s = status.toLowerCase();
  if (s === 'completed') {
    return 'FINAL';
  }
  if (s === 'live' || s === 'in progress') {
    return 'LIVE';
  }
  if (s.includes('cancel')) {
    return 'CANCELLED';
  }
  if (s.includes('postpone')) {
    return 'POSTPONED';
  }
  return 'SCHEDULED';
}

// Determine winner from scores
function determineWinner(
  homeScore: number | null,
  awayScore: number | null,
  status: string
): 'home' | 'away' | null {
  // Only determine winner for final games
  if (!status.toLowerCase().includes('final')) {
    return null;
  }
  if (homeScore === null || awayScore === null) {
    return null;
  }
  if (homeScore > awayScore) {
    return 'home';
  }
  if (awayScore > homeScore) {
    return 'away';
  }
  return null;
}

// Refresh all games for today
export async function refreshTodaysGames(): Promise<void> {
  const today = new Date();
  logger.info({ date: today.toISOString() }, 'Refreshing games');

  // Fetch in parallel
  await Promise.all([
    fetchNBAGames(today),
    fetchNFLGames(today),
    fetchMMAEvents(),
  ]);

  logger.info('Game refresh complete');
}

// Check for game results and update database
export async function checkGameResults(): Promise<void> {
  // Find games that are scheduled or live and have active rounds
  const gamesWithBets = await prisma.game.findMany({
    where: {
      status: {
        in: ['SCHEDULED', 'LIVE'],
      },
      rounds: {
        some: {
          status: {
            in: ['OPEN', 'LOCKED'],
          },
        },
      },
    },
  });

  if (gamesWithBets.length === 0) {
    return;
  }

  logger.info({ count: gamesWithBets.length }, 'Checking game results');

  // Re-fetch today's games to get updated scores
  await refreshTodaysGames();
}

// Legacy export for compatibility
export async function fetchGamesForSport(sport: Sport, date: Date): Promise<never[]> {
  logger.warn({ sport }, 'fetchGamesForSport is deprecated, use refreshTodaysGames instead');
  return [];
}
