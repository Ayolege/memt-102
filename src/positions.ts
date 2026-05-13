import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface Position {
  mint: string;
  amount: string;
  entryPriceBasePerToken: number;
  highWaterPrice: number;
  spentBaseUnits: string;
  openedAt: number;
  source: "momentum" | "copy";
}

interface State {
  positions: Record<string, Position>;
  realisedPnlBaseUnits: string;
  dayStartedAt: number;
}

const FILE = "./state/positions.json";

const empty = (): State => ({
  positions: {},
  realisedPnlBaseUnits: "0",
  dayStartedAt: Date.now(),
});

let state: State = empty();
let loaded = false;

async function persist() {
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(state, null, 2));
}

export async function load() {
  if (loaded) return;
  try {
    state = JSON.parse(await readFile(FILE, "utf8")) as State;
  } catch {
    state = empty();
    await persist();
  }
  loaded = true;
}

export function list(): Position[] {
  return Object.values(state.positions);
}

export function get(mint: string): Position | undefined {
  return state.positions[mint];
}

export async function upsert(p: Position) {
  state.positions[p.mint] = p;
  await persist();
}

export async function remove(mint: string) {
  delete state.positions[mint];
  await persist();
}

export async function recordRealisedPnl(deltaBaseUnits: bigint) {
  const next = BigInt(state.realisedPnlBaseUnits) + deltaBaseUnits;
  state.realisedPnlBaseUnits = next.toString();
  await persist();
}

export function realisedPnlBaseUnits(): bigint {
  return BigInt(state.realisedPnlBaseUnits);
}

/** Reset PnL counter at UTC midnight rollover. */
export async function maybeRollDay() {
  const today = new Date().toISOString().slice(0, 10);
  const dayStart = new Date(state.dayStartedAt).toISOString().slice(0, 10);
  if (today !== dayStart) {
    state.realisedPnlBaseUnits = "0";
    state.dayStartedAt = Date.now();
    await persist();
  }
}
