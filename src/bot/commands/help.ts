import { type BotContext } from '../bot.js';

export async function helpCommand(ctx: BotContext) {
  const botUsername = ctx.me?.username ?? 'bettrbot';

  const helpMessage = `Bettr - Sports Betting

How it works:
P2P Betting: Bet against others in your group
House Betting: Bet against the house at posted odds

Commands:
/start - Register your account
/games - View today's games with odds
/bet - Start or join a P2P bet
/challenge @user <amount> - Challenge someone 1v1
/mybets - View your active bets
/pot - View current pot in this chat
/wallet <address> - Set your payout wallet
/help - Show this help message

Conversational Betting:
Just @ me with your bet!
@${botUsername} 1 sol Lakers ML
@${botUsername} 0.5 sol Chiefs -3.5
@${botUsername} 2 sol over 45.5 Patriots game

Supported Sports:
NBA, NFL, NHL, MLB, WNBA
College Football & Basketball
MMA/UFC
Soccer (EPL, MLS, La Liga, Serie A, Bundesliga, Ligue 1, UCL)
Esports (CS2, LoL, Dota 2)

Fees:
1% fee on P2P bet settlements.
House bets pay at posted odds.

Tips:
• Set your payout wallet before betting
• Bets lock when the game starts
• Minimum bet: 0.01 SOL`;

  await ctx.reply(helpMessage);
}
