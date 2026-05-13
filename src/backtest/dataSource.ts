import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

const BIRDEYE_BASE = "https://public-api.birdeye.so";
const CACHE_DIR = "./data/bars";
const MAX_ITEMS_PER_REQ = 1000;

function mapInterval(sec: number): string {
  const map: Record<number, string> = {
    60: "1m",
    180: "3m",
    300: "5m",
    900: "15m",
    1800: "30m",
    3600: "1H",
    7200: "2H",
    14400: "4H",
    21600: "6H",
    43200: "12H",
    86400: "1D",
  };
  const t = map[sec];
  if (!t) throw new Error(`Unsupported interval: ${sec}s. Use one of: ${Object.keys(map).join(", ")}`);
  return t;
}

async function fetchChunk(opts: {
  mint: string;
  from: number;
  to: number;
  intervalType: string;
  apiKey: string;
}): Promise<Bar[]> {
  const url =
    `${BIRDEYE_BASE}/defi/ohlcv?address=${opts.mint}` +
    `&type=${opts.intervalType}&time_from=${opts.from}&time_to=${opts.to}`;
  const res = await fetch(url, {
    headers: { "X-API-KEY": opts.apiKey, "x-chain": "solana", accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Birdeye ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as {
    data?: { items?: Array<{ unixTime: number; o: number; h: number; l: number; c: number; v: number }> };
  };
  return (json.data?.items ?? []).map((it) => ({
    t: it.unixTime,
    o: it.o,
    h: it.h,
    l: it.l,
    c: it.c,
    v: it.v,
  }));
}

export async function loadBarsFromBirdeye(opts: {
  mint: string;
  from: number;
  to: number;
  intervalSec: number;
  apiKey: string;
}): Promise<Bar[]> {
  const intervalType = mapInterval(opts.intervalSec);
  const chunkSec = opts.intervalSec * MAX_ITEMS_PER_REQ;
  const all: Bar[] = [];
  let cursor = opts.from;
  while (cursor < opts.to) {
    const end = Math.min(cursor + chunkSec, opts.to);
    const chunk = await fetchChunk({
      mint: opts.mint,
      from: cursor,
      to: end,
      intervalType,
      apiKey: opts.apiKey,
    });
    all.push(...chunk);
    cursor = end;
    await new Promise((r) => setTimeout(r, 200));
  }
  const seen = new Set<number>();
  return all
    .filter((b) => {
      if (seen.has(b.t)) return false;
      seen.add(b.t);
      return true;
    })
    .sort((a, b) => a.t - b.t);
}

export async function loadBarsFromCsv(path: string): Promise<Bar[]> {
  const text = await readFile(path, "utf8");
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0]?.toLowerCase().split(",").map((s) => s.trim()) ?? [];
  const idx = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`CSV missing column "${name}". Got: ${header.join(",")}`);
    return i;
  };
  const tIdx = idx("t");
  const oIdx = idx("o");
  const hIdx = idx("h");
  const lIdx = idx("l");
  const cIdx = idx("c");
  const vIdx = header.indexOf("v");
  const out: Bar[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split(",");
    out.push({
      t: Number(cols[tIdx]),
      o: Number(cols[oIdx]),
      h: Number(cols[hIdx]),
      l: Number(cols[lIdx]),
      c: Number(cols[cIdx]),
      v: vIdx >= 0 ? Number(cols[vIdx]) : 0,
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

export async function loadBars(opts: {
  mint: string;
  from: number;
  to: number;
  intervalSec: number;
  apiKey?: string;
  noCache?: boolean;
}): Promise<Bar[]> {
  const cachePath = `${CACHE_DIR}/${opts.mint}_${opts.intervalSec}s_${opts.from}_${opts.to}.jsonl`;
  if (!opts.noCache) {
    try {
      await stat(cachePath);
      const text = await readFile(cachePath, "utf8");
      return text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Bar);
    } catch {
      // Fall through to fetch.
    }
  }
  if (!opts.apiKey) {
    throw new Error(
      "Birdeye API key required. Set BIRDEYE_API_KEY in .env, or pass --csv <path> with pre-downloaded bars.",
    );
  }
  const bars = await loadBarsFromBirdeye({
    mint: opts.mint,
    from: opts.from,
    to: opts.to,
    intervalSec: opts.intervalSec,
    apiKey: opts.apiKey,
  });
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, bars.map((b) => JSON.stringify(b)).join("\n"));
  return bars;
}
