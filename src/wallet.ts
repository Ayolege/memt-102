import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "./config.js";
import { connection } from "./rpc.js";

function loadKeypair(secret: string): Keypair {
  const trimmed = secret.trim();
  if (trimmed.startsWith("[")) {
    const arr = JSON.parse(trimmed) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

export const wallet = loadKeypair(config.walletSecretKey);

export async function getSolBalance(): Promise<number> {
  const lamports = await connection.getBalance(wallet.publicKey);
  return lamports / LAMPORTS_PER_SOL;
}

export async function getTokenBalance(mint: string): Promise<bigint> {
  const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
    mint: new PublicKey(mint),
  });
  let total = 0n;
  for (const { account } of accounts.value) {
    const info = account.data.parsed.info as { tokenAmount: { amount: string } };
    total += BigInt(info.tokenAmount.amount);
  }
  return total;
}
