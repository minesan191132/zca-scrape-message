import { exec, spawn } from "node:child_process";
import { config } from "../config.js";
import type { NormalizedMessage } from "../store/messageStore.js";
import { MessageStore } from "../store/messageStore.js";
import { CdpPage, connectToZaloMainPage, isCdpReachable } from "./cdp.js";
import { exportThreadJson } from "./exportJson.js";
import { messageIdPrefix, selectors, type ScrapedRow } from "./scrapeSelectors.js";

/**
 * The whole bot, now: Zalo Desktop (Electron) is read over the Chrome
 * DevTools Protocol via history/cdp.ts, run on-demand or on a schedule
 * (Task Scheduler at e.g. 08:00 and 12:00). There is no separate login —
 * this reuses whatever account is already signed into the desktop app, the
 * same way a person using it normally would be. See ensureZaloReady for why
 * that sometimes means restarting the app first.
 */
export async function runScrape(store: MessageStore): Promise<void> {
    if (config.targets.length === 0) {
        console.log("[scrape] config.targets is empty — nothing to do. Add conversation names to bot/config.ts.");
        return;
    }

    await ensureZaloReady();
    const page = await connectToZaloMainPage(config.cdpUrl);

    try {
        await waitForSidebarLoaded(page, 30_000);
        for (const target of config.targets) {
            await scrapeAndSaveTarget(page, store, target);
        }
    } finally {
        page.close();
    }
}

/** Scrapes one target thread's full window (scrolls back to sinceTs) and writes it to both the JSONL store and the JSON export — used by the scheduled one-shot run (bot/index.ts). */
export async function scrapeAndSaveTarget(page: CdpPage, store: MessageStore, target: string): Promise<void> {
    console.log(`[scrape] scraping "${target}"...`);
    const rows = await scrapeThreadHistory(page, target);
    const threadId = slugify(target);
    const normalized = rows.map((r) => toNormalizedMessage(r, threadId));
    const written = store.saveMany(normalized);
    const exportPath = exportThreadJson(threadId, normalized);
    console.log(`[scrape] "${target}": scraped ${rows.length}, ${written} new, exported to ${exportPath}`);
}

/**
 * Reads only whatever's currently rendered in the open thread — no
 * scrolling, no sinceTs/untilTs filtering — used by the notification
 * watcher (history/watch.ts), where a new message is already visible at the
 * bottom of the pane as soon as the thread is opened, so walking back
 * through the day's history on every trigger would just be wasted work.
 * Writes only to the JSONL store (dedup handles overlap with prior scrapes)
 * — deliberately does NOT touch the JSON export, since that file is a full
 * sinceTs–untilTs snapshot and overwriting it with just these few visible
 * rows would drop everything a scheduled run already wrote for today.
 */
export async function scrapeAndSaveLatest(page: CdpPage, store: MessageStore, target: string): Promise<void> {
    const opened = await clickConversationWithRetry(page, target, 15_000);
    if (!opened) {
        console.warn(`[watch] sidebar item for "${target}" not found — check selectors.conversationTitle`);
        return;
    }
    await delay(1_000);

    const rows = await extractVisibleRows(page);
    const threadId = slugify(target);
    const normalized = rows.map((r) => toNormalizedMessage(r, threadId));
    const written = store.saveMany(normalized);
    console.log(`[watch] "${target}": saw ${rows.length} visible, ${written} new`);
}

/**
 * Zalo Desktop is single-instance (Electron's app.requestSingleInstanceLock):
 * launching it again while it's already running just hands off to the
 * existing process and exits, without opening a debug port. So if the debug
 * port isn't already up, the only way to guarantee it is to close whatever
 * instance is running (if any) and relaunch with the flag — the account
 * session lives in the local profile, not in this process, so restarting
 * doesn't sign anything out.
 */
export async function ensureZaloReady(): Promise<void> {
    if (await isCdpReachable(config.cdpUrl)) return;

    if (!config.autoLaunchZalo) {
        throw new Error(
            `Zalo Desktop's debug port (${config.cdpUrl}) isn't reachable. Launch it with --remote-debugging-port=${config.cdpPort}, or set autoLaunchZalo in bot/config.ts.`,
        );
    }
    if (!config.zaloExePath) {
        throw new Error("Could not auto-detect Zalo.exe under %LOCALAPPDATA%\\Programs\\Zalo — set zaloExePath in bot/config.ts manually.");
    }

    console.log("[scrape] Zalo Desktop debug port not open — restarting Zalo Desktop with it enabled...");
    await killZalo();
    spawn(config.zaloExePath, [`--remote-debugging-port=${config.cdpPort}`], {
        detached: true,
        stdio: "ignore",
    }).unref();

    await waitForCdpReady(config.cdpUrl, 30_000);
}

