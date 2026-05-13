# memt-102 — Solana Memecoin Trading Bot

Automated trading bot for Solana memecoins. Runs **momentum/breakout** and
**copy trading** strategies in parallel, executes via **Jupiter v6**, and has
an optional **Rust hot-path** that blasts signed transactions to the Jito Block
Engine and multiple RPCs in parallel for faster fills.

> **Read the risks section before you fund a wallet.** Memecoin trading is
> adversarial; bots lose money by default. This software is provided as-is with
> no warranty. You are responsible for every transaction your wallet signs.

---

## Architecture

```
                        ┌──────────────────────────┐
                        │  src/index.ts (orchestr.) │
                        └─────────────┬─────────────┘
              ┌───────────────────────┼─────────────────────────┐
              ▼                       ▼                         ▼
     ┌────────────────┐     ┌────────────────────┐    ┌─────────────────┐
     │ Momentum strat │     │ Copy-trading strat │    │ Risk manager    │
     │ (price polling)│     │ (Helius logs WS)   │    │ + position book │
     └───────┬────────┘     └─────────┬──────────┘    └────────┬────────┘
             └───────────┬────────────┘                        │
                         ▼                                     │
                ┌───────────────────┐                          │
                │ Executor (buy/sell)├──── consults ───────────┘
                └─────────┬──────────┘
                          ▼
              ┌────────────────────────┐
              │ Jupiter quote + swap   │
              └───────────┬────────────┘
              ┌───────────┴────────────┐
              ▼                        ▼
     ┌─────────────────┐      ┌──────────────────────┐
     │ TS sendTx (RPC) │      │ Rust sender (Jito)   │
     │ (default)       │      │ (USE_RUST_SENDER=true)│
     └─────────────────┘      └──────────────────────┘
```

- **TypeScript core** owns strategy logic, risk management, persistence and
  the slow path. It uses `@solana/web3.js` and the Jupiter v6 HTTP API.
- **Rust hot-path** (`rust/`) is a tiny CLI that takes a base64-encoded
  versioned transaction on stdin, signs it, and races it to Jito + a list of
  RPCs in parallel. Used for momentum entries and copy-trade entries when
  every block matters.

---

## Setup

```bash
# 1. Install deps
npm install

# 2. (Optional but recommended) Build the Rust hot-path
npm run build:rust

# 3. Configure
cp .env.example .env
# Edit .env: paste your wallet key, RPC URLs, set risk caps.

# 4. Sanity-check your wallet
npm run balance

# 5. Start in dry-run mode (default)
npm run dev
```

Once you've watched it for at least an hour in dry-run, set `DRY_RUN=false`
in `.env` and restart. The bot will refuse to start without `MAX_POSITION_USD`,
`MAX_OPEN_POSITIONS` and `DAILY_LOSS_LIMIT_USD` set to positive values.

### Kill switch

```bash
mkdir -p state && touch state/KILL
```

The bot polls this file every loop and immediately stops opening new positions.
Existing positions still respect their stops so you don't get stuck mid-trade.

---

## Strategies

### Momentum / breakout (`src/strategies/momentum.ts`)

For each mint in `MOMENTUM_WATCHLIST`:

1. Poll the Jupiter price every `MOMENTUM_POLL_MS`.
2. Maintain a rolling window of the last `MOMENTUM_LOOKBACK_SAMPLES` prices.
3. Fire a **buy** when `price > window_high × (1 + MOMENTUM_BREAKOUT_THRESHOLD)`
   AND the short EMA is above the long EMA.
4. Manage exits via trailing stop, hard stop, and (optional) take profit.

### Copy trading (`src/strategies/copyTrading.ts`)

For each wallet in `COPY_TARGET_WALLETS`:

1. Open a `logsSubscribe` WebSocket on the wallet's address.
2. On every signature, fetch the parsed transaction.
3. Diff the target wallet's pre/post token balances.
4. If they **bought** token X with the base mint → mirror with our size cap.
5. If they **sold** token X → close our X position (if `COPY_MIRROR_SELLS=true`).

---

## Risk model

Hard rules enforced in `src/risk.ts` before any swap is built:

| Rule | Source |
|---|---|
| Position size ≤ `MAX_POSITION_USD` | `MAX_POSITION_USD` |
| Open positions ≤ `MAX_OPEN_POSITIONS` | `MAX_OPEN_POSITIONS` |
| Realised + unrealised PnL today ≥ `-DAILY_LOSS_LIMIT_USD` | `DAILY_LOSS_LIMIT_USD` |
| Kill-switch file absent | `KILL_SWITCH_FILE` |
| Slippage ≤ `SLIPPAGE_BPS` | `SLIPPAGE_BPS` |
| Input mint == `BASE_MINT` (no double-buy) | `BASE_MINT` |

Rejected trades are logged with the rule that fired. Nothing is silent.

---

## Risks (read this)

- **Memecoins regularly go to zero.** The trailing stop is an exit hint, not a
  guarantee — if liquidity vanishes, the swap fails and you hold the bag.
- **Sandwich attacks** are common on Solana. Jito bundling helps a little but
  doesn't eliminate the problem. Use small size.
- **RPC lies** happen. Always verify fills against `getTransaction` rather than
  trusting `sendTransaction`'s return value.
- **Copy trading is laggy.** By the time you see a target's tx confirmed, the
  price has already moved. You're effectively front-run by everyone watching
  the same wallet.
- **Your private key is in `.env`.** A read of that file = total loss. Restrict
  permissions (`chmod 600 .env`), don't run the bot on a shared machine, and
  use a dedicated hot wallet funded with only what you'd accept losing.

This bot will not make you money on its own. The strategies here are
starting points — the parameters that worked last week may not work this week.

---

## Project layout

```
src/
  index.ts              # entry point — wires strategies + executor
  config.ts             # zod-validated env, fails loudly on missing rails
  logger.ts             # pino
  rpc.ts                # Solana Connection
  wallet.ts             # Keypair + balance helpers
  jupiter.ts            # Jupiter v6 quote + swap-tx builder
  executor.ts           # central entry/exit, picks TS or Rust send path
  risk.ts               # hard caps, kill switch, daily PnL limit
  positions.ts          # JSON-persisted position book
  alerts.ts             # console + optional Telegram
  strategies/
    momentum.ts
    copyTrading.ts
  scripts/
    balance.ts          # `npm run balance`
rust/
  Cargo.toml
  src/main.rs           # `memt-sender` CLI: sign + race-send a tx
```
