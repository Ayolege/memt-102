import {
  exitReason,
  WatchedToken,
  type MomentumParams,
} from "../strategies/momentumLogic.js";
import type { Bar } from "./dataSource.js";

export interface Trade {
  mint: string;
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  pnlPct: number;
  reason: string;
}

export interface BacktestResult {
  mint: string;
  trades: Trade[];
  totalPnlPct: number;
  meanPnlPct: number;
  winRate: number;
  maxDrawdownPct: number;
  exposureBars: number;
  totalBars: number;
}

export interface BacktestOpts {
  mint: string;
  bars: Bar[];
  params: MomentumParams;
  /** Per-side slippage assumption in bps applied to fills. */
  slippageBps: number;
  /** Per-trade fee assumption in bps (priority fees, swap fees, etc.). */
  feeBps: number;
}

interface InternalPosition {
  entryTime: number;
  entryPrice: number;
  highWaterPrice: number;
}

function closeTrade(
  mint: string,
  pos: InternalPosition,
  bar: Bar,
  rawExitPrice: number,
  reason: string,
  slippageBps: number,
  feeBps: number,
): Trade {
  const exitPrice = rawExitPrice * (1 - slippageBps / 10000);
  const grossPnl = exitPrice / pos.entryPrice - 1;
  const netPnl = grossPnl - (feeBps + slippageBps) / 10000;
  return {
    mint,
    entryTime: pos.entryTime,
    entryPrice: pos.entryPrice,
    exitTime: bar.t,
    exitPrice,
    pnlPct: netPnl * 100,
    reason,
  };
}

export function runBacktest(opts: BacktestOpts): BacktestResult {
  const token = new WatchedToken(opts.mint, opts.params);
  const trades: Trade[] = [];
  let position: InternalPosition | null = null;
  let exposureBars = 0;

  for (const bar of opts.bars) {
    token.observe(bar.c);

    if (position) {
      exposureBars++;
      // Conservative ordering inside the bar: high happens first (raises HWM,
      // tightening trailing stop), then we test stops at the low.
      if (bar.h > position.highWaterPrice) position.highWaterPrice = bar.h;

      const stop = exitReason(
        { entryPrice: position.entryPrice, highWaterPrice: position.highWaterPrice },
        bar.l,
        opts.params,
      );
      if (stop) {
        trades.push(closeTrade(opts.mint, position, bar, bar.l, stop, opts.slippageBps, opts.feeBps));
        position = null;
        continue;
      }
      // Take profit may have triggered against the high.
      const tp = exitReason(
        { entryPrice: position.entryPrice, highWaterPrice: position.highWaterPrice },
        bar.h,
        opts.params,
      );
      if (tp && tp.startsWith("take profit")) {
        trades.push(closeTrade(opts.mint, position, bar, bar.h, tp, opts.slippageBps, opts.feeBps));
        position = null;
      }
    } else if (token.shouldEnter()) {
      // Entry on this bar's close, paying entry slippage.
      const entryPrice = bar.c * (1 + opts.slippageBps / 10000);
      position = { entryTime: bar.t, entryPrice, highWaterPrice: entryPrice };
    }
  }

  // Force-close any open position at the last close so the report is honest.
  if (position && opts.bars.length > 0) {
    const last = opts.bars[opts.bars.length - 1]!;
    trades.push(
      closeTrade(opts.mint, position, last, last.c, "end of data", opts.slippageBps, opts.feeBps),
    );
  }

  const totalPnlPct = trades.reduce((s, t) => s + t.pnlPct, 0);
  const wins = trades.filter((t) => t.pnlPct > 0).length;
  const winRate = trades.length > 0 ? wins / trades.length : 0;
  const meanPnlPct = trades.length > 0 ? totalPnlPct / trades.length : 0;

  let peak = 0;
  let cum = 0;
  let maxDd = 0;
  for (const t of trades) {
    cum += t.pnlPct;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
  }

  return {
    mint: opts.mint,
    trades,
    totalPnlPct,
    meanPnlPct,
    winRate,
    maxDrawdownPct: maxDd,
    exposureBars,
    totalBars: opts.bars.length,
  };
}
