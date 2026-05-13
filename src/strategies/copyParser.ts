import type { ParsedTransactionWithMeta } from "@solana/web3.js";

interface TokenDelta {
  mint: string;
  delta: bigint;
  decimals: number;
}

export type SwapEvent =
  | {
      kind: "buy";
      signature: string;
      blockTime: number;
      mint: string;
      baseSpent: bigint;
      tokensReceived: bigint;
      tokenDecimals: number;
    }
  | {
      kind: "sell";
      signature: string;
      blockTime: number;
      mint: string;
      tokensSold: bigint;
      baseReceived: bigint;
      tokenDecimals: number;
    };

export function diffWalletBalances(
  tx: ParsedTransactionWithMeta | null,
  walletAddr: string,
): TokenDelta[] {
  if (!tx?.meta) return [];
  const pre = tx.meta.preTokenBalances ?? [];
  const post = tx.meta.postTokenBalances ?? [];

  const byMint = new Map<string, { pre: bigint; post: bigint; decimals: number }>();
  for (const b of pre) {
    if (b.owner !== walletAddr) continue;
    const e = byMint.get(b.mint) ?? { pre: 0n, post: 0n, decimals: b.uiTokenAmount.decimals };
    e.pre = BigInt(b.uiTokenAmount.amount);
    byMint.set(b.mint, e);
  }
  for (const b of post) {
    if (b.owner !== walletAddr) continue;
    const e = byMint.get(b.mint) ?? { pre: 0n, post: 0n, decimals: b.uiTokenAmount.decimals };
    e.post = BigInt(b.uiTokenAmount.amount);
    byMint.set(b.mint, e);
  }

  const out: TokenDelta[] = [];
  for (const [mint, e] of byMint) {
    const delta = e.post - e.pre;
    if (delta !== 0n) out.push({ mint, delta, decimals: e.decimals });
  }
  return out;
}

/**
 * Classify a parsed tx as a buy/sell of a single non-base mint vs the base mint.
 * Multi-leg swaps that touch >1 non-base mint return the largest absolute leg.
 */
export function parseSwap(
  signature: string,
  tx: ParsedTransactionWithMeta | null,
  walletAddr: string,
  baseMint: string,
): SwapEvent | null {
  const deltas = diffWalletBalances(tx, walletAddr);
  if (deltas.length === 0) return null;

  const baseDelta = deltas.find((d) => d.mint === baseMint);
  if (!baseDelta) return null;
  const others = deltas.filter((d) => d.mint !== baseMint);
  if (others.length === 0) return null;

  const blockTime = tx?.blockTime ?? 0;

  if (baseDelta.delta < 0n) {
    const acquired = others
      .filter((d) => d.delta > 0n)
      .sort((a, b) => (b.delta > a.delta ? 1 : -1))[0];
    if (!acquired) return null;
    return {
      kind: "buy",
      signature,
      blockTime,
      mint: acquired.mint,
      baseSpent: -baseDelta.delta,
      tokensReceived: acquired.delta,
      tokenDecimals: acquired.decimals,
    };
  }

  const released = others
    .filter((d) => d.delta < 0n)
    .sort((a, b) => (a.delta < b.delta ? 1 : -1))[0];
  if (!released) return null;
  return {
    kind: "sell",
    signature,
    blockTime,
    mint: released.mint,
    tokensSold: -released.delta,
    baseReceived: baseDelta.delta,
    tokenDecimals: released.decimals,
  };
}
