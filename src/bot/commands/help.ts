import { type BotContext } from '../bot.js';

export async function helpCommand(ctx: BotContext) {
  const helpMessage = `Bettr - P2P Sports Betting

How it works:
1. Use /games to see today's matchups
2. Pick a game and choose your team
3. Send SOL to the generated wallet
4. Others join and bet on the opposing team
5. When the game ends, winners get paid automatically

Commands:
/start - Register your account
/games - View today's games
/bet - Start or join a bet
/mybets - View your active bets
/wallet <address> - Set your payout wallet
/help - Show this help message

Supported Sports:
• NBA
• NFL
• College Football
• NHL
• MMA/UFC

Fees:
A 1% fee is taken from the pot on settled bets.

Tips:
• Set your payout wallet before betting
• Bets lock when the game starts
• Minimum bet: 0.01 SOL`;

  await ctx.reply(helpMessage);
}
