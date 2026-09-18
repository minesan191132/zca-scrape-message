import { watch } from "./history/watch.js";

/**
 * Continuous alternative to bot/index.ts — stays running and reacts to
 * Zalo's own new-message notifications instead of a fixed schedule. Do not
 * run alongside a scheduled `bot:scrape` run — see history/watch.ts.
 */
watch().catch((err) => {
    console.error(err);
    process.exit(1);
});
