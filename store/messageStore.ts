import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { config } from "../config.js";

export type NormalizedMessage = {
    msgId: string;
    threadId: string;
    threadType: "user" | "group";
    senderId: string;
    senderName: string;
    isSelf: boolean;
    ts: number;
    msgType: string;
    content: unknown;
    /** Which of the two data sources produced this row. */
    source: "realtime" | "history";
};

/**
 * Append-only JSONL store, one file per thread, deduped by msgId.
 * Both the realtime listener and the Playwright history scraper write
 * through this so a message seen twice (e.g. a recent message the scraper
 * also scrolls past) is only ever stored once.
 */
export class MessageStore {
    private dataDir: string;
    private seenIds = new Map<string, Set<string>>();

    constructor(dataDir: string = config.dataDir) {
        this.dataDir = dataDir;
        fs.mkdirSync(this.dataDir, { recursive: true });
    }

    private filePath(threadId: string) {
        return path.join(this.dataDir, `${threadId}.jsonl`);
    }

    private loadSeenIds(threadId: string): Set<string> {
        let set = this.seenIds.get(threadId);
        if (set) return set;

        set = new Set();
        const file = this.filePath(threadId);
        if (fs.existsSync(file)) {
            const lines = fs.readFileSync(file, "utf-8").split("\n");
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const row = JSON.parse(line) as NormalizedMessage;
                    set.add(row.msgId);
                } catch {
                    // ignore malformed line
                }
            }
        }
        this.seenIds.set(threadId, set);
        return set;
    }

    /** Returns true if the message was new and got written, false if it was a duplicate. */
    save(message: NormalizedMessage): boolean {
        const seen = this.loadSeenIds(message.threadId);
        if (seen.has(message.msgId)) return false;

        seen.add(message.msgId);
        fs.appendFileSync(this.filePath(message.threadId), JSON.stringify(message) + "\n", "utf-8");
        return true;
    }

    saveMany(messages: NormalizedMessage[]): number {
        let written = 0;
        for (const m of messages) {
            if (this.save(m)) written++;
        }
        return written;
    }

    listThreads(): string[] {
        if (!fs.existsSync(this.dataDir)) return [];
        return fs
            .readdirSync(this.dataDir)
            .filter((f) => f.endsWith(".jsonl"))
            .map((f) => f.slice(0, -".jsonl".length));
    }

    async readThread(threadId: string): Promise<NormalizedMessage[]> {
        const file = this.filePath(threadId);
        if (!fs.existsSync(file)) return [];

        const rows: NormalizedMessage[] = [];
        const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
        for await (const line of rl) {
            if (!line.trim()) continue;
            try {
                rows.push(JSON.parse(line) as NormalizedMessage);
            } catch {
                // ignore malformed line
            }
        }
        rows.sort((a, b) => a.ts - b.ts);
        return rows;
    }

    async getRecent(threadId: string, limit = 50): Promise<NormalizedMessage[]> {
        const rows = await this.readThread(threadId);
        return rows.slice(-limit);
    }

    async search(query: string, opts: { threadId?: string; limit?: number } = {}): Promise<NormalizedMessage[]> {
        const threads = opts.threadId ? [opts.threadId] : this.listThreads();
        const needle = query.toLowerCase();
        const hits: NormalizedMessage[] = [];

        for (const threadId of threads) {
            const rows = await this.readThread(threadId);
            for (const row of rows) {
                const text = typeof row.content === "string" ? row.content : JSON.stringify(row.content);
                if (text.toLowerCase().includes(needle)) hits.push(row);
            }
        }

        hits.sort((a, b) => b.ts - a.ts);
        return opts.limit ? hits.slice(0, opts.limit) : hits;
    }
}
