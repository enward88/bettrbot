import { type BotContext } from '../bot.js';
import { prisma } from '../../db/prisma.js';
import { findGameByTeamName } from '../../services/sports.js';
import { createHouseBet, hasOddsForBetType } from '../../services/houseBet.js';
import { formatOdds, calculatePayout } from '../../services/odds.js';
import { createRoundWallet } from '../../services/wallet.js';
import { createChildLogger } from '../../utils/logger.js';
import { LAMPORTS_PER_SOL, MIN_BET_SOL, SPORT_EMOJIS, type Sport } from '../../utils/constants.js';
import { config } from '../../utils/config.js';
import type { BetType } from '@prisma/client';

const logger = createChildLogger('conversational');

// Common team name aliases
const TEAM_ALIASES: Record<string, string> = {
  // MLB
  dodgers: 'Los Angeles Dodgers',
  yankees: 'New York Yankees',
  redsox: 'Boston Red Sox',
  cubs: 'Chicago Cubs',
  mets: 'New York Mets',
  giants: 'San Francisco Giants',
  astros: 'Houston Astros',
  braves: 'Atlanta Braves',
  // NFL
  chiefs: 'Kansas City Chiefs',
  eagles: 'Philadelphia Eagles',
  cowboys: 'Dallas Cowboys',
  niners: '49ers',
  bills: 'Buffalo Bills',
  ravens: 'Baltimore Ravens',
  packers: 'Green Bay Packers',
  // NBA
  lakers: 'Los Angeles Lakers',
  celtics: 'Boston Celtics',
  warriors: 'Golden State Warriors',
  nets: 'Brooklyn Nets',
  heat: 'Miami Heat',
  bucks: 'Milwaukee Bucks',
  suns: 'Phoenix Suns',
  // NHL
  bruins: 'Boston Bruins',
  leafs: 'Toronto Maple Leafs',
  oilers: 'Edmonton Oilers',
  knights: 'Vegas Golden Knights',
  avs: 'Colorado Avalanche',
};

// Bet type patterns
const BET_TYPE_PATTERNS = {
  MONEYLINE: /\b(ml|moneyline|money line|win|to win)\b/i,
  SPREAD: /\b(spread|pts?|points?)\s*([+-]?\d+\.?\d*)?/i,
  TOTAL_OVER: /\b(over|o)\s*(\d+\.?\d*)/i,
  TOTAL_UNDER: /\b(under|u)\s*(\d+\.?\d*)/i,
};

// Parse conversational bet message
// Examples:
// "@bot 1 sol dodgers ML"
// "@bot 0.5 sol chiefs -3.5"
// "@bot 2 sol over 45.5 patriots game"
interface ParsedBet {
  amount: number;
  teamSearch: string;
  betType: BetType;
  line?: number;
}

function parseBetMessage(text: string): ParsedBet | null {
  // Remove @mention if present
  const cleanText = text.replace(/@\w+/g, '').trim().toLowerCase();

  // Extract amount (look for number followed by "sol")
  const amountMatch = cleanText.match(/(\d+\.?\d*)\s*sol/i);
  if (!amountMatch) {
    return null;
  }
  const amount = parseFloat(amountMatch[1] ?? '0');
  if (isNaN(amount) || amount <= 0) {
    return null;
  }

  // Determine bet type
  let betType: BetType = 'MONEYLINE';
  let line: number | undefined;

  // Check for over/under first (they're more specific)
  const overMatch = cleanText.match(BET_TYPE_PATTERNS.TOTAL_OVER);
  const underMatch = cleanText.match(BET_TYPE_PATTERNS.TOTAL_UNDER);
  const spreadMatch = cleanText.match(BET_TYPE_PATTERNS.SPREAD);

  if (overMatch && overMatch[2]) {
    betType = 'TOTAL_OVER';
    line = parseFloat(overMatch[2]);
  } else if (underMatch && underMatch[2]) {
    betType = 'TOTAL_UNDER';
    line = parseFloat(underMatch[2]);
  } else if (spreadMatch && spreadMatch[2]) {
    betType = 'SPREAD';
    line = parseFloat(spreadMatch[2]);
  }
  // Otherwise default to MONEYLINE

  // Extract team name - remove known patterns and amount
  let teamSearch = cleanText
    .replace(/(\d+\.?\d*)\s*sol/i, '')
    .replace(BET_TYPE_PATTERNS.MONEYLINE, '')
    .replace(BET_TYPE_PATTERNS.SPREAD, '')
    .replace(BET_TYPE_PATTERNS.TOTAL_OVER, '')
    .replace(BET_TYPE_PATTERNS.TOTAL_UNDER, '')
    .replace(/\bgame\b/i, '')
    .trim();

  // Check for aliases
  const words = teamSearch.split(/\s+/);
  for (const word of words) {
    if (TEAM_ALIASES[word]) {
      teamSearch = TEAM_ALIASES[word];
      break;
    }
  }

  // If no team found, can't proceed
  if (!teamSearch || teamSearch.length < 2) {
    return null;
  }

  return {
    amount,
    teamSearch,
    betType,
    line,
  };
}

