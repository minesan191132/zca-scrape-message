import fs from "node:fs";
import path from "node:path";
import XLSX from "xlsx";
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
 * Zalo Desktop renders sender names with U+00A0 (NBSP) between words instead
 * of a regular space, and can carry zero-width chars — a raw `===` against a
 * typed name (which uses regular spaces) silently never matches, so both
 * sides of a senderName comparison go through this first.
 */
export function normalizeSenderName(name: string): string {
    return name
        .normalize("NFC")
        .replace(/[​-‍﻿]/g, "")
        .replace(/[\s ]+/g, " ")
        .trim();
}

/**
 * Writes messages to a .xlsx file (one sheet, one row per message), sorted
 * oldest first. Pass `opts.senderName` to keep only messages from that exact
 * sender. Note: Zalo Desktop's DOM only renders the sender name on the first
 * bubble of a consecutive run from the same person (see toNormalizedMessage
 * in desktopScraper.ts) — messages that follow it in the same burst have an
 * empty senderName and will NOT match a senderName filter, so a strict
 * filter can under-count a sender's real message total.
 */
export function exportThreadExcel(threadId: string, messages: NormalizedMessage[], opts: { senderName?: string; fileSuffix?: string } = {}): string {
    fs.mkdirSync(exportDir, { recursive: true });

    const wantedSender = opts.senderName ? normalizeSenderName(opts.senderName) : null;
    const filtered = wantedSender ? messages.filter((m) => normalizeSenderName(m.senderName) === wantedSender) : messages;

    const rows = filtered
        .slice()
        .sort((a, b) => a.ts - b.ts)
        .map((m) => ({
            "Thời gian": formatVN(m.ts),
            "Người gửi": m.senderName,
            "Nội dung": typeof m.content === "string" ? m.content : JSON.stringify(m.content),
            "Loại": m.msgType,
            "MsgId": m.msgId,
        }));

    const sheet = XLSX.utils.json_to_sheet(rows);
    sheet["!cols"] = [{ wch: 20 }, { wch: 22 }, { wch: 60 }, { wch: 14 }, { wch: 28 }];

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Messages");

    const suffix = opts.fileSuffix ? `_${opts.fileSuffix}` : "";
    const filePath = path.join(exportDir, `${threadId}${suffix}_${todayStamp()}.xlsx`);
    XLSX.writeFile(workbook, filePath);
    return filePath;
}
