import { spawn } from "node:child_process";
import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { notify } from "./alerts.js";
import { config } from "./config.js";
import { buildSwapTx, getQuote, type QuoteResponse } from "./jupiter.js";
import * as ledger from "./ledger.js";
import { logger } from "./logger.js";
import * as positions from "./positions.js";
import { capSize, evaluateEntry, evaluateExit } from "./risk.js";
import { connection } from "./rpc.js";
import { getTokenBalance, wallet } from "./wallet.js";

const baseUnitsPerUsd = 10 ** config.baseMintDecimals;

async function sendViaWeb3(tx: VersionedTransaction): Promise<string> {
  tx.sign([wallet]);
  const sig = await connection.sendTransaction(tx, {
    skipPreflight: false,
    maxRetries: 3,
  });
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

async function sendViaRust(tx: VersionedTransaction): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(config.exec.rustSenderBin, [], {
      env: { ...process.env, WALLET_SECRET_KEY: config.walletSecretKey },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`rust sender exit ${code}: ${stderr}`));
    });
    child.stdin.write(Buffer.from(tx.serialize()).toString("base64"));
    child.stdin.end();
  });
}

async function send(tx: VersionedTransaction): Promise<string> {
  if (config.dryRun) {
    const sig = bs58.encode(Buffer.from(`DRY-RUN-${Date.now()}`.padEnd(64, "x")));
    logger.warn({ sig }, "DRY_RUN — not broadcasting");
    return sig;
  }
  return config.exec.useRustSender ? sendViaRust(tx) : sendViaWeb3(tx);
}

interface BuyResult {
  signature: string;
  filledTokenAmount: bigint;
  spentBaseUnits: bigint;
  effectivePrice: number;
}

export async function buy(opts: {
  mint: string;
  spendBaseUnits: bigint;
  source: "momentum" | "copy";
}): Promise<BuyResult | null> {
  const sized = capSize({ requestedBaseUnits: opts.spendBaseUnits, baseUnitsPerUsd });
  const decision = await evaluateEntry({
    mint: opts.mint,
    sizeBaseUnits: sized,
    baseUnitsPerUsd,
  });
  if (!decision.ok) {
    logger.warn({ mint: opts.mint, reason: decision.reason }, "entry rejected");
    return null;
  }

  let quote: QuoteResponse;
  try {
    quote = await getQuote({
      inputMint: config.baseMint,
      outputMint: opts.mint,
      amount: sized,
    });
  } catch (err) {
    logger.error({ err, mint: opts.mint }, "quote failed");
    return null;
  }

  const tx = await buildSwapTx({ quote, userPublicKey: wallet.publicKey.toBase58() });

  let signature: string;
  try {
    signature = await send(tx);
  } catch (err) {
    logger.error({ err, mint: opts.mint }, "buy send failed");
    return null;
  }

  const filled = BigInt(quote.outAmount);
  const price = Number(quote.inAmount) / Number(quote.outAmount);

  await positions.upsert({
    mint: opts.mint,
    amount: filled.toString(),
    entryPriceBasePerToken: price,
    highWaterPrice: price,
    spentBaseUnits: sized.toString(),
    openedAt: Date.now(),
    source: opts.source,
  });

  await ledger.append({
    ts: Date.now(),
    mint: opts.mint,
    side: "buy",
    source: opts.source,
    signature,
    baseUnits: sized.toString(),
    tokenUnits: filled.toString(),
    effectivePrice: price,
    dryRun: config.dryRun,
  });

  await notify(
    `BUY ${opts.mint.slice(0, 6)}… spent ${(Number(sized) / baseUnitsPerUsd).toFixed(2)} USDC ` +
      `@ ${price.toExponential(3)} (${opts.source}) sig=${signature.slice(0, 12)}…`,
  );

  return {
    signature,
    filledTokenAmount: filled,
    spentBaseUnits: sized,
    effectivePrice: price,
  };
}

export async function sell(opts: {
  mint: string;
  reason: string;
}): Promise<{ signature: string } | null> {
  await evaluateExit();

  const pos = positions.get(opts.mint);
  if (!pos) {
    logger.warn({ mint: opts.mint }, "sell requested but no position");
    return null;
  }

  // Re-check on-chain balance — the position book can drift if a tx silently failed.
  const onChain = await getTokenBalance(opts.mint);
  const sellAmount = onChain < BigInt(pos.amount) ? onChain : BigInt(pos.amount);
  if (sellAmount === 0n) {
    logger.warn({ mint: opts.mint }, "no on-chain balance to sell, removing position");
    await positions.remove(opts.mint);
    return null;
  }

  let quote: QuoteResponse;
  try {
    quote = await getQuote({
      inputMint: opts.mint,
      outputMint: config.baseMint,
      amount: sellAmount,
    });
  } catch (err) {
    logger.error({ err, mint: opts.mint }, "exit quote failed");
    return null;
  }

  const tx = await buildSwapTx({ quote, userPublicKey: wallet.publicKey.toBase58() });

  let signature: string;
  try {
    signature = await send(tx);
  } catch (err) {
    logger.error({ err, mint: opts.mint }, "sell send failed");
    return null;
  }

  const proceeds = BigInt(quote.outAmount);
  const cost = BigInt(pos.spentBaseUnits);
  const pnl = proceeds - cost;
  const effectivePrice = Number(proceeds) / Number(sellAmount);
  await positions.recordRealisedPnl(pnl);
  await positions.remove(opts.mint);

  await ledger.append({
    ts: Date.now(),
    mint: opts.mint,
    side: "sell",
    source: pos.source,
    signature,
    baseUnits: proceeds.toString(),
    tokenUnits: sellAmount.toString(),
    effectivePrice,
    dryRun: config.dryRun,
  });

  await notify(
    `SELL ${opts.mint.slice(0, 6)}… proceeds ${(Number(proceeds) / baseUnitsPerUsd).toFixed(2)} USDC ` +
      `pnl ${(Number(pnl) / baseUnitsPerUsd).toFixed(2)} (${opts.reason}) sig=${signature.slice(0, 12)}…`,
  );

  return { signature };
}
