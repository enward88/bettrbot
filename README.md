# Bettr

Peer-to-peer and house sports betting on Telegram, powered by Solana.

## What is Bettr?

Bettr is a Telegram bot that lets you bet on sports using SOL cryptocurrency. You can:
- **House Bets**: Bet against the house with real-time odds (moneyline, spread, over/under)
- **P2P Bets**: Bet against friends in your group chat (winners split the pot)

When games end, winnings are paid out automatically to your Solana wallet.

## Supported Sports

- 🏀 NBA, WNBA
- 🏈 NFL
- ⚾ MLB
- 🥊 MMA/UFC

## Quick Start

### For Users

1. **Register**: Send `/start` to [@bettrsportsbot](https://t.me/bettrsportsbot) on Telegram
2. **Set your wallet**: `/wallet YOUR_SOLANA_ADDRESS`
3. **Add to group**: Add the bot to your group chat
4. **View games**: `/games`
5. **Place bets**: Just type naturally!

### Betting Examples

```
bet 1 sol lakers ML
bet 0.5 sol chiefs -3.5
bet 2 sol over 220.5 celtics
1.5 sol dodgers ML
```

## How It Works

### House Bets (with odds)
When a game has odds available, you bet against the house:
1. Pick your bet (moneyline, spread, or total)
2. Send SOL to your unique deposit address
3. If you win, you get paid based on the odds

### P2P Bets (winner-take-all)
When odds aren't available, you bet against friends:
1. Pick a team
2. Friends pick the opposing team
3. Winners split the pot (1% fee)

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Register your account |
| `/games` | View today's games with odds |
| `/bet` | Start a bet (interactive) |
| `/mybets` | View your active bets |
| `/wallet <address>` | Set your Solana payout wallet |
| `/help` | Show help |

## Group Setup Guide

When you add Bettr to a group:

1. **Everyone registers**: Each person taps `/start`
2. **Set wallets**: DM the bot with `/wallet YOUR_ADDRESS`
3. **View games**: `/games` shows today's matchups
4. **Place bets**: Type naturally like "bet 1 sol lakers ML"

## Fees

- **House Bets**: No additional fee (house edge built into odds)
- **P2P Bets**: 1% fee deducted from the pot before payout

## Self-Hosting

### Prerequisites

- Node.js 18+
- PostgreSQL database
- Solana wallet (for treasury)

### Environment Variables

Create a `.env` file:

```env
# Required
TELEGRAM_BOT_TOKEN=your_bot_token
DATABASE_URL=postgresql://user:pass@localhost:5432/bettr
TREASURY_WALLET_ADDRESS=your_treasury_solana_address
ENCRYPTION_KEY=64_character_hex_string

# APIs
BALLDONTLIE_API_KEY=your_api_key
ODDS_API_KEY=your_odds_api_key

# Optional
ADMIN_TELEGRAM_ID=your_telegram_user_id
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_NETWORK=mainnet-beta
LOG_LEVEL=info
```

### Installation

```bash
# Install dependencies
npm install

# Set up database
npx prisma migrate deploy

# Build
npm run build

# Start
npm start
```

### Running with PM2

```bash
pm2 start dist/index.js --name bettrbot
pm2 save
```

## Security

- Wallet private keys encrypted at rest using AES-256-GCM
- Each bet uses a unique deposit wallet
- Funds held temporarily until game settlement
- No user private keys stored

## Admin Commands

If you're the admin (set via `ADMIN_TELEGRAM_ID`):

| Command | Description |
|---------|-------------|
| `/admin` | Show admin menu |
| `/admin bets` | View all active bets |
| `/admin pending` | View unsettled games |
| `/admin settle <id> <WIN\|LOSS\|PUSH>` | Manual settlement |
| `/admin exposure` | View house exposure |
| `/admin stats` | Betting statistics |

## License

This software is proprietary and confidential. All rights reserved.
Unauthorized copying, forking, modification, or distribution is prohibited.
