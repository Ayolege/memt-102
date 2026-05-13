import { config } from "./config.js";
import { getMidPrice } from "./jupiter.js";
import * as ledger from "./ledger.js";
import * as positions from "./positions.js";

interface Lot {
  tokenUnits: bigint;
  baseUnits: bigint;
}

interface PerMint {
  mint: string;
  realisedBaseUnits: bigint;
  openLots: Lot[];
  trades: number;
  wins: number;
}

export interface PnlSummary {
  realisedBaseUnits: bigint;
  unrealisedBaseUnits: bigint;
  totalTrades: number;
  closedTrades: number;
  wins: number;
  winRate: number;
  openPositions: Array<{
    mint: string;
    tokenUnits: bigint;
    costBaseUnits: bigint;
    markPrice: number | null;
    markValueBaseUnits: bigint | null;
    unrealisedBaseUnits: bigint | null;
  }>;
  baseDecimals: number;
}

function aggregateLedger(entries: ledger.LedgerEntry[]): Map<string, PerMint> {
  const byMint = new Map<string, PerMint>();
  const sorted = [...entries].sort((a, b) => a.ts - b.ts);

  for (const e of sorted) {
    const m =
      byMint.get(e.mint) ??
      ({
        mint: e.mint,
        realisedBaseUnits: 0n,
        openLots: [],
        trades: 0,
        wins: 0,
      } satisfies PerMint);

    if (e.side === "buy") {
      m.openLots.push({
        tokenUnits: BigInt(e.tokenUnits),
        baseUnits: BigInt(e.baseUnits),
      });
    } else {
      let toSell = BigInt(e.tokenUnits);
      const proceedsTotal = BigInt(e.baseUnits);
      const proceedsPerToken = Number(proceedsTotal) / Number(toSell || 1n);
      let costClosed = 0n;
      let proceedsClosed = 0n;
      while (toSell > 0n && m.openLots.length > 0) {
        const lot = m.openLots[0]!;
        if (lot.tokenUnits <= toSell) {
          const portionProceeds = BigInt(Math.floor(proceedsPerToken * Number(lot.tokenUnits)));
          costClosed += lot.baseUnits;
          proceedsClosed += portionProceeds;
          toSell -= lot.tokenUnits;
          m.openLots.shift();
        } else {
          const portionCost =
            (lot.baseUnits * toSell) / lot.tokenUnits;
          const portionProceeds = BigInt(Math.floor(proceedsPerToken * Number(toSell)));
          costClosed += portionCost;
          proceedsClosed += portionProceeds;
          lot.tokenUnits -= toSell;
          lot.baseUnits -= portionCost;
          toSell = 0n;
        }
      }
      const realised = proceedsClosed - costClosed;
      m.realisedBaseUnits += realised;
      m.trades += 1;
      if (realised > 0n) m.wins += 1;
    }
    byMint.set(e.mint, m);
  }
  return byMint;
}

async function markPrice(mint: string): Promise<number | null> {
  try {
    return await getMidPrice({
      baseMint: config.baseMint,
      baseDecimals: config.baseMintDecimals,
      targetMint: mint,
    });
  } catch {
    return null;
  }
}

export async function summarise(opts: { mark?: boolean } = {}): Promise<PnlSummary> {
  const entries = await ledger.readAll();
  const agg = aggregateLedger(entries);

  let realised = 0n;
  let unrealised = 0n;
  let totalTrades = 0;
  let closedTrades = 0;
  let wins = 0;
  const openPositions: PnlSummary["openPositions"] = [];

  for (const m of agg.values()) {
    realised += m.realisedBaseUnits;
    closedTrades += m.trades;
    wins += m.wins;
    totalTrades += m.trades + m.openLots.length;

    for (const lot of m.openLots) {
      let mark: number | null = null;
      let markValue: bigint | null = null;
      let lotUnrealised: bigint | null = null;
      if (opts.mark) {
        mark = await markPrice(m.mint);
        if (mark !== null) {
          markValue = BigInt(Math.floor(Number(lot.tokenUnits) * mark));
          lotUnrealised = markValue - lot.baseUnits;
          unrealised += lotUnrealised;
        }
      }
      openPositions.push({
        mint: m.mint,
        tokenUnits: lot.tokenUnits,
        costBaseUnits: lot.baseUnits,
        markPrice: mark,
        markValueBaseUnits: markValue,
        unrealisedBaseUnits: lotUnrealised,
      });
    }
  }

  // Reconcile open positions against the live position book in case the ledger
  // is empty but positions exist (e.g. recovering from a crash).
  if (openPositions.length === 0) {
    await positions.load();
    for (const p of positions.list()) {
      let mark: number | null = null;
      let markValue: bigint | null = null;
      let lotUnrealised: bigint | null = null;
      if (opts.mark) {
        mark = await markPrice(p.mint);
        if (mark !== null) {
          markValue = BigInt(Math.floor(Number(BigInt(p.amount)) * mark));
          lotUnrealised = markValue - BigInt(p.spentBaseUnits);
          unrealised += lotUnrealised;
        }
      }
      openPositions.push({
        mint: p.mint,
        tokenUnits: BigInt(p.amount),
        costBaseUnits: BigInt(p.spentBaseUnits),
        markPrice: mark,
        markValueBaseUnits: markValue,
        unrealisedBaseUnits: lotUnrealised,
      });
    }
  }

  return {
    realisedBaseUnits: realised,
    unrealisedBaseUnits: unrealised,
    totalTrades,
    closedTrades,
    wins,
    winRate: closedTrades > 0 ? wins / closedTrades : 0,
    openPositions,
    baseDecimals: config.baseMintDecimals,
  };
}

export function formatSummary(s: PnlSummary): string {
  const div = 10 ** s.baseDecimals;
  const realised = Number(s.realisedBaseUnits) / div;
  const unrealised = Number(s.unrealisedBaseUnits) / div;
  const lines = [
    `── PnL summary ────────────────────────────────────────────`,
    `realised:    ${realised >= 0 ? "+" : ""}${realised.toFixed(2)} USDC  (${s.closedTrades} closed, ${(s.winRate * 100).toFixed(1)}% win)`,
    `unrealised:  ${unrealised >= 0 ? "+" : ""}${unrealised.toFixed(2)} USDC  (${s.openPositions.length} open)`,
    `total PnL:   ${realised + unrealised >= 0 ? "+" : ""}${(realised + unrealised).toFixed(2)} USDC`,
  ];
  if (s.openPositions.length > 0) {
    lines.push("open positions:");
    for (const p of s.openPositions) {
      const cost = Number(p.costBaseUnits) / div;
      const mark = p.markValueBaseUnits === null ? null : Number(p.markValueBaseUnits) / div;
      const pnl = p.unrealisedBaseUnits === null ? null : Number(p.unrealisedBaseUnits) / div;
      const pnlStr = pnl === null ? "n/a" : `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`;
      const pct = pnl !== null && cost > 0 ? ` (${((pnl / cost) * 100).toFixed(1)}%)` : "";
      lines.push(
        `  ${p.mint.slice(0, 8)}…  cost=${cost.toFixed(2)}  mark=${mark === null ? "n/a" : mark.toFixed(2)}  pnl=${pnlStr}${pct}`,
      );
    }
  }
  return lines.join("\n");
}
