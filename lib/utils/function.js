'use strict';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Splits a JID into its local part and server.
 * @param {string} jid
 * @returns {{ user: string, server: string, device?: number }}
 */
const parseJid = (jid) => {
    const [left, server = ''] = String(jid).split('@');
    const [user, device] = left.split(':');
    return device === undefined
        ? { user, server }
        : { user, server, device: Number(device) };
};

/** Bare phone digits from a JID (`6285…` from `6285…@s.whatsapp.net`). */
const jidToNumber = (jid) => parseJid(jid).user.replace(/\D/g, '');

/** True when the JID is a user (1:1) chat. */
const isUserJid = (jid) => /@(s\.whatsapp\.net|lid)$/.test(String(jid));

/** True when the JID is a group chat. */
const isGroupJid = (jid) => /@g\.us$/.test(String(jid));

/** True when the JID is a newsletter/channel. */
const isNewsletterJid = (jid) => /@newsletter$/.test(String(jid));

/** Strips the `:device` segment from a JID. */
const bareJid = (jid) => {
    const { user, server, device } = parseJid(jid);
    return device === undefined ? `${user}@${server}` : `${user}@${server}`;
};

/**
 * Adds a device suffix when missing (`jid` → `jid:0`). Mirrors the device
 * normalization zapo performs internally.
 */
const withDevice = (jid, device = 0) =>
    /:\d+@/.test(String(jid)) ? String(jid) : String(jid).replace('@', `:${device}@`);

/** Section divider used by bot plugins. */
const divider = '────────────────────';

/** Runtime text (process uptime based). */
const runtime = (seconds) => {
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor((seconds % (3600 * 24)) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return [d && `${d}d`, h && `${h}h`, m && `${m}m`, s && `${s}s`].filter(Boolean).join(' ') || '0s';
};

/** Escapes regex metacharacters in a string. */
const escapeRegExp = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = {
    delay,
    parseJid,
    jidToNumber,
    isUserJid,
    isGroupJid,
    isNewsletterJid,
    bareJid,
    withDevice,
    divider,
    runtime,
    escapeRegExp
};