function killZalo(): Promise<void> {
    return new Promise((resolve) => {
        exec("taskkill /IM Zalo.exe /F", () => resolve());
    });
}

async function waitForCdpReady(cdpUrl: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await isCdpReachable(cdpUrl)) return;
        await delay(500);
    }
    throw new Error(`Zalo Desktop's debug port never came up at ${cdpUrl} within ${timeoutMs}ms.`);
}

/** Waits for the sidebar's conversation list to actually have entries rendered. */
export async function waitForSidebarLoaded(page: CdpPage, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const count = await page.evaluate<number>(`document.querySelectorAll(${JSON.stringify(selectors.conversationItem)}).length`);
        if (count > 0) return;
        await delay(500);
    }
    throw new Error("Zalo Desktop's sidebar never loaded any conversations — check selectors.conversationItem in scrapeSelectors.ts.");
}

/**
 * Opens a conversation by its display name and scrolls its message pane
 * upward repeatedly, collecting rows as they render.
 */
async function scrapeThreadHistory(page: CdpPage, targetName: string): Promise<ScrapedRow[]> {
    const opened = await clickConversationWithRetry(page, targetName, 15_000);
    if (!opened) {
        console.warn(`[scrape] sidebar item for "${targetName}" not found — check selectors.conversationTitle`);
        return [];
    }
    await delay(1_500);

    const collected = new Map<string, ScrapedRow>();
    let previousHeight = -1;
    let stableRounds = 0;
    let passedCutoff = false;

    while (collected.size < config.targetMessageCount && stableRounds < 3 && !passedCutoff) {
        const rows = await extractVisibleRows(page);
        for (const row of rows) collected.set(row.externalId, row);

        if (config.sinceTs != null && rows.length > 0 && rows.every((r) => r.ts != null && r.ts < config.sinceTs!)) {
            passedCutoff = true;
            break;
        }

        const height = await scrollMessagePaneToTop(page);
        await delay(randomBetween(config.scrollDelayMs.min, config.scrollDelayMs.max));

        stableRounds = height != null && height === previousHeight ? stableRounds + 1 : 0;
        previousHeight = height ?? previousHeight;
    }

    return [...collected.values()].filter((r) => {
        if (r.ts == null) return true;
        if (config.sinceTs != null && r.ts < config.sinceTs) return false;
        if (config.untilTs != null && r.ts > config.untilTs) return false;
        return true;
    });
}

/**
 * Right after Zalo Desktop (re)starts, the sidebar renders its list
 * incrementally — waitForSidebarLoaded only confirms *something* is there,
 * not that this specific conversation has rendered yet — so this retries
 * for a while instead of failing on the first miss.
 */
async function clickConversationWithRetry(page: CdpPage, targetName: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await clickConversation(page, targetName)) return true;
        await delay(500);
    }
    return false;
}

async function clickConversation(page: CdpPage, targetName: string): Promise<boolean> {
    const expr = `
(() => {
    const titles = Array.from(document.querySelectorAll(${JSON.stringify(selectors.conversationTitle)}));
    const target = titles.find((t) => t.textContent.trim() === ${JSON.stringify(targetName)});
    if (!target) return false;
    const item = target.closest(${JSON.stringify(selectors.conversationItem)});
    if (!item) return false;
    item.click();
    return true;
})()`;
    return page.evaluate<boolean>(expr);
}

async function extractVisibleRows(page: CdpPage): Promise<ScrapedRow[]> {
    const expr = `
(() => {
    const idPrefix = ${JSON.stringify(messageIdPrefix)};
    const rows = Array.from(document.querySelectorAll(${JSON.stringify(selectors.messageRow)}));
    return rows.map((el) => {
        const senderEl = el.querySelector(${JSON.stringify(selectors.senderName)});
        const contentEl = el.querySelector(${JSON.stringify(selectors.messageContent)});
        const id = el.id || "";
        // Text messages: bb_msg_id_<ts>. Media/album messages: bb_msg_id_<ts>_<n>_<groupId>
        // — only the leading segment is the timestamp either way.
        const tsPart = id.startsWith(idPrefix) ? id.slice(idPrefix.length).split("_")[0] : null;
        const ts = tsPart && /^\\d+$/.test(tsPart) ? Number(tsPart) : null;
        return {
            externalId: id || null,
            senderName: senderEl ? senderEl.textContent.trim() : "",
            content: contentEl ? contentEl.textContent.trim() : "",
            ts,
            isSelf: / me /.test(" " + el.className + " "),
        };
    });
})()`;
    const rows = await page.evaluate<Array<Omit<ScrapedRow, "externalId"> & { externalId: string | null }>>(expr);
    return rows
        .filter((r) => r.externalId || r.content)
        .map((r) => ({ ...r, externalId: r.externalId ?? hashRow(r) }));
}

