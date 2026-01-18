import { config } from '../utils/config.js';
import { type Sport, SUPPORTED_SPORTS } from '../utils/constants.js';
import { createChildLogger } from '../utils/logger.js';
import { prisma } from '../db/prisma.js';
import { refreshOdds } from './odds.js';

const logger = createChildLogger('sports');

const API_BASE_URL = 'https://api.balldontlie.io';

// API response wrapper
interface ApiResponse<T> {
  data: T[];
  meta?: {
    next_cursor?: number;
    per_page?: number;
  };
}

// Generic game structure from BALLDONTLIE
interface BaseGame {
  id: number;
  date: string;
  datetime?: string;
  status: string;
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
  period?: number;
}

// MMA specific
interface MMAEvent {
  id: number;
  name: string;
  short_name: string;
  date: string;
  status: string;
  venue_name: string | null;
  league?: { name: string; abbreviation: string };
}

interface MMAFight {
  id: number;
  event_id: number;
  fighter1: { name: string };
  fighter2: { name: string };
  winner_id: number | null;
  status: string;
  scheduled_rounds: number;
}

// Soccer match
interface SoccerMatch {
  id: number;
  date: string;
  datetime: string;
  status: string;
  home_team: { id: number; name: string; short_name: string };
  away_team: { id: number; name: string; short_name: string };
  home_score: number | null;
  away_score: number | null;
  league: { name: string; abbreviation: string };
}

// Sport configuration - endpoints and availability
const SPORT_CONFIG: Record<Sport, { endpoint: string; type: 'game' | 'event' | 'match' | 'esport' }> = {
  NBA: { endpoint: '/v1/games', type: 'game' },
  NFL: { endpoint: '/nfl/v1/games', type: 'game' },
  NHL: { endpoint: '/nhl/v1/games', type: 'game' },
  MLB: { endpoint: '/mlb/v1/games', type: 'game' },
  WNBA: { endpoint: '/wnba/v1/games', type: 'game' },
  NCAAF: { endpoint: '/ncaaf/v1/games', type: 'game' },
  NCAAB: { endpoint: '/ncaab/v1/games', type: 'game' },
  MMA: { endpoint: '/mma/v1/events', type: 'event' },
  EPL: { endpoint: '/epl/v1/matches', type: 'match' },
  MLS: { endpoint: '/mls/v1/matches', type: 'match' },
  LALIGA: { endpoint: '/laliga/v1/matches', type: 'match' },
  SERIEA: { endpoint: '/seriea/v1/matches', type: 'match' },
  BUNDESLIGA: { endpoint: '/bundesliga/v1/matches', type: 'match' },
  LIGUE1: { endpoint: '/ligue1/v1/matches', type: 'match' },
  UCL: { endpoint: '/ucl/v1/matches', type: 'match' },
  CS2: { endpoint: '/cs2/v1/matches', type: 'esport' },
  LOL: { endpoint: '/lol/v1/matches', type: 'esport' },
  DOTA2: { endpoint: '/dota2/v1/matches', type: 'esport' },
};

// Fetch from BALLDONTLIE API
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

// Fetch games for traditional sports (NBA, NFL, NHL, MLB, etc.)
async function fetchTraditionalGames(sport: Sport, date: Date): Promise<void> {
  const cfg = SPORT_CONFIG[sport];
  if (!cfg || cfg.type !== 'game') return;

  const dateStr = date.toISOString().split('T')[0] ?? '';

  try {
    const response = await fetchFromApi<ApiResponse<BaseGame>>(cfg.endpoint, {
      'dates[]': dateStr,
    });

    for (const game of response.data) {
      const externalId = `${sport}-${game.id}`;
      const startTime = new Date(game.datetime ?? game.date);

      await prisma.game.upsert({
        where: { externalId },
        update: {
          homeScore: game.home_team_score,
          awayScore: game.visitor_team_score,
          status: mapGameStatus(game.status, game.period),
          winner: determineWinner(game.home_team_score, game.visitor_team_score, game.status),
        },
        create: {
          externalId,
          sport,
          homeTeam: game.home_team.full_name || game.home_team.name,
          awayTeam: game.visitor_team.full_name || game.visitor_team.name,
          startTime,
          homeScore: game.home_team_score,
          awayScore: game.visitor_team_score,
          status: mapGameStatus(game.status, game.period),
        },
      });
    }

    logger.info({ sport, count: response.data.length, date: dateStr }, 'Updated games');
  } catch (error) {
    logger.error({ error, sport, date: dateStr }, 'Failed to fetch games');
  }
}

