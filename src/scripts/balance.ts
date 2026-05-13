import { config } from "../config.js";
import { wallet, getSolBalance, getTokenBalance } from "../wallet.js";

const sol = await getSolBalance();
const base = await getTokenBalance(config.baseMint);
const baseHuman = Number(base) / 10 ** config.baseMintDecimals;

console.log(`Wallet:      ${wallet.publicKey.toBase58()}`);
console.log(`SOL balance: ${sol.toFixed(4)}`);
console.log(`Base mint:   ${config.baseMint} = ${baseHuman}`);
