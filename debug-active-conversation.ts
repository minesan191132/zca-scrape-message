import { connectToZaloMainPage } from "./history/cdp.js";
import { config } from "./config.js";

/**
 * One-off diagnostic: dumps every sidebar conversation item's className plus
 * its display name, so we can spot which CSS class marks "this conversation
 * is currently open" (needed to fix installLiveMessageObserver leaking
 * messages from whatever thread the user manually switches to — see
 * history/desktopScraper.ts:installLiveMessageObserver).
 *
 * Usage: open the conversation you consider "currently active" in Zalo
 * Desktop first, then run this script and paste its output.
 */
async function main() {
    const page = await connectToZaloMainPage(config.cdpUrl);
    try {
        const items = await page.evaluate<Array<{ className: string; title: string | null }>>(`
Array.from(document.querySelectorAll(".conv-item")).map((item) => ({
    className: item.className,
    title: item.querySelector(".conv-item-title__name")?.textContent?.trim() ?? null,
}))`);
        console.log(JSON.stringify(items, null, 2));
    } finally {
        page.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
