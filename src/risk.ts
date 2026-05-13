import { stat } from "node:fs/promises";
import { config } from "./config.js";
import { logger } from "./logger.js";
import * as positions from "./positions.js";

export type RiskDecision = { ok: true } | { ok: false; reason: string };

async function killSwitchActive(): Promise<boolean> {
  try {
    await stat(config.risk.killSwitchFile);
    return true;
  } catch {
    return false;
  }
}

/**
 * Gate every entry through here. Sells are only gated by the kill switch
 * (we always allow exits to honour stops).
 */
export async function evaluateEntry(opts: {
  mint: string;
  sizeBaseUnits: bigint;
  baseUnitsPerUsd: number;
}): Promise<RiskDecision> {
  if (await killSwitchActive()) {
    return { ok: false, reason: "kill switch active" };
  }

  if (opts.mint === config.baseMint) {
    return { ok: false, reason: "cannot buy base mint with base mint" };
  }

  await positions.maybeRollDay();

  const open = positions.list();
  if (open.length >= config.risk.maxOpenPositions) {
    return {
      ok: false,
      reason: `max open positions reached (${open.length}/${config.risk.maxOpenPositions})`,
    };
  }

  const sizeUsd = Number(opts.sizeBaseUnits) / opts.baseUnitsPerUsd;
  if (sizeUsd > config.risk.maxPositionUsd) {
    return {
      ok: false,
      reason: `position size $${sizeUsd.toFixed(2)} > MAX_POSITION_USD $${config.risk.maxPositionUsd}`,
    };
  }

  const pnlUsd = Number(positions.realisedPnlBaseUnits()) / opts.baseUnitsPerUsd;
  if (pnlUsd <= -config.risk.dailyLossLimitUsd) {
    return {
      ok: false,
      reason: `daily loss limit hit: ${pnlUsd.toFixed(2)} USD <= -${config.risk.dailyLossLimitUsd}`,
    };
  }

  return { ok: true };
}

export async function evaluateExit(): Promise<RiskDecision> {
  if (await killSwitchActive()) {
    logger.warn("kill switch active — only emergency exits allowed");
  }
  return { ok: true };
}

/**
 * Cap a requested size to MAX_POSITION_USD, returning the size to actually use.
 */
export function capSize(opts: {
  requestedBaseUnits: bigint;
  baseUnitsPerUsd: number;
}): bigint {
  const maxBaseUnits = BigInt(Math.floor(config.risk.maxPositionUsd * opts.baseUnitsPerUsd));
  return opts.requestedBaseUnits < maxBaseUnits ? opts.requestedBaseUnits : maxBaseUnits;
}
