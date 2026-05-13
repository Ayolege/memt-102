import { config } from "./config.js";
import { logger } from "./logger.js";

export async function notify(message: string) {
  logger.info({ alert: true }, message);
  if (!config.telegram) return;
  try {
    const url = `https://api.telegram.org/bot${config.telegram.token}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.telegram.chatId,
        text: message,
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    logger.warn({ err }, "telegram alert failed");
  }
}
