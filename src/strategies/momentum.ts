import { config } from "../config.js";
import { buy, sell } from "../executor.js";
import { getMidPrice } from "../jupiter.js";
import { logger } from "../logger.js";
import * as positions from "../positions.js";

interface Window {
  prices: number[];
  shortEma: number | null;
  longEma: number | null;
}

const SHORT_PERIOD = 5;
const LONG_PERIOD = 20;

const ema = (prev: number | null, value: number, period: number): number => {
  const k = 2 / (period + 1);
  return prev === null ? value : value * k + prev * (1 - k);
};

class WatchedToken {
  private window: Window = { prices: [], shortEma: null, longEma: null };

  constructor(public readonly mint: string) {}

  observe(price: number) {
    this.window.prices.push(price);
    if (this.window.prices.length > config.momentum.lookbackSamples) {
      this.window.prices.shift();
    }
    this.window.shortEma = ema(this.window.shortEma, price, SHORT_PERIOD);
    this.window.longEma = ema(this.window.longEma, price, LONG_PERIOD);
  }

  shouldEnter(): boolean {
    const { prices, shortEma, longEma } = this.window;
    if (prices.length < config.momentum.lookbackSamples) return false;
    if (shortEma === null || longEma === null) return false;
    if (shortEma <= longEma) return false;

    const current = prices[prices.length - 1]!;
    // The breakout reference excludes the current sample so we measure against history.
    const high = Math.max(...prices.slice(0, -1));
    return current > high * (1 + config.momentum.breakoutThreshold);
  }
}

const watched = new Map<string, WatchedToken>();

function exitReason(pos: positions.Position, currentPrice: number): string | null {
  const drawdown = 1 - currentPrice / pos.highWaterPrice;
  if (drawdown >= config.momentum.trailingStop) return `trailing stop (${(drawdown * 100).toFixed(1)}%)`;

  const totalLoss = 1 - currentPrice / pos.entryPriceBasePerToken;
  if (totalLoss >= config.momentum.hardStop) return `hard stop (${(totalLoss * 100).toFixed(1)}%)`;

  if (config.momentum.takeProfit > 0) {
    const gain = currentPrice / pos.entryPriceBasePerToken - 1;
    if (gain >= config.momentum.takeProfit) return `take profit (${(gain * 100).toFixed(1)}%)`;
  }
  return null;
}

async function tick(token: WatchedToken) {
  let mid: number;
  try {
    mid = await getMidPrice({
      baseMint: config.baseMint,
      baseDecimals: config.baseMintDecimals,
      targetMint: token.mint,
    });
  } catch (err) {
    logger.debug({ err, mint: token.mint }, "momentum quote failed");
    return;
  }

  token.observe(mid);
  const open = positions.get(token.mint);

  if (open) {
    if (mid > open.highWaterPrice) {
      await positions.upsert({ ...open, highWaterPrice: mid });
    }
    const reason = exitReason(open, mid);
    if (reason) {
      logger.info({ mint: token.mint, reason }, "momentum exit");
      await sell({ mint: token.mint, reason });
    }
    return;
  }

  if (token.shouldEnter()) {
    const spend = BigInt(Math.floor(config.risk.maxPositionUsd * 10 ** config.baseMintDecimals));
    logger.info({ mint: token.mint, mid }, "momentum entry signal");
    await buy({ mint: token.mint, spendBaseUnits: spend, source: "momentum" });
  }
}

export function startMomentum() {
  if (!config.momentum.enabled) {
    logger.info("momentum strategy disabled");
    return;
  }
  if (config.momentum.watchlist.length === 0) {
    logger.warn("MOMENTUM_ENABLED=true but MOMENTUM_WATCHLIST is empty");
    return;
  }

  for (const mint of config.momentum.watchlist) {
    const t = new WatchedToken(mint);
    watched.set(mint, t);
    // Stagger pollers so we don't spike Jupiter on a single second.
    const jitter = Math.floor(Math.random() * config.momentum.pollMs);
    setTimeout(() => {
      void tick(t);
      setInterval(() => void tick(t), config.momentum.pollMs);
    }, jitter);
  }

  logger.info({ count: watched.size }, "momentum strategy started");
}
