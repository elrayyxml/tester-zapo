'use strict';

const { buildMessageMetadata } = require('./socket');

/**
 * Event bridge: maps native zapo `WaClient` events onto the compatibility
 * `sock.ev` emitter and keeps facade state (`user`, `ws.readyState`,
 * `authState`) in sync. Native events are also re-emitted verbatim (full pipe).
 */

/** Native zapo events re-emitted verbatim. */
const NATIVE_EVENTS = Object.freeze([
    'auth_qr',
    'auth_pairing_code',
    'auth_pairing_required',
    'auth_paired',
    'auth_passkey_required',
    'connection',
    'message',
    'message_send',
    'message_addon',
    'message_bot_chunk',
    'message_protocol',
    'message_unavailable',
    'receipt',
    'newsletter',
    'newsletter_message_update',
    'presence',
    'chatstate',
    'call',
    'mex_notification',
    'group',
    'business',
    'picture',
    'privacy',
    'blocklist',
    'own_username',
    'mutation',
    'mutation_send',
    'history_sync_chunk',
    'group_history_bundle',
    'offline_resume',
    'offline_thread_metadata',
    'stream_failure',
    'stanza_error',
    'mobile_registration_code',
    'mobile_account_takeover_notice',
    'companion_host_linked',
    'companion_host_revoked',
    'companion_host_error'
]);

/** zapo group action -> compatibility event. */
const GROUP_ACTION_MAP = Object.freeze({
    add: 'group.add',
    remove: 'group.remove',
    promote: 'group.promote',
    demote: 'group.demote',
    create: 'group.create',
    delete: 'group.delete',
    subject: 'group.subject',
    description: 'group.description',
    invite: 'group.invite',
    revoke_invite: 'group.revoke',
    ephemeral: 'group.ephemeral',
    membership_approval_request: 'group.request',
    created_membership_requests: 'group.request',
    revoked_membership_requests: 'group.request',
    linked_group_promote: 'group.promote',
    linked_group_demote: 'group.demote',
    modify: 'group.update'
});

/**
 * Wires engine events into the socket facade.
 * @param {object} client zapo `WaClient`
 * @param {object} sock compatibility socket
 * @param {{botPredicate?:Function, lidCache?:object}} [deps]
 */
const wireEvents = (client, sock, deps = {}) => {
    const { ev } = sock;

    for (const name of NATIVE_EVENTS) {
        client.on(name, (...args) => ev.emit(name, ...args));
    }

    const syncUser = (credentials) => {
        if (!credentials?.meJid) return;
        sock.user = {
            id: credentials.meJid,
            lid: credentials.meLid,
            name: credentials.meDisplayName || credentials.pushName
        };
        sock.authState.creds.registered = true;
    };

    client.on('auth_paired', (event) => {
        syncUser(event?.credentials);
        ev.emit('paired', event);
    });
    client.on('auth_qr', (event) => ev.emit('qr', event?.qr));
    client.on('auth_pairing_code', (event) => ev.emit('pairing-code', event?.code));
    client.on('auth_pairing_required', (event) => ev.emit('pairing-required', event));
    client.on('stream_failure', (event) => ev.emit('error', event));
    client.on('stanza_error', (event) => ev.emit('error', event));

    client.on('connection', (event) => {
        if (event?.status === 'open') {
            sock.ws.readyState = 1;
            syncUser(client.auth?.getCurrentCredentials?.());
            ev.emit('connect', event);
            ev.emit('ready', event);
            return;
        }
        sock.ws.readyState = 0;
        ev.emit('close', event);
        if (event?.isLogout) ev.emit('logout', event);
    });

    client.on('message', (event) => {
        const m = buildMessageMetadata(event, deps.botPredicate, deps.lidCache);
        m.reply = (text, options) => sock.reply?.(m.chat, text, m, options);
        ev.emit('messages.upsert', { messages: [m], type: 'notify' });
        ev.emit('message', m);
    });

    client.on('receipt', (event) => {
        ev.emit('message-receipt.update', event);
        ev.emit('message.receipt', event);
    });

    client.on('message_addon', (event) => {
        if (event?.kind === 'poll_vote' || event?.pollVote) ev.emit('poll', event);
    });

    client.on('group', (event) => {
        const compat = GROUP_ACTION_MAP[event?.action];
        if (!compat) return;
        const payload = {
            id: event.groupJid,
            author: event.authorJid,
            participants: event.participants || [],
            action: event.action,
            raw: event
        };
        ev.emit('group-participants.update', payload);
        ev.emit(compat, payload);
    });

    client.on('presence', (event) => ev.emit('presence.update', event));
    client.on('call', (event) => ev.emit('caller', event));
    client.on('mex_notification', (event) => {
        if (event?.kind === 'lid_change' && deps.lidCache) {
            deps.lidCache.remember(event.newLidJid, event.oldLidJid);
            ev.emit('lid-mapping', event);
        }
    });

    return sock;
};

module.exports = { wireEvents, NATIVE_EVENTS, GROUP_ACTION_MAP };
