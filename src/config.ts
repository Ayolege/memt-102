import "dotenv/config";
import { z } from "zod";

const csv = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const bool = z
  .string()
  .transform((v) => v.toLowerCase() === "true")
  .pipe(z.boolean());

const positiveNumber = z
  .string()
  .transform((v) => Number(v))
  .pipe(z.number().positive());

const nonNegativeNumber = z
  .string()
  .transform((v) => Number(v))
  .pipe(z.number().nonnegative());

const Schema = z.object({
  WALLET_SECRET_KEY: z.string().min(32, "WALLET_SECRET_KEY is required (base58)"),

  RPC_HTTP_URL: z.string().url(),
  RPC_WS_URL: z.string().url(),

  DRY_RUN: bool.default("true"),
  MAX_POSITION_USD: positiveNumber,
  MAX_OPEN_POSITIONS: positiveNumber,
  DAILY_LOSS_LIMIT_USD: positiveNumber,
  KILL_SWITCH_FILE: z.string().default("./state/KILL"),

  SLIPPAGE_BPS: positiveNumber,
  PRIORITY_FEE_MICROLAMPORTS: nonNegativeNumber,
  USE_RUST_SENDER: bool.default("false"),
  RUST_SENDER_BIN: z.string().default("./rust/target/release/memt-sender"),

  MOMENTUM_ENABLED: bool.default("true"),
  MOMENTUM_WATCHLIST: z.string().default(""),
  MOMENTUM_POLL_MS: positiveNumber,
  MOMENTUM_BREAKOUT_THRESHOLD: nonNegativeNumber,
  MOMENTUM_LOOKBACK_SAMPLES: positiveNumber,
  TRAILING_STOP: nonNegativeNumber,
  HARD_STOP: nonNegativeNumber,
  TAKE_PROFIT: nonNegativeNumber,

  COPY_TRADING_ENABLED: bool.default("false"),
  COPY_TARGET_WALLETS: z.string().default(""),
  COPY_SIZE_FRACTION: nonNegativeNumber,
  COPY_MIRROR_SELLS: bool.default("true"),

  BASE_MINT: z.string().min(32),
  BASE_MINT_DECIMALS: positiveNumber,

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),

  LOG_LEVEL: z.string().default("info"),
});

const parsed = Schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  console.error("\nCopy .env.example to .env and fill in the required fields.");
  process.exit(1);
}

const env = parsed.data;

export const config = {
  walletSecretKey: env.WALLET_SECRET_KEY,
  rpc: { http: env.RPC_HTTP_URL, ws: env.RPC_WS_URL },

  dryRun: env.DRY_RUN,
  risk: {
    maxPositionUsd: env.MAX_POSITION_USD,
    maxOpenPositions: env.MAX_OPEN_POSITIONS,
    dailyLossLimitUsd: env.DAILY_LOSS_LIMIT_USD,
    killSwitchFile: env.KILL_SWITCH_FILE,
  },

  exec: {
    slippageBps: env.SLIPPAGE_BPS,
    priorityFeeMicroLamports: env.PRIORITY_FEE_MICROLAMPORTS,
    useRustSender: env.USE_RUST_SENDER,
    rustSenderBin: env.RUST_SENDER_BIN,
  },

  momentum: {
    enabled: env.MOMENTUM_ENABLED,
    watchlist: csv(env.MOMENTUM_WATCHLIST),
    pollMs: env.MOMENTUM_POLL_MS,
    breakoutThreshold: env.MOMENTUM_BREAKOUT_THRESHOLD,
    lookbackSamples: env.MOMENTUM_LOOKBACK_SAMPLES,
    trailingStop: env.TRAILING_STOP,
    hardStop: env.HARD_STOP,
    takeProfit: env.TAKE_PROFIT,
  },

  copy: {
    enabled: env.COPY_TRADING_ENABLED,
    targets: csv(env.COPY_TARGET_WALLETS),
    sizeFraction: env.COPY_SIZE_FRACTION,
    mirrorSells: env.COPY_MIRROR_SELLS,
  },

  baseMint: env.BASE_MINT,
  baseMintDecimals: env.BASE_MINT_DECIMALS,

  telegram:
    env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
      ? { token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID }
      : null,

  logLevel: env.LOG_LEVEL,
} as const;

export type Config = typeof config;
