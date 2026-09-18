import { MessageStore } from "./store/messageStore.js";
import { runScrape } from "./history/desktopScraper.js";

/**
 * Read-only Zalo message scraper, meant to be invoked on a schedule (Task
 * Scheduler at e.g. 08:00 and 12:00), not left running. There is no
 * WebSocket listener and no send/reply path anywhere in this codebase, and
 * no separate login step — see history/desktopScraper.ts for how it reuses
 * Zalo Desktop's own already-signed-in session.
 */
async function main() {
    const store = new MessageStore();
    await runScrape(store);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
