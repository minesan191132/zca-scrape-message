import { config } from "./config.js";
import { ensureZaloReady } from "./history/desktopScraper.js";

/**
 * Standalone helper: makes sure Zalo Desktop is running with its CDP debug
 * port open, without running any scrape. Useful when you just want to probe
 * the DOM manually (e.g. to refresh history/scrapeSelectors.ts) without
 * waiting for a full scrape pass — reuses the same restart logic as
 * index.ts/watch.ts (see ensureZaloReady in history/desktopScraper.ts).
 */
async function main() {
    await ensureZaloReady();
    console.log(`[debug] Zalo Desktop is ready — CDP debug port open at ${config.cdpUrl}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
