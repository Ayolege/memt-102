import "dotenv/config";
import { runCopyReplay } from "./copyReplay.js";
import { fetchWalletSwaps } from "./walletHistory.js";

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
memt-102 copy-trading replay

Usage:
  npm run replay-copy -- --wallet <address> [options]

Options:
  --wallet <address>    Wallet to replay (required).
  --from <YYYY-MM-DD>   Start date (UTC). Default: 14 days ago.
  --to   <YYYY-MM-DD>   End date (UTC). Default: today.
  --max-position <usd>  Per-trade cap in USD. Default: MAX_POSITION_USD or 25.
  --size-fraction <0..1>  Fraction of cap to spend per copy. Default: COPY_SIZE_FRACTION or 1.0.
  --slippage <bps>      Per-side slippage assumption (default 100).
  --fee <bps>           Per-trade fee assumption (default 30).
  --no-mirror-sells     Don't close on target sells (positions stay open to end of replay).
  --no-cache            Re-fetch wallet history from RPC.
  --rpc <url>           RPC URL (default: RPC_HTTP_URL from .env).
  --verbose             Print every copied trade.
  --help                This message.

Notes:
  - Pulls signatures via getSignaturesForAddress + getParsedTransaction. A public
    RPC will rate-limit you hard — use Helius/Triton/QuickNode for any wallet
    with meaningful activity.
  - Fills are modelled at the target's effective price ± slippage. This ignores
    real liquidity impact (your size moves the pool, theirs already did) and
    assumes you would have landed in the same block.
`);
}

async function main() {
  const args = parseArgs();
  if (args.has("help") || !args.has("wallet")) return help();

  const wallet = args.get("wallet")!;
  const baseMint = process.env.BASE_MINT;
  const baseDecimals = Number(process.env.BASE_MINT_DECIMALS ?? 6);
  if (!baseMint) {
    console.error("BASE_MINT must be set in .env (USDC mint by default).");
    process.exit(1);
  }
  const rpc = args.get("rpc") ?? process.env.RPC_HTTP_URL;
  if (!rpc) {
    console.error("RPC URL required (set RPC_HTTP_URL in .env or pass --rpc).");
    process.exit(1);
  }

  const now = Math.floor(Date.now() / 1000);
  const fromArg = args.get("from");
  const toArg = args.get("to");
  const fromTs = fromArg ? Math.floor(new Date(`${fromArg}T00:00:00Z`).getTime() / 1000) : now - 14 * 86400;
  const toTs = toArg ? Math.floor(new Date(`${toArg}T00:00:00Z`).getTime() / 1000) : now;

  const maxPositionUsd = Number(args.get("max-position") ?? process.env.MAX_POSITION_USD ?? 25);
  const sizeFraction = Number(args.get("size-fraction") ?? process.env.COPY_SIZE_FRACTION ?? 1);
  const slippageBps = Number(args.get("slippage") ?? 100);
  const feeBps = Number(args.get("fee") ?? 30);
  const mirrorSells = !args.has("no-mirror-sells");

  console.log(`Fetching swaps for ${wallet} (${new Date(fromTs * 1000).toISOString()} → ${new Date(toTs * 1000).toISOString()})…`);
  const events = await fetchWalletSwaps({
    rpcUrl: rpc,
    wallet,
    baseMint,
    fromTs,
    toTs,
    noCache: args.has("no-cache"),
    onProgress: (m) => process.stderr.write(`  ${m}\r`),
  });
  process.stderr.write("\n");
  console.log(`Loaded ${events.length} swap events.`);
  if (events.length === 0) {
    console.log("Nothing to replay (target made no base-mint swaps in that range).");
    return;
  }

  const ourMaxPositionBaseUnits = BigInt(Math.floor(maxPositionUsd * 10 ** baseDecimals));
  const result = runCopyReplay({
    events,
    ourMaxPositionBaseUnits,
    sizeFraction,
    slippageBps,
    feeBps,
    mirrorSells,
  });

  const div = 10 ** baseDecimals;
  const realised = Number(result.totalRealisedBaseUnits) / div;
  const closed = result.trades.length;
  const wins = result.trades.filter((t) => t.pnlBaseUnits > 0n).length;
  const winRate = closed > 0 ? (wins / closed) * 100 : 0;
  const meanPct = closed > 0 ? result.trades.reduce((s, t) => s + t.pnlPct, 0) / closed : 0;

  console.log(`\n── Replay summary ─────────────────────────────────────────`);
  console.log(`target buys seen: ${result.buysSeen}    copied: ${result.buysCopied}`);
  console.log(`target sells seen: ${result.sellsSeen}    copied: ${result.sellsCopied}`);
  console.log(`closed trades: ${closed}    wins: ${wins} (${winRate.toFixed(1)}%)    mean pnl: ${meanPct.toFixed(2)}%`);
  console.log(`realised: ${realised >= 0 ? "+" : ""}${realised.toFixed(2)} USDC`);
  console.log(`open at end of replay: ${result.open.length}`);

  if (args.has("verbose") && result.trades.length > 0) {
    console.log("\nTrades:");
    for (const t of result.trades) {
      const entry = new Date(t.entryTime * 1000).toISOString().replace("T", " ").slice(0, 16);
      const exit = new Date(t.exitTime * 1000).toISOString().replace("T", " ").slice(0, 16);
      const sign = t.pnlPct >= 0 ? "+" : "";
      console.log(
        `  ${entry} → ${exit}  ${t.mint.slice(0, 8)}…  ${sign}${t.pnlPct.toFixed(2).padStart(7)}%   ${t.reason}`,
      );
    }
  }
  if (result.open.length > 0) {
    console.log("\nStill open at end of replay (unrealised):");
    for (const p of result.open) {
      const cost = Number(p.baseSpent) / div;
      console.log(`  ${p.mint.slice(0, 8)}…  cost=${cost.toFixed(2)} USDC  entered=${new Date(p.entryTime * 1000).toISOString().slice(0, 16)}`);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