// Fetch soccer matches
async function fetchSoccerMatches(sport: Sport, date: Date): Promise<void> {
  const cfg = SPORT_CONFIG[sport];
  if (!cfg || cfg.type !== 'match') return;

  const dateStr = date.toISOString().split('T')[0] ?? '';

  try {
    const response = await fetchFromApi<ApiResponse<SoccerMatch>>(cfg.endpoint, {
      'dates[]': dateStr,
    });

    for (const match of response.data) {
      const externalId = `${sport}-${match.id}`;
      const startTime = new Date(match.datetime);

      await prisma.game.upsert({
        where: { externalId },
        update: {
          homeScore: match.home_score,
          awayScore: match.away_score,
          status: mapSoccerStatus(match.status),
          winner: determineSoccerWinner(match.home_score, match.away_score, match.status),
        },
        create: {
          externalId,
          sport,
          homeTeam: match.home_team.name,
          awayTeam: match.away_team.name,
          startTime,
          homeScore: match.home_score,
          awayScore: match.away_score,
          status: mapSoccerStatus(match.status),
        },
      });
    }

    logger.info({ sport, count: response.data.length, date: dateStr }, 'Updated matches');
  } catch (error) {
    logger.error({ error, sport, date: dateStr }, 'Failed to fetch matches');
  }
}

// Fetch MMA events and fights
async function fetchMMAEvents(): Promise<void> {
  try {
    // Fetch upcoming events
    const eventsResponse = await fetchFromApi<ApiResponse<MMAEvent>>('/mma/v1/events');

    // Filter to upcoming events
    const upcomingEvents = eventsResponse.data.filter(
      event => event.status === 'scheduled' && new Date(event.date) > new Date()
    );

    // For each event, fetch fights
    for (const event of upcomingEvents.slice(0, 5)) {
      try {
        const fightsResponse = await fetchFromApi<ApiResponse<MMAFight>>(
          `/mma/v1/events/${event.id}/fights`
        );

        // Create a game entry for each main card fight
        for (const fight of fightsResponse.data.slice(0, 5)) {
          const externalId = `MMA-${fight.id}`;
          const startTime = new Date(event.date);

          await prisma.game.upsert({
            where: { externalId },
            update: {
              status: mapMMAStatus(fight.status),
              winner: fight.winner_id ? 'home' : null, // Simplified
            },
            create: {
              externalId,
              sport: 'MMA',
              homeTeam: fight.fighter1.name,
              awayTeam: fight.fighter2.name,
              startTime,
              status: mapMMAStatus(fight.status),
            },
          });
        }

        logger.info({ eventId: event.id, fights: fightsResponse.data.length }, 'Updated MMA fights');
      } catch (fightError) {
        logger.error({ error: fightError, eventId: event.id }, 'Failed to fetch MMA fights');
      }
    }

    logger.info({ events: upcomingEvents.length }, 'Updated MMA events');
  } catch (error) {
    logger.error({ error }, 'Failed to fetch MMA events');
  }
}

// Fetch esports matches
async function fetchEsportsMatches(sport: Sport): Promise<void> {
  const cfg = SPORT_CONFIG[sport];
  if (!cfg || cfg.type !== 'esport') return;

  try {
    const response = await fetchFromApi<ApiResponse<SoccerMatch>>(cfg.endpoint);

    // Filter to upcoming matches
    const upcoming = response.data.filter(
      match => new Date(match.datetime) > new Date()
    );

    for (const match of upcoming.slice(0, 10)) {
      const externalId = `${sport}-${match.id}`;
      const startTime = new Date(match.datetime);

      await prisma.game.upsert({
        where: { externalId },
        update: {
          homeScore: match.home_score,
          awayScore: match.away_score,
          status: mapGameStatus(match.status),
        },
        create: {
          externalId,
          sport,
          homeTeam: match.home_team.name,
          awayTeam: match.away_team.name,
          startTime,
          homeScore: match.home_score,
          awayScore: match.away_score,
          status: mapGameStatus(match.status),
        },
      });
    }

    logger.info({ sport, count: upcoming.length }, 'Updated esports matches');
  } catch (error) {
    logger.error({ error, sport }, 'Failed to fetch esports matches');
  }
}

// Map game status to our enum
function mapGameStatus(
  status: string,
  period?: number
): 'SCHEDULED' | 'LIVE' | 'FINAL' | 'CANCELLED' | 'POSTPONED' {
  const s = status.toLowerCase();
  if (s.includes('final')) return 'FINAL';
  if (s.includes('live') || s.includes('progress') || (period && period > 0)) return 'LIVE';
  if (s.includes('postpone')) return 'POSTPONED';
  if (s.includes('cancel')) return 'CANCELLED';
  return 'SCHEDULED';
}

