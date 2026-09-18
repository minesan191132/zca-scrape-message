import { config } from "../config.js";
import { MessageStore } from "../store/messageStore.js";
import { CdpPage, connectToZaloMainPage, connectToZaloNotificationPage } from "./cdp.js";
import { ensureZaloReady, installLiveMessageObserver, scrapeAndSaveLatest, slugify, toNormalizedMessage, waitForSidebarLoaded } from "./desktopScraper.js";
import type { ScrapedRow } from "./scrapeSelectors.js";

const NOTIFY_BINDING = "__zalobotNotify";
const LIVE_MSG_BINDING = "__zalobotLiveMsg";

/**
 * Alternative to the scheduled one-shot run (bot/index.ts): stays connected
 * indefinitely and reacts to Zalo Desktop's own notification popup window
 * (znotification.html) instead of waiting for the next scheduled time.
 *
 * Do not run this at the same time as a scheduled `bot:scrape` run — both
 * call ensureZaloReady, which kills and relaunches Zalo Desktop if its debug
 * port isn't already open; a scheduled run doing that mid-watch would tear
 * down this process's live CDP connections. Pick one operating mode.
 */
export async function watch(): Promise<void> {
    if (config.targets.length === 0) {
        console.log("[watch] config.targets is empty — nothing to watch. Add conversation names to bot/config.ts.");
        return;
    }

    const store = new MessageStore();

    await ensureZaloReady();
    const mainPage = await connectToZaloMainPage(config.cdpUrl);
    await waitForSidebarLoaded(mainPage, 30_000);

    const notifPage = await connectToZaloNotificationPage(config.cdpUrl);
    await installNotificationObserver(notifPage);

    // Tracks which target is currently open in mainPage, so incoming
    // LIVE_MSG_BINDING calls (which don't carry a thread name themselves —
    // the observer just reports "a new row rendered") know which thread
    // they belong to.
    let currentOpenTarget: string | null = null;
    await mainPage.addBinding(LIVE_MSG_BINDING);
    mainPage.onBindingCalled((name, payload) => {
        if (name !== LIVE_MSG_BINDING || !currentOpenTarget) return;
        let row: ScrapedRow;
        try {
            row = JSON.parse(payload);
        } catch {
            return;
        }
        if (!row.externalId) return;

        const threadId = slugify(currentOpenTarget);
        const normalized = toNormalizedMessage(row, threadId);
        if (store.save(normalized)) {
            const who = normalized.isSelf ? "bạn" : normalized.senderName || "(cùng người vừa nhắn)";
            console.log(`[watch] "${currentOpenTarget}" live: ${who}: ${String(normalized.content).slice(0, 120)}`);
        }
    });

    console.log(`[watch] listening for new-message notifications for: ${config.targets.join(", ")} (Ctrl+C to stop)`);

    // Node's built-in WebSocket doesn't keep the event loop alive on its
    // own the way a normal long-lived socket would — without this, the
    // process exits right after setup even though the connections are
    // still open, since nothing else is pending.
    setInterval(() => {}, 1 << 30);

    // Serializes triggered scrapes so two near-simultaneous notifications
    // never drive the shared mainPage (click / scroll) concurrently.
    let queue: Promise<void> = Promise.resolve();
    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

    notifPage.onBindingCalled((name, payload) => {
        if (name !== NOTIFY_BINDING) return;
        let data: { name: string | null; body: string | null };
        try {
            data = JSON.parse(payload);
        } catch {
            return;
        }

        const target = resolveTarget(data.name);
        if (!target) return;

        console.log(`[watch] notification for "${target}": ${data.body ?? ""}`.slice(0, 160));

        const existing = debounceTimers.get(target);
        if (existing) clearTimeout(existing);
        debounceTimers.set(
            target,
            setTimeout(() => {
                debounceTimers.delete(target);
                queue = queue
                    .then(() => scrapeAndSaveLatest(mainPage, store, target))
                    .then(async () => {
                        // Now that `target` is the open thread, attach a live
                        // observer to it so further messages there are caught
                        // the instant they render — no more waiting on this
                        // thread's own notification, which may well have gone
                        // quiet now that it's the focused/open conversation.
                        currentOpenTarget = target;
                        await installLiveMessageObserver(mainPage, LIVE_MSG_BINDING);
                    })
                    .catch((err) => console.error(`[watch] scrape failed for "${target}":`, err));
            }, 2_000),
        );
    });

    const stopWatching = () => {
        console.log("\n[watch] stopping...");
        mainPage.close();
        notifPage.close();
        process.exit(0);
    };
    process.on("SIGINT", stopWatching);
    process.on("SIGTERM", stopWatching);

    notifPage.onClose(() => {
        console.error("[watch] lost connection to Zalo's notification window — exiting. Restart `npm run bot:watch` to resume.");
        process.exit(1);
    });
}

/**
 * Zalo's notification popup shows a group's name as "Nhóm: <name>" but a
 * direct message's sender name with no prefix — only confirmed for the
 * group case so far. Only reacts to names that match config.targets
 * exactly (after stripping the group prefix), so unrelated
 * conversations/DMs never trigger a scrape.
 */
function resolveTarget(notificationName: string | null): string | null {
    if (!notificationName) return null;
    const groupPrefix = "Nhóm: ";
    const candidate = notificationName.startsWith(groupPrefix) ? notificationName.slice(groupPrefix.length) : notificationName;
    return config.targets.includes(candidate) ? candidate : null;
}

/**
 * Installs a MutationObserver in the notification page that calls back into
 * Node (via the CDP binding) with the current #zname/#zbody every time the
 * popup's content changes — this is a real push, not polling.
 */
async function installNotificationObserver(page: CdpPage): Promise<void> {
    await page.addBinding(NOTIFY_BINDING);
    await page.evaluate(`
(() => {
    if (window.__zalobotObserverInstalled) return;
    window.__zalobotObserverInstalled = true;
    const notify = () => {
        const nameEl = document.getElementById("zname");
        const bodyEl = document.getElementById("zbody");
        window.${NOTIFY_BINDING}(JSON.stringify({
            name: nameEl ? nameEl.textContent : null,
            body: bodyEl ? bodyEl.textContent : null,
        }));
    };
    new MutationObserver(notify).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
    });
})()`);
}
