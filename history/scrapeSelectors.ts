/**
 * DOM selectors for the Zalo Desktop (Electron) app, confirmed by hand via
 * a live CDP probe against a real running instance — see the message id
 * format note below. Re-confirm after any Zalo Desktop update that changes
 * these class names.
 */
export const selectors = {
    /** Sidebar entry's display-name element, used to find a thread by name. */
    conversationTitle: ".conv-item-title__name",

    /** Sidebar entry (ancestor of conversationTitle) — click this to open the thread. */
    conversationItem: ".conv-item",

    /** One row = one message bubble in the open thread's message pane. */
    messageRow: ".chat-message",

    /** Sender display name within a row — absent on the account's own messages. */
    senderName: ".message-sender-name-content",

    /** Text content within a row. */
    messageContent: ".text-message__container",
};

/**
 * Each message row's `id` attribute is `bb_msg_id_<unix-ms timestamp>` —
 * confirmed live (the trailing number matches wall-clock time of the
 * message), so there's no separate timestamp element to parse.
 */
export const messageIdPrefix = "bb_msg_id_";

export type ScrapedRow = {
    externalId: string;
    senderName: string;
    content: string;
    ts: number | null;
    isSelf: boolean;
};
