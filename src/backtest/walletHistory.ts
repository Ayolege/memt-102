import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { parseSwap, type SwapEvent } from "../strategies/copyParser.js";

const SIG_PAGE_SIZE = 1000;
const PARSE_DELAY_MS = 50;
const CACHE_DIR = "./data/wallets";

interface CachePayload {
  wallet: string;
  baseMint: string;
  fromTs: number;
  toTs: number;
  events: SwapEvent[];
}

function cachePath(opts: { wallet: string; baseMint: string; fromTs: number; toTs: number }): string {
  return `${CACHE_DIR}/${opts.wallet}_${opts.baseMint.slice(0, 8)}_${opts.fromTs}_${opts.toTs}.json`;
}

function reviveBigints(events: SwapEvent[]): SwapEvent[] {
  return events.map((e) => {
    if (e.kind === "buy") {
      return {
        ...e,
        baseSpent: BigInt(e.baseSpent as unknown as string),
        tokensReceived: BigInt(e.tokensReceived as unknown as string),
      };
    }
    return {
      ...e,
      tokensSold: BigInt(e.tokensSold as unknown as string),
      baseReceived: BigInt(e.baseReceived as unknown as string),
    };
  });
}

function serialiseEvent(e: SwapEvent): unknown {
  if (e.kind === "buy") {
    return { ...e, baseSpent: e.baseSpent.toString(), tokensReceived: e.tokensReceived.toString() };
  }
  return { ...e, tokensSold: e.tokensSold.toString(), baseReceived: e.baseReceived.toString() };
}

export async function fetchWalletSwaps(opts: {
  rpcUrl: string;
  wallet: string;
  baseMint: string;
  fromTs: number;
  toTs: number;
  noCache?: boolean;
  onProgress?: (msg: string) => void;
}): Promise<SwapEvent[]> {
  const path = cachePath(opts);
  if (!opts.noCache) {
    try {
      await stat(path);
      const text = await readFile(path, "utf8");
      const cached = JSON.parse(text) as CachePayload;
      return reviveBigints(cached.events);
    } catch {
      // Fall through.
    }
  }

  const connection = new Connection(opts.rpcUrl, { commitment: "confirmed" });
  const pk = new PublicKey(opts.wallet);
  const events: SwapEvent[] = [];
  let before: string | undefined;
  let scanned = 0;

  while (true) {
    const sigs = await connection.getSignaturesForAddress(pk, {
      before,
      limit: SIG_PAGE_SIZE,
    });
    if (sigs.length === 0) break;

    let stopAfter = false;
    for (const s of sigs) {
      scanned++;
      const ts = s.blockTime ?? 0;
      if (ts > 0 && ts < opts.fromTs) {
        stopAfter = true;
        continue;
      }
      if (ts > 0 && ts > opts.toTs) continue;
      if (s.err) continue;

      let tx;
      try {
        tx = await connection.getParsedTransaction(s.signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
      } catch {
        await new Promise((r) => setTimeout(r, PARSE_DELAY_MS));
        continue;
      }
      const evt = parseSwap(s.signature, tx, opts.wallet, opts.baseMint);
      if (evt) events.push(evt);
      await new Promise((r) => setTimeout(r, PARSE_DELAY_MS));
    }
    opts.onProgress?.(`scanned=${scanned} swaps_found=${events.length} oldest=${sigs[sigs.length - 1]!.blockTime ?? "?"}`);
    if (stopAfter) break;
    before = sigs[sigs.length - 1]!.signature;
  }

  events.sort((a, b) => a.blockTime - b.blockTime);

  await mkdir(dirname(path), { recursive: true });
  const payload: unknown = {
    wallet: opts.wallet,
    baseMint: opts.baseMint,
    fromTs: opts.fromTs,
    toTs: opts.toTs,
    events: events.map(serialiseEvent),
  };
  await writeFile(path, JSON.stringify(payload));
  return events;
}
