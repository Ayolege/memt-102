import "dotenv/config";
import { loadBars, loadBarsFromCsv } from "./dataSource.js";
import { runBacktest, type BacktestResult } from "./engine.js";
import type { MomentumParams } from "../strategies/momentumLogic.js";

function parseArgs(): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = process.argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args.set(key, next);
      i++;
    } else {
      args.set(key, "true");
    }
  }
  return args;
}

function help() {
  console.log(`
memt-102 backtester

Usage:
  npm run backtest -- [options]

Options:
  --mint <address>      Token mint to test. Default: first MOMENTUM_WATCHLIST entry.
  --from <YYYY-MM-DD>   Start date (UTC). Default: 30 days ago.
  --to   <YYYY-MM-DD>   End date (UTC). Default: today.
  --interval <s>        Bar size in seconds: 60, 300, 900, 1800, 3600, 14400, 86400. Default: 900.
  --csv <path>          Skip Birdeye, load bars from CSV (header: t,o,h,l,c,v).
  --slippage <bps>      Per-side slippage assumption (default 100 = 1%).
  --fee <bps>           Per-trade fee assumption (default 30 = 0.3%).
  --no-cache            Bypass on-disk bar cache.
  --sweep               Grid-search MOMENTUM_BREAKOUT_THRESHOLD x TRAILING_STOP, print top 20.
  --verbose             Print every trade.
  --help                This message.

Reads strategy parameters from .env (MOMENTUM_BREAKOUT_THRESHOLD, TRAILING_STOP, etc.).
Reads BIRDEYE_API_KEY from .env (or use --csv).
`);
}

function paramsFromEnv(overrides: Partial<MomentumParams> = {}): MomentumParams {
  return {
    lookbackSamples: Number(process.env.MOMENTUM_LOOKBACK_SAMPLES ?? 24),
    breakoutThreshold: Number(process.env.MOMENTUM_BREAKOUT_THRESHOLD ?? 0.02),
    trailingStop: Number(process.env.TRAILING_STOP ?? 0.15),
    hardStop: Number(process.env.HARD_STOP ?? 0.3),
    takeProfit: Number(process.env.TAKE_PROFIT ?? 0.5),
    ...overrides,
  };
}

function summary(r: BacktestResult): string {
  const exposure = r.totalBars > 0 ? ((r.exposureBars / r.totalBars) * 100).toFixed(1) : "0.0";
  return [
    `mint=${r.mint.slice(0, 8)}…`,
    `trades=${r.trades.length}`,
    `total=${r.totalPnlPct.toFixed(2)}%`,
    `mean=${r.meanPnlPct.toFixed(2)}%`,
    `win=${(r.winRate * 100).toFixed(1)}%`,
    `maxDD=${r.maxDrawdownPct.toFixed(2)}%`,
    `exposure=${exposure}%`,
  ].join("  ");
}

async function main() {
  const args = parseArgs();
  if (args.has("help")) return help();

  const watchlist = (process.env.MOMENTUM_WATCHLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const mint = args.get("mint") ?? watchlist[0];
  if (!mint) {
    console.error("No mint specified and MOMENTUM_WATCHLIST is empty.");
    process.exit(1);
  }

  const now = Math.floor(Date.now() / 1000);
  const fromArg = args.get("from");
  const toArg = args.get("to");
  const from = fromArg ? Math.floor(new Date(`${fromArg}T00:00:00Z`).getTime() / 1000) : now - 30 * 86400;
  const to = toArg ? Math.floor(new Date(`${toArg}T00:00:00Z`).getTime() / 1000) : now;
  const intervalSec = Number(args.get("interval") ?? 900);
  const slippageBps = Number(args.get("slippage") ?? 100);
  const feeBps = Number(args.get("fee") ?? 30);

  const csvPath = args.get("csv");
  const bars = csvPath
    ? await loadBarsFromCsv(csvPath)
    : await loadBars({
        mint,
        from,
        to,
        intervalSec,
        apiKey: process.env.BIRDEYE_API_KEY,
        noCache: args.has("no-cache"),
      });

  if (bars.length === 0) {
    console.error("No bars loaded — check date range and data source.");
    process.exit(1);
  }

  console.log(
    `Loaded ${bars.length} bars (${new Date(bars[0]!.t * 1000).toISOString()} → ${new Date(
      bars[bars.length - 1]!.t * 1000,
    ).toISOString()})`,
  );

  if (args.has("sweep")) {
    const breakouts = [0.005, 0.01, 0.02, 0.03, 0.05, 0.08];
    const trails = [0.05, 0.1, 0.15, 0.2, 0.3];
    const rows: Array<{ breakout: number; trail: number; r: BacktestResult }> = [];
    for (const breakout of breakouts) {
      for (const trail of trails) {
        const params = paramsFromEnv({ breakoutThreshold: breakout, trailingStop: trail });
        const r = runBacktest({ mint, bars, params, slippageBps, feeBps });
        rows.push({ breakout, trail, r });
      }
    }
    rows.sort((a, b) => b.r.totalPnlPct - a.r.totalPnlPct);
    console.log(`\nSweep results (sorted by total PnL):\n`);
    console.log("breakout  trail   trades   total%    mean%    win%   maxDD%");
    console.log("-".repeat(60));
    for (const { breakout, trail, r } of rows.slice(0, 20)) {
      console.log(
        [
          `${(breakout * 100).toFixed(1)}%`.padStart(7),
          `${(trail * 100).toFixed(0)}%`.padStart(6),
          String(r.trades.length).padStart(7),
          r.totalPnlPct.toFixed(2).padStart(8),
          r.meanPnlPct.toFixed(2).padStart(8),
          (r.winRate * 100).toFixed(1).padStart(6),
          r.maxDrawdownPct.toFixed(2).padStart(8),
        ].join(""),
      );
    }
    return;
  }

  const r = runBacktest({ mint, bars, params: paramsFromEnv(), slippageBps, feeBps });
  console.log(`\n${summary(r)}\n`);

  if (args.has("verbose") && r.trades.length > 0) {
    console.log("Trades:");
    for (const t of r.trades) {
      const entry = new Date(t.entryTime * 1000).toISOString().replace("T", " ").slice(0, 16);
      const exit = new Date(t.exitTime * 1000).toISOString().replace("T", " ").slice(0, 16);
      const sign = t.pnlPct >= 0 ? "+" : "";
      console.log(`  ${entry} → ${exit}  ${sign}${t.pnlPct.toFixed(2).padStart(6)}%   ${t.reason}`);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
