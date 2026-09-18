import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { NormalizedMessage } from "../store/messageStore.js";

const exportDir = path.join(config.dataDir, "export");

function formatVN(ts: number): string {
    return new Intl.DateTimeFormat("vi-VN", {
        timeZone: "Asia/Ho_Chi_Minh",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    }).format(new Date(ts));
}

function todayStamp(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Writes this run's scraped messages for one thread to a standalone JSON
 * file (array, pretty-printed), separate from the append-only JSONL store —
 * meant to be opened/shared directly, so each message carries both a raw
 * unix-ms `ts` and human-readable `timeIso` / `timeLocal` (Asia/Ho_Chi_Minh)
 * fields. One file per thread per day; reruns on the same day overwrite it
 * with that run's window.
 */
export function exportThreadJson(threadId: string, messages: NormalizedMessage[]): string {
    fs.mkdirSync(exportDir, { recursive: true });
    const filePath = path.join(exportDir, `${threadId}_${todayStamp()}.json`);

    const enriched = messages
        .slice()
        .sort((a, b) => a.ts - b.ts)
        .map((m) => ({
            ...m,
            timeIso: new Date(m.ts).toISOString(),
            timeLocal: formatVN(m.ts),
        }));

    fs.writeFileSync(filePath, JSON.stringify(enriched, null, 2), "utf-8");
    return filePath;
}
