'use strict';

/**
 * Media families the compatibility translator understands. Kept in sync with
 * `wa.MEDIA_KEYS` in the content adapter.
 * @type {ReadonlyArray<string>}
 */
const MEDIA_TYPES = Object.freeze(['image', 'video', 'ptv', 'audio', 'document', 'sticker']);

/**
 * Native zapo content discriminators (`WaSendMessageContent`).
 * @type {ReadonlyArray<string>}
 */
const CONTENT_TYPES = Object.freeze([
    'text',
    'reaction',
    'revoke',
    'pin',
    'unpin',
    'keep',
    'unkeep',
    'poll',
    'poll-vote',
    'event',
    'event-response',
    ...MEDIA_TYPES,
    'sticker-pack'
]);

/**
 * Native flow button names accepted by `sendIAMessage`.
 * @type {ReadonlyArray<string>}
 */
const NATIVE_FLOW_BUTTONS = Object.freeze([
    'quick_reply',
    'cta_url',
    'cta_copy',
    'cta_call',
    'single_select',
    'cta_catalog',
    'cta_reminder',
    'cta_cancel_reminder',
    'address_message',
    'send_location',
    'call_permission_request'
]);

/**
 * @typedef {Object} MessageMetadata
 * @property {{ remoteJid: string, fromMe: boolean, id: string, participant?: string }} key
 * @property {number} messageTimestamp
 * @property {string} [pushName]
 * @property {boolean} broadcast
 * @property {any} message
 * @property {string} id
 * @property {boolean} isBot
 * @property {string} chat
 * @property {boolean} fromMe
 * @property {boolean} isGroup
 * @property {string} sender
 * @property {string} mtype
 * @property {any} msg
 * @property {any} quoted
 * @property {string[]} mentionedJid
 * @property {Function} reply
 * @property {string} text
 */

module.exports = { MEDIA_TYPES, CONTENT_TYPES, NATIVE_FLOW_BUTTONS };