// Map soccer status
function mapSoccerStatus(status: string): 'SCHEDULED' | 'LIVE' | 'FINAL' | 'CANCELLED' | 'POSTPONED' {
  const s = status.toLowerCase();
  if (s === 'ft' || s === 'aet' || s === 'pen' || s.includes('finish')) return 'FINAL';
  if (s === 'ht' || s.includes('1h') || s.includes('2h') || s.includes('live')) return 'LIVE';
  if (s.includes('postpone')) return 'POSTPONED';
  if (s.includes('cancel')) return 'CANCELLED';
  return 'SCHEDULED';
}

// Map MMA status
function mapMMAStatus(status: string): 'SCHEDULED' | 'LIVE' | 'FINAL' | 'CANCELLED' | 'POSTPONED' {
  const s = status.toLowerCase();
  if (s === 'completed' || s === 'finished') return 'FINAL';
  if (s === 'live' || s === 'in progress') return 'LIVE';
  if (s.includes('cancel')) return 'CANCELLED';
  return 'SCHEDULED';
}

// Determine winner from scores
function determineWinner(
  homeScore: number | null,
  awayScore: number | null,
  status: string
): 'home' | 'away' | null {
  if (!status.toLowerCase().includes('final')) return null;
  if (homeScore === null || awayScore === null) return null;
  if (homeScore > awayScore) return 'home';
  if (awayScore > homeScore) return 'away';
  return null;
}

// Determine soccer winner (can be draw)
function determineSoccerWinner(
  homeScore: number | null,
  awayScore: number | null,
  status: string
): 'home' | 'away' | null {
  const s = status.toLowerCase();
  if (s !== 'ft' && s !== 'aet' && s !== 'pen') return null;
  if (homeScore === null || awayScore === null) return null;
  if (homeScore > awayScore) return 'home';
  if (awayScore > homeScore) return 'away';
  return null; // Draw
}

// Refresh all games for today
export async function refreshTodaysGames(): Promise<void> {
  const today = new Date();
  logger.info({ date: today.toISOString() }, 'Refreshing games for all sports');

  // Only fetch sports available on current BALLDONTLIE API tier
  // NBA and NFL are on the free/basic tier
  // Add more sports here when you upgrade your API tier
  const availableSports: Sport[] = ['NBA', 'NFL'];

  // Fetch all in parallel with error handling for each
  const fetches = [
    ...availableSports.map(sport =>
      fetchTraditionalGames(sport, today).catch(e =>
        logger.error({ error: e, sport }, 'Failed to fetch')
      )
    ),
    fetchMMAEvents().catch(e => logger.error({ error: e }, 'Failed to fetch MMA')),
  ];

  await Promise.all(fetches);

  // Also refresh odds
  await refreshOdds().catch(e => logger.error({ error: e }, 'Failed to refresh odds'));

  logger.info('Game refresh complete');
}

// Check for game results and update database
export async function checkGameResults(): Promise<void> {
  const gamesWithBets = await prisma.game.findMany({
    where: {
      status: { in: ['SCHEDULED', 'LIVE'] },
      rounds: { some: { status: { in: ['OPEN', 'LOCKED'] } } },
    },
  });

  if (gamesWithBets.length === 0) return;

  logger.info({ count: gamesWithBets.length }, 'Checking game results');
  await refreshTodaysGames();
}

// Search for a team/game by name (for conversational betting)
export async function findGameByTeamName(
  teamName: string,
  sport?: Sport
): Promise<{ id: string; homeTeam: string; awayTeam: string; sport: Sport; startTime: Date; homeMoneyline: number | null; awayMoneyline: number | null } | null> {
  const normalizedSearch = teamName.toLowerCase().replace(/[^a-z0-9]/g, '');

  const where: Record<string, unknown> = {
    status: 'SCHEDULED',
    startTime: { gte: new Date() },
  };

  if (sport) {
    where.sport = sport;
  }

  const games = await prisma.game.findMany({
    where,
    orderBy: { startTime: 'asc' },
    take: 50,
  });

  for (const game of games) {
    const homeNorm = game.homeTeam.toLowerCase().replace(/[^a-z0-9]/g, '');
    const awayNorm = game.awayTeam.toLowerCase().replace(/[^a-z0-9]/g, '');

    if (homeNorm.includes(normalizedSearch) || awayNorm.includes(normalizedSearch)) {
      return {
        id: game.id,
        homeTeam: game.homeTeam,
        awayTeam: game.awayTeam,
        sport: game.sport as Sport,
        startTime: game.startTime,
        homeMoneyline: game.homeMoneyline,
        awayMoneyline: game.awayMoneyline,
      };
    }
  }

  return null;
}
