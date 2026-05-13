import { VersionedTransaction } from "@solana/web3.js";
import { config } from "./config.js";

const QUOTE_URL = "https://quote-api.jup.ag/v6/quote";
const SWAP_URL = "https://quote-api.jup.ag/v6/swap";

export interface QuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: unknown[];
  contextSlot: number;
}

export async function getQuote(opts: {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps?: number;
}): Promise<QuoteResponse> {
  const params = new URLSearchParams({
    inputMint: opts.inputMint,
    outputMint: opts.outputMint,
    amount: opts.amount.toString(),
    slippageBps: String(opts.slippageBps ?? config.exec.slippageBps),
    onlyDirectRoutes: "false",
    asLegacyTransaction: "false",
  });
  const res = await fetch(`${QUOTE_URL}?${params}`);
  if (!res.ok) {
    throw new Error(`Jupiter quote failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as QuoteResponse;
}

export async function buildSwapTx(opts: {
  quote: QuoteResponse;
  userPublicKey: string;
}): Promise<VersionedTransaction> {
  const body = {
    quoteResponse: opts.quote,
    userPublicKey: opts.userPublicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: config.exec.priorityFeeMicroLamports,
  };
  const res = await fetch(SWAP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Jupiter swap build failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { swapTransaction: string };
  const buf = Buffer.from(data.swapTransaction, "base64");
  return VersionedTransaction.deserialize(buf);
}

/**
 * Round-trip price: how many output mint units do we get for 1 unit of base?
 * Used by the momentum strategy. Cached only for the duration of one call.
 */
export async function getMidPrice(opts: {
  baseMint: string;
  baseDecimals: number;
  targetMint: string;
}): Promise<number> {
  const oneUnit = BigInt(10 ** opts.baseDecimals);
  const q = await getQuote({
    inputMint: opts.baseMint,
    outputMint: opts.targetMint,
    amount: oneUnit,
    slippageBps: 50,
  });
  return Number(q.outAmount) / Number(q.inAmount);
}
