'use strict';

/**
 * @typedef {'mongo'|'postgres'|'local'|'mysql'|'sqlite'|'redis'} SessionType
 */

/**
 * Session types that map 1:1 to a `@zapo-js/store-*` backend. `local` is
 * handled by the JSON file backend (`createJsonStore`).
 * @type {ReadonlyArray<SessionType>}
 */
const SESSION_TYPES = Object.freeze(['mongo', 'postgres', 'local', 'mysql', 'sqlite', 'redis']);

/**
 * Stealth device fingerprints accepted by the connection options.
 * @type {ReadonlyArray<string>}
 */
const STEALTH_DEVICES = Object.freeze(['ios', 'android', 'web', 'desktop']);

/**
 * Presence values accepted by `sock.sendPresenceUpdate`.
 * @type {ReadonlyArray<string>}
 */
const PRESENCE_TYPES = Object.freeze(['available', 'unavailable', 'composing', 'recording', 'paused']);

/**
 * Baileys-compatible participant actions mapped to zapo group mutations.
 * @type {ReadonlyArray<string>}
 */
const PARTICIPANT_ACTIONS = Object.freeze(['add', 'remove', 'promote', 'demote']);

/**
 * @typedef {Object} ConnectionOpts
 * @property {boolean} [online]
 * @property {boolean} [presence]
 * @property {boolean} [bypass_disappearing]
 * @property {boolean} [server]
 * @property {((id: string) => boolean)} [bot]
 * @property {string} [stealth]
 * @property {string} custom_id
 * @property {{ state: boolean, number: string, code?: string }} [pairing]
 * @property {boolean} [multiple]
 * @property {{ type: SessionType, session: string, config?: any, number?: string|number, owner?: string|number }} [create_session]
 * @property {any} [setting]
 * @property {any[]} engines
 * @property {boolean} [debug]
 * @property {{ newsletterJid: string, newsletterName: string, accessibilityText: string, contentType: number }} [newsletterAnnotation]
 * @property {boolean} [metaLabel]
 * @property {boolean} [ai]
 */

module.exports = {
    SESSION_TYPES,
    STEALTH_DEVICES,
    PRESENCE_TYPES,
    PARTICIPANT_ACTIONS
};
