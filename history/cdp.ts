/**
 * Minimal Chrome DevTools Protocol client over raw WebSocket — used instead
 * of Playwright because Playwright's `connectOverCDP` fails against Zalo
 * Desktop's Electron build (`Browser.setDownloadBehavior` is unimplemented
 * on its old CDP surface, Electron 22 / Chrome 108). Runtime.evaluate is all
 * this needs: read the DOM, click things via `element.click()`, scroll via
 * `element.scrollTop`.
 */

export type CdpTarget = {
    id: string;
    type: string;
    title: string;
    url: string;
    webSocketDebuggerUrl: string;
};

export async function listCdpTargets(cdpUrl: string): Promise<CdpTarget[]> {
    const res = await fetch(`${cdpUrl}/json/list`);
    if (!res.ok) throw new Error(`CDP target list request failed: ${res.status} ${res.statusText}`);
    return res.json();
}

export class CdpPage {
    private nextId = 0;
    private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
    private bindingListeners = new Set<(name: string, payload: string) => void>();
    private closeListeners = new Set<() => void>();
    private readonly ws: WebSocket;
    private readonly ready: Promise<void>;

    constructor(webSocketDebuggerUrl: string) {
        this.ws = new WebSocket(webSocketDebuggerUrl);
        this.ready = new Promise((resolve, reject) => {
            this.ws.addEventListener("open", () => resolve(), { once: true });
            this.ws.addEventListener("error", (e) => reject(e), { once: true });
        });
        this.ws.addEventListener("message", (ev) => {
            const msg = JSON.parse(ev.data.toString());
            if (msg.id != null && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id)!;
                this.pending.delete(msg.id);
                if (msg.error) reject(new Error(JSON.stringify(msg.error)));
                else resolve(msg.result);
                return;
            }
            // CDP "events" (pushed by the browser, not replies to a command) have no id.
            if (msg.method === "Runtime.bindingCalled") {
                for (const listener of this.bindingListeners) listener(msg.params.name, msg.params.payload);
            }
        });
        this.ws.addEventListener("close", () => {
            for (const listener of this.closeListeners) listener();
        });
    }

    /**
     * Zalo Desktop can go quiet on a specific command (renderer briefly
     * blocked, execution context torn down by a navigation, etc.) without
     * ever closing the WebSocket — without a timeout, `await`s on `send()`
     * hang forever with no error, no log, nothing (see history/watch.ts's
     * scrapeAndSaveLatest chain silently stalling after a notification).
     */
    private send(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<any> {
        const id = ++this.nextId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pending.delete(id)) {
                    reject(new Error(`CDP command "${method}" (id=${id}) timed out after ${timeoutMs}ms — no response from Zalo Desktop's debug port.`));
                }
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (v) => {
                    clearTimeout(timer);
                    resolve(v);
                },
                reject: (e) => {
                    clearTimeout(timer);
                    reject(e);
                },
            });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    async connect(): Promise<void> {
        await this.ready;
        await this.send("Runtime.enable");
    }

    /** Evaluate an expression in the page and return its structured-cloned value. */
    async evaluate<T>(expression: string): Promise<T> {
        const result = await this.send("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: true,
        });
        if (result.exceptionDetails) {
            throw new Error(`CDP evaluate failed: ${JSON.stringify(result.exceptionDetails)}`);
        }
        return result.result.value as T;
    }

    /**
     * Exposes a Node-callable function of this name inside the page's JS
     * context — call it (e.g. `window.<name>("some string")`) from injected
     * page-side code and this fires a real push event over the WebSocket
     * (`Runtime.bindingCalled`), instead of Node having to poll the page for
     * changes.
     */
    async addBinding(name: string): Promise<void> {
        await this.send("Runtime.addBinding", { name });
    }

    /** Registers a callback for every `window.<boundName>(payload)` call made from page-side code (see addBinding). */
    onBindingCalled(listener: (name: string, payload: string) => void): void {
        this.bindingListeners.add(listener);
    }

    /** Registers a callback for when the underlying WebSocket connection closes (page navigated away, Zalo Desktop restarted/crashed, etc.). */
    onClose(listener: () => void): void {
        this.closeListeners.add(listener);
    }

    close(): void {
        this.ws.close();
    }
}

/** True if something is already listening on cdpUrl's /json/version endpoint. */
export async function isCdpReachable(cdpUrl: string): Promise<boolean> {
    try {
        const res = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(2_000) });
        return res.ok;
    } catch {
        return false;
    }
}

function findMainTarget(targets: CdpTarget[]): CdpTarget | undefined {
    return targets.find((t) => t.type === "page" && t.title === "Zalo" && t.url.includes("index.html"));
}

function findNotificationTarget(targets: CdpTarget[]): CdpTarget | undefined {
    return targets.find((t) => t.type === "page" && t.url.includes("znotification.html"));
}

/**
 * Finds Zalo Desktop's single main window and opens a connected CdpPage to
 * it, retrying for a bit — right after a (re)launch the debug port answers
 * before the main window has actually navigated to index.html, so it
 * briefly only shows up as an untitled/blank target.
 */
export async function connectToZaloMainPage(cdpUrl: string, timeoutMs = 20_000): Promise<CdpPage> {
    const deadline = Date.now() + timeoutMs;
    let lastTargets: CdpTarget[] = [];

    while (Date.now() < deadline) {
        lastTargets = await listCdpTargets(cdpUrl);
        const mainTarget = findMainTarget(lastTargets);
        if (mainTarget) {
            const page = new CdpPage(mainTarget.webSocketDebuggerUrl);
            await page.connect();
            return page;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(
        `Could not find Zalo's main window among CDP targets at ${cdpUrl} within ${timeoutMs}ms (saw: ${lastTargets.map((t) => t.title).join(", ") || "none"}).`,
    );
}

/**
 * Finds Zalo Desktop's notification popup window (znotification.html) and
 * opens a connected CdpPage to it. Its DOM (#zname / #zbody) always reflects
 * whatever notification was last shown, and updates live as new ones arrive
 * — see history/watch.ts.
 */
export async function connectToZaloNotificationPage(cdpUrl: string, timeoutMs = 20_000): Promise<CdpPage> {
    const deadline = Date.now() + timeoutMs;
    let lastTargets: CdpTarget[] = [];

    while (Date.now() < deadline) {
        lastTargets = await listCdpTargets(cdpUrl);
        const target = findNotificationTarget(lastTargets);
        if (target) {
            const page = new CdpPage(target.webSocketDebuggerUrl);
            await page.connect();
            return page;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(
        `Could not find Zalo's notification window (znotification.html) among CDP targets at ${cdpUrl} within ${timeoutMs}ms (saw: ${lastTargets.map((t) => t.title).join(", ") || "none"}).`,
    );
}
