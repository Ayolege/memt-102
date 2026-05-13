import WebSocket from "ws";
import { PublicKey } from "@solana/web3.js";
import { config } from "../config.js";
import { buy, sell } from "../executor.js";
import { logger } from "../logger.js";
import * as positions from "../positions.js";
import { connection } from "../rpc.js";

interface TokenDelta {
  mint: string;
  delta: bigint;
  decimals: number;
}

const RECONNECT_DELAY_MS = 2_000;
const seenSignatures = new Set<string>();
const SEEN_CAP = 1024;

function rememberSignature(sig: string) {
  if (seenSignatures.has(sig)) return false;
  seenSignatures.add(sig);
  if (seenSignatures.size > SEEN_CAP) {
    const first = seenSignatures.values().next().value;
    if (first) seenSignatures.delete(first);
  }
  return true;
}

async function diffWalletBalances(
  signature: string,
  wallet: string,
): Promise<TokenDelta[]> {
  const tx = await connection.getParsedTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx?.meta) return [];

  const pre = tx.meta.preTokenBalances ?? [];
  const post = tx.meta.postTokenBalances ?? [];

  const byMint = new Map<string, { pre: bigint; post: bigint; decimals: number }>();
  for (const b of pre) {
    if (b.owner !== wallet) continue;
    const e = byMint.get(b.mint) ?? { pre: 0n, post: 0n, decimals: b.uiTokenAmount.decimals };
    e.pre = BigInt(b.uiTokenAmount.amount);
    byMint.set(b.mint, e);
  }
  for (const b of post) {
    if (b.owner !== wallet) continue;
    const e = byMint.get(b.mint) ?? { pre: 0n, post: 0n, decimals: b.uiTokenAmount.decimals };
    e.post = BigInt(b.uiTokenAmount.amount);
    byMint.set(b.mint, e);
  }

  const deltas: TokenDelta[] = [];
  for (const [mint, e] of byMint) {
    const delta = e.post - e.pre;
    if (delta !== 0n) deltas.push({ mint, delta, decimals: e.decimals });
  }
  return deltas;
}

async function handleSignature(target: string, signature: string) {
  if (!rememberSignature(signature)) return;
  let deltas: TokenDelta[];
  try {
    deltas = await diffWalletBalances(signature, target);
  } catch (err) {
    logger.debug({ err, signature }, "copy: getParsedTransaction failed");
    return;
  }
  if (deltas.length === 0) return;

  // A swap looks like: target's base mint went down, target's other mint went up (or vice-versa).
  const baseDelta = deltas.find((d) => d.mint === config.baseMint);
  const otherDeltas = deltas.filter((d) => d.mint !== config.baseMint);
  if (!baseDelta || otherDeltas.length === 0) return;

  if (baseDelta.delta < 0n) {
    // Target spent base mint to acquire token(s) — mirror the largest acquisition.
    const acquired = otherDeltas
      .filter((d) => d.delta > 0n)
      .sort((a, b) => (b.delta > a.delta ? 1 : -1))[0];
    if (!acquired) return;

    const ourSpend = BigInt(
      Math.floor(
        config.risk.maxPositionUsd *
          config.copy.sizeFraction *
          10 ** config.baseMintDecimals,
      ),
    );
    if (ourSpend === 0n) return;

    logger.info(
      { target, mint: acquired.mint, signature },
      "copy: mirroring buy",
    );
    await buy({ mint: acquired.mint, spendBaseUnits: ourSpend, source: "copy" });
    return;
  }

  if (baseDelta.delta > 0n && config.copy.mirrorSells) {
    // Target sold token(s) for base mint — close any of those positions we hold.
    for (const d of otherDeltas) {
      if (d.delta >= 0n) continue;
      if (!positions.get(d.mint)) continue;
      logger.info({ target, mint: d.mint, signature }, "copy: mirroring sell");
      await sell({ mint: d.mint, reason: "copy: target exited" });
    }
  }
}

function subscribeWallet(target: string) {
  let backoff = RECONNECT_DELAY_MS;
  const open = () => {
    const ws = new WebSocket(config.rpc.ws);
    let subId: number | null = null;
    let reqId = 1;

    ws.on("open", () => {
      backoff = RECONNECT_DELAY_MS;
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: reqId++,
          method: "logsSubscribe",
          params: [
            { mentions: [new PublicKey(target).toBase58()] },
            { commitment: "confirmed" },
          ],
        }),
      );
      logger.info({ target }, "copy: subscribed to wallet logs");
    });

    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.id && typeof msg.result === "number" && subId === null) {
        subId = msg.result;
        return;
      }
      const sig = msg?.params?.result?.value?.signature;
      const err = msg?.params?.result?.value?.err;
      if (sig && !err) {
        void handleSignature(target, sig);
      }
    });

    const reconnect = () => {
      logger.warn({ target, backoff }, "copy: WS dropped, reconnecting");
      setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    };

    ws.on("close", reconnect);
    ws.on("error", (err) => {
      logger.warn({ err, target }, "copy: WS error");
      ws.close();
    });
  };
  open();
}

export function startCopyTrading() {
  if (!config.copy.enabled) {
    logger.info("copy trading disabled");
    return;
  }
  if (config.copy.targets.length === 0) {
    logger.warn("COPY_TRADING_ENABLED=true but COPY_TARGET_WALLETS is empty");
    return;
  }
  for (const t of config.copy.targets) subscribeWallet(t);
  logger.info({ count: config.copy.targets.length }, "copy trading started");
}
