import { formatSummary, summarise } from "../pnl.js";

const noMark = process.argv.includes("--no-mark");
const summary = await summarise({ mark: !noMark });
console.log(formatSummary(summary));
