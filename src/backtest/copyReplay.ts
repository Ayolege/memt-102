import type { SwapEvent } from "../strategies/copyParser.js";

export interface CopyReplayOpts {
  events: SwapEvent[];
  ourMaxPositionBaseUnits: bigint;
  sizeFraction: number;
  /** Per-side slippage in bps applied to the target's effective fill price. */
  slippageBps: number;
  /** Per-trade fee in bps applied to base notional (entry + exit). */
  feeBps: number;
  mirrorSells: boolean;
}

export interface CopyTrade {
  mint: string;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  pnlBaseUnits: bigint;
  pnlPct: number;
  reason: string;
}

export interface OpenCopyPosition {
  mint: string;
  entryTime: number;
  entryPrice: number;
  baseSpent: bigint;
  tokens: bigint;
}

export interface CopyReplayResult {
  trades: CopyTrade[];
  open: OpenCopyPosition[];
  totalRealisedBaseUnits: bigint;
  buysSeen: number;
  sellsSeen: number;
  buysCopied: number;
  sellsCopied: number;
}

export function runCopyReplay(opts: CopyReplayOpts): CopyReplayResult {
  const events = [...opts.events].sort((a, b) => a.blockTime - b.blockTime);
  const positions = new Map<string, OpenCopyPosition>();
  const trades: CopyTrade[] = [];
  let totalRealised = 0n;
  let buysSeen = 0;
  let sellsSeen = 0;
  let buysCopied = 0;
  let sellsCopied = 0;

  const ourSpend = BigInt(
    Math.floor(Number(opts.ourMaxPositionBaseUnits) * opts.sizeFraction),
  );

  for (const evt of events) {
    if (evt.kind === "buy") {
      buysSeen++;
      if (ourSpend === 0n) continue;
      if (evt.tokensReceived === 0n) continue;
      const targetPrice = Number(evt.baseSpent) / Number(evt.tokensReceived);
      const ourPrice = targetPrice * (1 + opts.slippageBps / 10000);
      const ourTokens = BigInt(Math.floor(Number(ourSpend) / ourPrice));
      if (ourTokens === 0n) continue;
      // Match live behaviour: a second buy of an open mint replaces the position.
      positions.set(evt.mint, {
        mint: evt.mint,
        entryTime: evt.blockTime,
        entryPrice: ourPrice,
        baseSpent: ourSpend,
        tokens: ourTokens,
      });
      buysCopied++;
    } else {
      sellsSeen++;
      if (!opts.mirrorSells) continue;
      const pos = positions.get(evt.mint);
      if (!pos) continue;
      if (evt.tokensSold === 0n) continue;
      const targetPrice = Number(evt.baseReceived) / Number(evt.tokensSold);
      const ourPrice = targetPrice * (1 - opts.slippageBps / 10000);
      const grossProceeds = BigInt(Math.floor(Number(pos.tokens) * ourPrice));
      const fee = BigInt(
        Math.floor(((Number(pos.baseSpent) + Number(grossProceeds)) * opts.feeBps) / 10000),
      );
      const netProceeds = grossProceeds - fee;
      const pnl = netProceeds - pos.baseSpent;
      totalRealised += pnl;
      const pnlPct = pos.baseSpent > 0n ? (Number(pnl) / Number(pos.baseSpent)) * 100 : 0;
      trades.push({
        mint: evt.mint,
        entryTime: pos.entryTime,
        exitTime: evt.blockTime,
        entryPrice: pos.entryPrice,
        exitPrice: ourPrice,
        pnlBaseUnits: pnl,
        pnlPct,
        reason: "target sold",
      });
      positions.delete(evt.mint);
      sellsCopied++;
    }
  }

  return {
    trades,
    open: [...positions.values()],
    totalRealisedBaseUnits: totalRealised,
    buysSeen,
    sellsSeen,
    buysCopied,
    sellsCopied,
  };
}