// Handle conversational bet mentions
export async function handleConversationalBet(ctx: BotContext): Promise<void> {
  const message = ctx.message;
  if (!message?.text) return;

  const text = message.text;

  // Check if this is a mention of our bot
  const botUsername = ctx.me?.username;
  if (!botUsername) return;

  // Check for @mention of bot
  const mentionRegex = new RegExp(`@${botUsername}`, 'i');
  if (!mentionRegex.test(text)) {
    return;
  }

  logger.debug({ text, from: message.from?.username }, 'Processing conversational bet');

  // Parse the bet
  const parsed = parseBetMessage(text);
  if (!parsed) {
    await ctx.reply(
      'I couldn\'t understand that bet. Try:\n' +
        `@${botUsername} 1 sol [team] ML\n` +
        `@${botUsername} 0.5 sol [team] -3.5\n` +
        `@${botUsername} 2 sol over 45.5 [team] game`,
      { reply_to_message_id: message.message_id }
    );
    return;
  }

  // Validate amount
  if (parsed.amount < MIN_BET_SOL) {
    await ctx.reply(
      `Minimum bet is ${MIN_BET_SOL} SOL.`,
      { reply_to_message_id: message.message_id }
    );
    return;
  }

  // Find the game
  const game = await findGameByTeamName(parsed.teamSearch);
  if (!game) {
    await ctx.reply(
      `Couldn't find an upcoming game matching "${parsed.teamSearch}".\n` +
        'Make sure the team has a scheduled game today.',
      { reply_to_message_id: message.message_id }
    );
    return;
  }

  // Determine which team was picked
  const homeNorm = game.homeTeam.toLowerCase();
  const awayNorm = game.awayTeam.toLowerCase();
  const searchNorm = parsed.teamSearch.toLowerCase();

  let pick: 'home' | 'away';
  if (homeNorm.includes(searchNorm) || searchNorm.includes(homeNorm.split(' ').pop() ?? '')) {
    pick = 'home';
  } else if (awayNorm.includes(searchNorm) || searchNorm.includes(awayNorm.split(' ').pop() ?? '')) {
    pick = 'away';
  } else {
    // Default to whichever matches better
    pick = 'home';
  }

  // Adjust pick for totals (over/under don't need a team, but we still need a game)
  if (parsed.betType === 'TOTAL_OVER' || parsed.betType === 'TOTAL_UNDER') {
    pick = parsed.betType === 'TOTAL_OVER' ? 'home' : 'away'; // Arbitrary for totals
  }

  // Get full game data with odds
  const fullGame = await prisma.game.findUnique({
    where: { id: game.id },
  });

  if (!fullGame) {
    await ctx.reply(
      'Game not found in database.',
      { reply_to_message_id: message.message_id }
    );
    return;
  }

  // Check if user exists
  const fromId = message.from?.id;
  if (!fromId) return;

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(fromId) },
  });

  if (!user) {
    await ctx.reply(
      'You need to register first! Send /start to get started.',
      { reply_to_message_id: message.message_id }
    );
    return;
  }

  const amountLamports = BigInt(Math.floor(parsed.amount * LAMPORTS_PER_SOL));
  const emoji = SPORT_EMOJIS[fullGame.sport as Sport] || '🎯';

  // Check if odds are available for this bet type
  if (hasOddsForBetType(fullGame, parsed.betType)) {
    // Place house bet (bet against treasury with odds)
    const houseBet = await createHouseBet({
      gameId: game.id,
      userId: user.id,
      chatId: BigInt(message.chat.id),
      betType: parsed.betType,
      pick,
      amount: amountLamports,
    });

    if (!houseBet) {
      await ctx.reply(
        'Odds not available for this bet type on this game.',
        { reply_to_message_id: message.message_id }
      );
      return;
    }

    const potentialWinSol = Number(houseBet.potentialWin) / LAMPORTS_PER_SOL;
    const team = pick === 'home' ? fullGame.homeTeam : fullGame.awayTeam;

    let betDescription: string;
    switch (parsed.betType) {
      case 'MONEYLINE':
        betDescription = `${team} ML`;
        break;
      case 'SPREAD':
        betDescription = `${team} ${houseBet.line !== null && houseBet.line >= 0 ? '+' : ''}${houseBet.line}`;
        break;
      case 'TOTAL_OVER':
        betDescription = `Over ${houseBet.line}`;
        break;
      case 'TOTAL_UNDER':
        betDescription = `Under ${houseBet.line}`;
        break;
      default:
        betDescription = `${team}`;
    }

    await ctx.reply(
      `${emoji} House Bet Created!\n\n` +
        `${fullGame.awayTeam} @ ${fullGame.homeTeam}\n\n` +
        `Your pick: ${betDescription} (${formatOdds(houseBet.odds)})\n` +
        `Amount: ${parsed.amount} SOL\n` +
        `Potential win: ${potentialWinSol.toFixed(4)} SOL\n\n` +
        `Send ${parsed.amount} SOL to:\n` +
        `\`${houseBet.depositAddress}\`\n\n` +
        `Bet ID: ${houseBet.id.slice(0, 8)}`,
      {
        reply_to_message_id: message.message_id,
        parse_mode: 'Markdown',
      }
    );
  } else {
    // Fall back to P2P bet (no odds available)
    // Find or create round for this game in this chat
    let round = await prisma.round.findFirst({
      where: {
        gameId: game.id,
        chatId: BigInt(message.chat.id),
        status: 'OPEN',
      },
    });

    if (!round) {
      const { address, encryptedSecretKey } = await createRoundWallet();
      round = await prisma.round.create({
        data: {
          gameId: game.id,
          chatId: BigInt(message.chat.id),
          walletAddress: address,
          walletSecretKey: encryptedSecretKey,
          status: 'OPEN',
          expiresAt: fullGame.startTime,
        },
      });
    }

    // Create the wager
    await prisma.wager.create({
      data: {
        roundId: round.id,
        userId: user.id,
        teamPick: pick,
        amount: amountLamports,
      },
    });

    const team = pick === 'home' ? fullGame.homeTeam : fullGame.awayTeam;

    await ctx.reply(
      `${emoji} P2P Bet Created!\n\n` +
        `${fullGame.awayTeam} @ ${fullGame.homeTeam}\n\n` +
        `Your pick: ${team}\n` +
        `Amount: ${parsed.amount} SOL\n\n` +
        `Send ${parsed.amount} SOL to:\n` +
        `\`${round.walletAddress}\`\n\n` +
        `Others can join by betting on the opposing team!`,
      {
        reply_to_message_id: message.message_id,
        parse_mode: 'Markdown',
      }
    );
  }

  logger.info(
    {
      user: message.from?.username,
      amount: parsed.amount,
      team: parsed.teamSearch,
      betType: parsed.betType,
      gameId: game.id,
    },
    'Conversational bet placed'
  );
}

// Check if a message is a potential bet mention
export function isBetMention(text: string, botUsername: string): boolean {
  const mentionRegex = new RegExp(`@${botUsername}`, 'i');
  if (!mentionRegex.test(text)) {
    return false;
  }

  // Check if it contains "sol" (currency)
  if (!/\bsol\b/i.test(text)) {
    return false;
  }

  return true;
}
