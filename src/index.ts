import { notify } from "./alerts.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { formatSummary, summarise } from "./pnl.js";
import * as positions from "./positions.js";
import { startCopyTrading } from "./strategies/copyTrading.js";
import { startMomentum } from "./strategies/momentum.js";
import { getSolBalance, wallet } from "./wallet.js";

const PNL_LOG_INTERVAL_MS = 5 * 60 * 1000;

function startPnlLog() {
  const tick = async () => {
    try {
      const s = await summarise({ mark: false });
      logger.info("\n" + formatSummary(s));
    } catch (err) {
      logger.warn({ err }, "pnl summary failed");
    }
  };
  setInterval(() => void tick(), PNL_LOG_INTERVAL_MS);
}

async function preflight() {
  await positions.load();

  const sol = await getSolBalance();
  logger.info(
    {
      wallet: wallet.publicKey.toBase58(),
      solBalance: sol,
      dryRun: config.dryRun,
      maxPositionUsd: config.risk.maxPositionUsd,
      maxOpenPositions: config.risk.maxOpenPositions,
      dailyLossLimitUsd: config.risk.dailyLossLimitUsd,
      momentum: config.momentum.enabled,
      copy: config.copy.enabled,
      sender: config.exec.useRustSender ? "rust" : "ts",
    },
    "memt-102 starting",
  );

  if (sol < 0.05 && !config.dryRun) {
    logger.warn({ sol }, "wallet has < 0.05 SOL — fees may fail");
  }

  if (config.dryRun) {
    logger.warn("DRY_RUN=true — no transactions will be broadcast. Flip in .env when ready.");
  } else {
    await notify(
      `memt-102 LIVE on ${wallet.publicKey.toBase58().slice(0, 8)}…  ` +
        `cap=$${config.risk.maxPositionUsd}/pos, daily=$${config.risk.dailyLossLimitUsd}`,
    );
  }
}

function installShutdownHandlers() {
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "shutdown requested — open positions remain on disk");
    process.exit(0);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaughtException — exiting");
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    logger.error({ err }, "unhandledRejection");
  });
}

async function main() {
  installShutdownHandlers();
  await preflight();
  startMomentum();
  startCopyTrading();
  startPnlLog();
}

main().catch((err) => {
  logger.fatal({ err }, "fatal");
  process.exit(1);
});
