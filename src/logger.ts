import pino from "pino";
import { config } from "./config.js";

export const logger = pino({
  level: config.logLevel,
  transport: {
    target: "pino-pretty",
    options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" },
  },
});

export type Logger = typeof logger;
