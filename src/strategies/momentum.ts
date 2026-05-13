import { config } from "../config.js";
import { buy, sell } from "../executor.js";
import { getMidPrice } from "../jupiter.js";
import { logger } from "../logger.js";
import * as positions from "../positions.js";
import { exitReason, WatchedToken } from "./momentumLogic.js";

const watched = new Map<string, WatchedToken>();

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
    const reason = exitReason(
      { entryPrice: open.entryPriceBasePerToken, highWaterPrice: open.highWaterPrice },
      mid,
      config.momentum,
    );
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
    const t = new WatchedToken(mint, config.momentum);
    watched.set(mint, t);
    const jitter = Math.floor(Math.random() * config.momentum.pollMs);
    setTimeout(() => {
      void tick(t);
      setInterval(() => void tick(t), config.momentum.pollMs);
    }, jitter);
  }

  logger.info({ count: watched.size }, "momentum strategy started");
}
