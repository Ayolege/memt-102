import WebSocket from "ws";
import { PublicKey } from "@solana/web3.js";
import { config } from "../config.js";
import { buy, sell } from "../executor.js";
import { logger } from "../logger.js";
import * as positions from "../positions.js";
import { connection } from "../rpc.js";
import { parseSwap } from "./copyParser.js";

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

async function handleSignature(target: string, signature: string) {
  if (!rememberSignature(signature)) return;

  let tx;
  try {
    tx = await connection.getParsedTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
  } catch (err) {
    logger.debug({ err, signature }, "copy: getParsedTransaction failed");
    return;
  }

  const evt = parseSwap(signature, tx, target, config.baseMint);
  if (!evt) return;

  if (evt.kind === "buy") {
    const ourSpend = BigInt(
      Math.floor(
        config.risk.maxPositionUsd *
          config.copy.sizeFraction *
          10 ** config.baseMintDecimals,
      ),
    );
    if (ourSpend === 0n) return;
    logger.info({ target, mint: evt.mint, signature }, "copy: mirroring buy");
    await buy({ mint: evt.mint, spendBaseUnits: ourSpend, source: "copy" });
    return;
  }

  if (config.copy.mirrorSells && positions.get(evt.mint)) {
    logger.info({ target, mint: evt.mint, signature }, "copy: mirroring sell");
    await sell({ mint: evt.mint, reason: "copy: target exited" });
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
