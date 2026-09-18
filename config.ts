import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

/** Unix ms for today at the given local hour:minute. */
function todayAt(hour: number, minute: number): number {
    const d = new Date();
    d.setHours(hour, minute, 0, 0);
    return d.getTime();
}

/**
 * Zalo Desktop installs as C:\Users\<you>\AppData\Local\Programs\Zalo\Zalo-<version>\Zalo.exe
 * — the version segment changes on every auto-update, so this picks the
 * newest Zalo-* folder instead of hardcoding a version.
 */
function findZaloExe(): string | null {
    const programsDir = path.join(os.homedir(), "AppData", "Local", "Programs", "Zalo");
    if (!fs.existsSync(programsDir)) return null;

    const versionDirs = fs
        .readdirSync(programsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.startsWith("Zalo-"))
        .map((d) => d.name)
        .sort();
    const newest = versionDirs.at(-1);
    if (!newest) return null;

    const exePath = path.join(programsDir, newest, "Zalo.exe");
    return fs.existsSync(exePath) ? exePath : null;
}

export const config = {
    /** Chrome DevTools Protocol port Zalo Desktop is (re)launched with. */
    cdpPort: 9222,

    /** Derived CDP endpoint — http://127.0.0.1:<cdpPort>. */
    get cdpUrl(): string {
        return `http://127.0.0.1:${this.cdpPort}`;
    },

    /**
     * Path to Zalo.exe, auto-detected. Zalo Desktop is Electron-based, so
     * its DOM is readable over CDP the same way a browser's is — see
     * history/cdp.ts. Unlike the web (chat.zalo.me) client, this reuses
     * whatever session is already logged into the desktop app, so there is
     * no QR/login flow for this bot to manage at all.
     */
    zaloExePath: findZaloExe(),

    /**
     * If Zalo Desktop isn't already running with cdpPort open, kill any
     * running (non-debug) instance and relaunch it with the flag — Electron
     * apps are single-instance, so a plain second launch would just hand
     * off to the existing process and exit without opening the port. Needed
     * for unattended scheduled runs; the running session/login is untouched
     * since it's the same local profile, just restarted.
     */
    autoLaunchZalo: true,

    /** One JSONL file per thread is written here. */
    dataDir: path.join(repoRoot, "data"),

    /**
     * Conversations to scrape, by their exact (or close-enough) display
     * name as shown in the Zalo Desktop sidebar.
     *
     * Example: targets: ["IT Foundation", "Gia đình"],
     */
    targets: ["bot_test_1"] as string[],

    /**
     * Only keep messages at or after this time (unix ms) — scrolling stops
     * early once it scrolls past this point. null = no lower bound, only
     * targetMessageCount applies.
     */
    sinceTs: todayAt(6, 0) as number | null,

    /**
     * Only keep messages at or before this time (unix ms) — this is a pure
     * output filter, it doesn't affect scrolling (the newest messages are
     * always seen first, before any scrolling happens). null = no upper
     * bound, i.e. up through whenever the run actually happens. Use this to
     * pin an exact window (e.g. 08:00–12:00) that doesn't drift if the
     * scheduled run fires a bit late.
     * untilTs: todayAt(12, 0) as number | null,
     */
    untilTs: null as number | null,

    /** Safety cap on how many messages to pull per target per run, regardless of sinceTs. */
    targetMessageCount: 2000,

    /** Delay range (ms) between scroll steps, to avoid hammering the UI. */
    scrollDelayMs: { min: 500, max: 1200 },
};

export type BotConfig = typeof config;
