# Bettr

Peer-to-peer sports betting on Telegram, powered by Solana.

## What is Bettr?

Bettr is a Telegram bot that lets friends bet against each other on sports games using SOL cryptocurrency. Add the bot to your group chat, pick a game, choose your team, and send your wager to a unique wallet. When the game ends, winners get paid automatically.

## Supported Sports

- 🏀 NBA
- 🏈 NFL
- 🏈 College Football (NCAAF)
- 🏒 NHL
- 🥊 MMA/UFC

## How It Works

1. **Add Bettr to your group chat**
2. **Browse today's games** with `/games`
3. **Start a bet** - Pick a game and choose your team
4. **Send SOL** to the generated wallet address
5. **Others join** - Friends pick the opposing team and send their wagers
6. **Game ends** - Bettr detects the result and pays out winners automatically

## Example

```
Lakers vs Celtics tonight

Alice bets 1 SOL on Lakers
Bob bets 2 SOL on Lakers
Charlie bets 1.5 SOL on Celtics

Total pot: 4.5 SOL

Lakers win!

Payout (after 1% fee):
- Alice receives: 1.485 SOL
- Bob receives: 2.97 SOL
- Charlie receives: nothing
```

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Register your account |
| `/games` | View today's games |
| `/bet` | Start or join a bet |
| `/mybets` | View your active bets |
| `/wallet <address>` | Set your payout wallet |
| `/help` | Show help |

## Fees

Bettr takes a **1% fee** on every settled bet. This is deducted from the pot before payouts.

## Security

- Round wallet private keys are encrypted at rest using AES-256-GCM
- Each betting round uses a unique wallet
- Funds are only held temporarily until game settlement
- No user private keys are ever stored

## License

This software is proprietary and confidential. All rights reserved. See [LICENSE](LICENSE) for details.

Unauthorized copying, forking, modification, or distribution is strictly prohibited.
