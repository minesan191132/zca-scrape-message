import { MessageStore } from "../store/messageStore.js";
import { exportThreadExcel, normalizeSenderName } from "./exportExcel.js";

/**
 * CLI: npx tsx history/exportExcelCli.ts <threadId> [senderName]
 * Reads already-scraped messages for <threadId> from the JSONL store and
 * writes them to a .xlsx file under data/export, optionally filtered to one
 * sender's messages.
 */
async function main() {
    const [threadId, senderName] = process.argv.slice(2);
    if (!threadId) {
        console.error("Usage: npx tsx history/exportExcelCli.ts <threadId> [senderName]");
        process.exit(1);
    }

    const store = new MessageStore();
    const messages = await store.readThread(threadId);
    if (messages.length === 0) {
        console.error(`[export] no stored messages found for thread "${threadId}" — run a scrape first.`);
        process.exit(1);
    }

    const filePath = exportThreadExcel(threadId, messages, {
        senderName,
        fileSuffix: senderName ? senderName.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, "_") : undefined,
    });

    const kept = senderName ? messages.filter((m) => normalizeSenderName(m.senderName) === normalizeSenderName(senderName)).length : messages.length;
    console.log(`[export] "${threadId}": ${kept}/${messages.length} messages${senderName ? ` from "${senderName}"` : ""} -> ${filePath}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