/** Walks up from the first message row to its nearest scrollable ancestor and scrolls it to the top. Returns the new scrollHeight, or null if no message row / scrollable ancestor exists yet. */
async function scrollMessagePaneToTop(page: CdpPage): Promise<number | null> {
    const expr = `
(() => {
    const msg = document.querySelector(${JSON.stringify(selectors.messageRow)});
    if (!msg) return null;
    let el = msg.parentElement;
    while (el && !(el.scrollHeight > el.clientHeight + 5)) el = el.parentElement;
    if (!el) return null;
    el.scrollTop = 0;
    return el.scrollHeight;
})()`;
    return page.evaluate<number | null>(expr);
}

/**
 * Attaches a MutationObserver directly to the currently-open thread's
 * message pane, so every new `.chat-message` row that renders gets pushed
 * to Node the instant it appears (via CDP binding) — no re-click, no
 * re-extract, no debounce needed for whichever thread is already open. Any
 * previously installed live observer on this page (from a thread opened
 * earlier) is disconnected first, since switching threads tears down and
 * replaces the message pane anyway. Caller must have already called
 * `page.addBinding(bindingName)` once (idempotent per binding name).
 */
export async function installLiveMessageObserver(page: CdpPage, bindingName: string): Promise<boolean> {
    const expr = `
(() => {
    const msg = document.querySelector(${JSON.stringify(selectors.messageRow)});
    if (!msg) return false;
    let container = msg.parentElement;
    while (container && !(container.scrollHeight > container.clientHeight + 5)) container = container.parentElement;
    if (!container) return false;

    if (window.__zalobotLiveObserver) window.__zalobotLiveObserver.disconnect();
    window.__zalobotLiveSeen = window.__zalobotLiveSeen || new Set();

    const idPrefix = ${JSON.stringify(messageIdPrefix)};
    const rowSelector = ${JSON.stringify(selectors.messageRow)};
    const extractRow = (el) => {
        const senderEl = el.querySelector(${JSON.stringify(selectors.senderName)});
        const contentEl = el.querySelector(${JSON.stringify(selectors.messageContent)});
        const id = el.id || "";
        const tsPart = id.startsWith(idPrefix) ? id.slice(idPrefix.length).split("_")[0] : null;
        const ts = tsPart && /^\\d+$/.test(tsPart) ? Number(tsPart) : null;
        return {
            externalId: id || null,
            senderName: senderEl ? senderEl.textContent.trim() : "",
            content: contentEl ? contentEl.textContent.trim() : "",
            ts,
            isSelf: / me /.test(" " + el.className + " "),
        };
    };

    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.nodeType !== 1) continue;
                const rows = node.matches(rowSelector) ? [node] : Array.from(node.querySelectorAll(rowSelector));
                for (const row of rows) {
                    const id = row.id || "";
                    if (id && window.__zalobotLiveSeen.has(id)) continue;
                    if (id) window.__zalobotLiveSeen.add(id);
                    window.${bindingName}(JSON.stringify(extractRow(row)));
                }
            }
        }
    });
    observer.observe(container, { childList: true, subtree: true });
    window.__zalobotLiveObserver = observer;
    return true;
})()`;
    return page.evaluate<boolean>(expr);
}

export function toNormalizedMessage(row: ScrapedRow, threadId: string): NormalizedMessage {
    return {
        msgId: row.externalId,
        threadId,
        threadType: "group",
        senderId: "",
        senderName: row.senderName,
        isSelf: row.isSelf,
        ts: row.ts ?? Date.now(),
        msgType: "desktop.text",
        content: row.content,
        source: "history",
    };
}

function hashRow(row: { senderName: string; content: string; ts: number | null }): string {
    return "scraped_" + Buffer.from(`${row.senderName}:${row.content}:${row.ts}`).toString("base64url").slice(0, 24);
}

export function slugify(name: string): string {
    return (
        name
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_+|_+$/g, "") || "thread"
    );
}

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min: number, max: number) {
    return Math.floor(min + Math.random() * (max - min));
}
