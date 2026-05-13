import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";

export interface LedgerEntry {
  ts: number;
  mint: string;
  side: "buy" | "sell";
  source: "momentum" | "copy";
  signature: string;
  baseUnits: string;
  tokenUnits: string;
  effectivePrice: number;
  dryRun: boolean;
}

const FILE = "./state/ledger.jsonl";

export async function append(entry: LedgerEntry): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true });
  await appendFile(FILE, JSON.stringify(entry) + "\n");
}

export async function readAll(): Promise<LedgerEntry[]> {
  try {
    await stat(FILE);
  } catch {
    return [];
  }
  const text = await readFile(FILE, "utf8");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LedgerEntry);
}
