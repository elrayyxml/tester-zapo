'use strict';

const { EventEmitter } = require('node:events');

const { ErrorCode, NexrayError, unsupported } = require('../../constant');
const {
    toZapoContent,
    buildSendOptions,
    applyGlobalFlags,
    resolveMedia,
    pickBody,
    isRawProtoMessage,
    isZapoContent,
    buildMediaProto,
    MEDIA_KEYS
} = require('./content');

/**
 * Baileys-compatible socket facade over a zapo `WaClient`.
 *
 * Every mapping is explicit and verified against
 * zapo-1.8.2/src/client/coordinators/*. APIs intentionally not mirrored throw
 * a clear error instead of returning `undefined`.
 */

/** LID <-> phone-number cache, fed from group metadata and incoming alt JIDs. */
const createLidCache = () => {
    const lidToPn = new Map();
    const pnToLid = new Map();
    const bare = (jid) => {
        const [user, server = ''] = String(jid).split('@');
        return `${user.split(':')[0]}@${server}`;
    };
    const toPn = (jid) => `${bare(jid).split('@')[0]}@s.whatsapp.net`;

    return {
        remember(lidJid, pnJid) {
            if (!lidJid || !pnJid) return;
            lidToPn.set(bare(lidJid), toPn(pnJid));
            pnToLid.set(toPn(pnJid), bare(lidJid));
        },
        getPn: (jid) => lidToPn.get(bare(jid)) ?? null,
        getLid: (jid) => pnToLid.get(bare(jid)) ?? null,
        size: () => lidToPn.size
    };
};

/**
 * zapo group metadata -> Baileys shape.
 * zapo: `jid` / `isAdmin` / `isSuperAdmin`; Baileys: `id` / `admin`.
 * @param {object} metadata
 * @param {object} [lidCache]
 */
const normalizeGroupMetadata = (metadata, lidCache) => {
    if (!metadata) return metadata;
    const participants = (metadata.participants ?? []).map((p) => {
        lidCache?.remember(p.lid, p.phoneNumber);
        return {
            ...p,
            id: p.jid,
            admin: p.isSuperAdmin ? 'superadmin' : p.isAdmin ? 'admin' : null,
            phoneNumber: p.phoneNumber ?? lidCache?.getPn(p.jid) ?? null
        };
    });

    return {
        ...metadata,
        id: metadata.jid,
        isCommunity: !!metadata.isParentGroup,
        isCommunityAnnounce: !!metadata.generalSubgroup,
        linkedParent: metadata.linkedParentJid,
        participants
    };
};

/** First message-content key (unwraps ephemeral). */
const getContentType = (message) => {
    if (!message || typeof message !== 'object') return undefined;
    if (message.ephemeralMessage?.message) return getContentType(message.ephemeralMessage.message);
    return Object.keys(message)[0];
};

/**
 * Builds the Nexray compatibility `m` metadata from a zapo incoming event.
 * @param {object} event zapo `WaIncomingMessageEvent`
 * @param {(id:string)=>boolean} [isBotId]
 * @param {object} [lidCache]
 */
const buildMessageMetadata = (event, isBotId, lidCache) => {
    const key = event.key ?? {};
    const isGroup = !!key.isGroup || /@g\.us$/.test(String(key.remoteJid));
    if (lidCache && key.remoteJidAlt && key.participantAlt) {
        lidCache.remember(key.participant ?? '', key.participantAlt);
    }

    const message = event.message ?? {};
    const mtype = getContentType(message) ?? 'conversation';
    const msg = message[mtype] ?? {};

    return {
        key: {
            remoteJid: key.remoteJid,
            fromMe: !!key.fromMe,
            id: key.id,
            participant: isGroup ? key.participant : undefined
        },
        messageTimestamp: event.timestampSeconds ?? 0,
        pushName: event.pushName,
        broadcast: !!key.isBroadcast,
        message,
        id: key.id,
        isBot: typeof isBotId === 'function' ? isBotId(key.id) : false,
        chat: key.remoteJid,
        fromMe: !!key.fromMe,
        isGroup,
        isNewsletter: !!key.isNewsletter,
        sender: isGroup ? key.participant ?? key.remoteJid : event.recipientJid || key.remoteJid,
        mtype,
        msg,
        quoted: null,
        mentionedJid: msg.contextInfo?.mentionedJid ?? [],
        text: msg.text ?? msg.caption ?? message.conversation ?? '',
        reply: undefined
    };
};

/** Baileys groupSettingUpdate -> zapo `setSetting(groupJid, setting, enabled)`. */
const GROUP_SETTINGS = Object.freeze({
    announcement: ['announcement', true],
    not_announcement: ['announcement', false],
    locked: ['restrict', true],
    unlocked: ['restrict', false]
});

const PARTICIPANT_ACTIONS = Object.freeze({
    add: 'addParticipants',
    remove: 'removeParticipants',
    promote: 'promoteParticipants',
    demote: 'demoteParticipants'
});

/**
 * Creates the compatibility socket.
 * @param {object} client zapo `WaClient`
 * @param {{contacts?:object, globalFlags?:object, botPredicate?:Function, lidCache?:object}} [deps]
 */
const createBaileysCompatSocket = (client, deps = {}) => {
    const lidCache = deps.lidCache ?? createLidCache();
    const globalFlags = deps.globalFlags ?? {};
    const ev = new EventEmitter();

    /** Moves high-level `content.contextInfo` into send options (proto content bypasses it). */
    const liftContentContext = (content, options) =>
        content?.contextInfo
            ? { ...options, contextInfo: { ...content.contextInfo, ...options.contextInfo } }
            : options;

    /**
     * Rebuilds content as a raw proto carrying
     * `messageContextInfo.botMessageInvokerJid` — the only slot the engine
     * exposes for the business meta label. Media keeps every user field the
     * engine would have copied, and `contextInfo` is lifted into the options.
     */
    const materializeMetaLabel = async (content, options) => {
        const invoker =
            typeof globalFlags.metaLabel === 'object' ? globalFlags.metaLabel.invokerJid : globalFlags.customId;
        const meta = { messageContextInfo: { botMessageInvokerJid: invoker } };

        if (isRawProtoMessage(content)) {
            return { content: { ...content, ...meta }, options };
        }
        if (typeof content === 'string') {
            return { content: { extendedTextMessage: { text: content }, ...meta }, options };
        }
        if (content?.type === 'text') {
            const { contextInfo, ...body } = content;
            return {
                content: { extendedTextMessage: { text: body.text }, ...meta },
                options: liftContentContext({ contextInfo }, options)
            };
        }
        if (content && Object.values(MEDIA_KEYS).includes(content.type) && content.media !== undefined) {
            const upload = await client.message.upload(content.media, {
                type: content.type,
                mimetype: content.mimetype
            });
            return {
                content: { ...buildMediaProto(content.type, upload, pickBody(content)), ...meta },
                options: liftContentContext(content, options)
            };
        }
        return { content, options };
    };

    /**
     * Full translation pipeline: content -> meta label -> global flags.
     *
     * A high-level body's `contextInfo` (including anything the global flags
     * just added) is lifted into the send options: the engine spreads media
     * bodies verbatim onto the proto, so leaving it in place would leak
     * `WaSendContextInfo` fields into the wire context.
     */
    const prepare = async (content, options = {}) => {
        const native = await toZapoContent(content);
        const materialized = globalFlags.metaLabel
            ? await materializeMetaLabel(native, options)
            : { content: native, options };
        const flagged = applyGlobalFlags(materialized.content, globalFlags);

        if (!isZapoContent(flagged)) return { content: flagged, options: materialized.options };

        const { contextInfo, ...body } = flagged;
        return {
            content: body,
            options: contextInfo ? liftContentContext({ contextInfo }, materialized.options) : materialized.options
        };
    };

    const send = async (jid, content, options = {}) => {
        if (content && typeof content === 'object' && (content.photo_live || content.livePhoto)) {
            return sock.sendFile(
                jid,
                content.video ?? content.motion ?? content.media,
                content.fileName ?? 'live-photo.mp4',
                content.caption ?? '',
                options.quoted,
                { ...options, photo_live: true, ...(content.thumbnail ? { thumbnail: content.thumbnail } : {}) }
            );
        }
        const prepared = await prepare(content, options);
        try {
            return await client.message.send(
                jid,
                prepared.content,
                buildSendOptions(prepared.content, prepared.options)
            );
        } catch (error) {
            throw new NexrayError(ErrorCode.UNSUPPORTED_API, `send to ${jid} failed: ${error.message}`, {
                cause: error,
                meta: { jid }
            });
        }
    };

    const sock = {
        zapo: client,
        ev,
        user: null,
        authState: { creds: { registered: false } },
        chats: {},
        contacts: deps.contacts ?? {},
        ws: {
            readyState: 0,
            close() {
                sock.ws.readyState = 3;
                return client.disconnect();
            }
        },
        sessionReady: () => !!client.auth?.getCurrentCredentials?.()?.meJid,

        /* ---------------- Messaging ---------------- */
        sendMessage: send,

        async relayMessage(jid, message, options = {}) {
            if (
                message &&
                typeof message === 'object' &&
                Object.keys(message).some((key) =>
                    /^(image|video|audio|document|sticker|text|caption|poll)$/.test(key)
                )
            ) {
                throw new NexrayError(
                    ErrorCode.INVALID_CONTENT,
                    'relayMessage expects a raw proto payload; use sendMessage for high-level content'
                );
            }
            const prepared = await prepare(message, options);
            return client.message.send(
                jid,
                prepared.content,
                buildSendOptions(prepared.content, prepared.options)
            );
        },

        async readMessages(keys) {
            const byChat = new Map();
            for (const raw of Array.isArray(keys) ? keys : [keys]) {
                const key = raw?.key ?? raw;
                if (!key?.remoteJid || !key.id) continue;
                byChat.set(key.remoteJid, [...(byChat.get(key.remoteJid) ?? []), key.id]);
            }
            for (const [jid, ids] of byChat) {
                await client.message.sendReceipt(jid, ids, { type: 'read' });
            }
        },

        downloadMediaMessage: (source, options) => client.message.downloadBytes(source, options),
        waUploadToServer: (source, options) => client.message.upload(source, options),

        /* ---------------- Groups ---------------- */
        groupMetadata: async (jid) => normalizeGroupMetadata(await client.group.queryGroupMetadata(jid), lidCache),
        groupCreate: async (subject, participants, options) =>
            normalizeGroupMetadata(await client.group.createGroup(subject, participants, options), lidCache),
        groupLeave: (jid) => client.group.leaveGroup([jid]),
        groupInviteCode: (jid) => client.group.queryInviteCode(jid),
        groupRevokeInvite: (jid) => client.group.revokeInvite(jid),
        groupAcceptInvite: async (code) =>
            normalizeGroupMetadata(await client.group.joinGroupViaInvite(code), lidCache),
        groupGetInviteInfo: (code) => client.group.queryGroupInviteInfo(code),
        groupUpdateSubject: (jid, subject) => client.group.setSubject(jid, subject),
        groupUpdateDescription: (jid, description) => client.group.setDescription(jid, description ?? null),
        groupToggleEphemeral: (jid, expiration) =>
            client.group.setEphemeralDuration(jid, Number(expiration) || 0),

        async groupParticipantsUpdate(jid, participants, action) {
            const method = PARTICIPANT_ACTIONS[action];
            if (!method) {
                throw new NexrayError(ErrorCode.OPTION_INVALID, `unknown participant action "${action}"`);
            }
            return client.group[method](jid, participants);
        },

        async groupSettingUpdate(jid, setting) {
            const mapped = GROUP_SETTINGS[setting];
            if (!mapped) {
                throw new NexrayError(ErrorCode.OPTION_INVALID, `unknown group setting "${setting}"`);
            }
            return client.group.setSetting(jid, mapped[0], mapped[1]);
        },

        async groupFetchAllParticipating() {
            const groups = await client.group.queryAllGroups();
            return Object.fromEntries(
                groups.map((group) => [group.jid, normalizeGroupMetadata(group, lidCache)])
            );
        },

        async groupRequestParticipantsList(jid) {
            const requests = await client.group.queryMembershipApprovalRequests(jid);
            return requests.map(({ jid: requestJid, requestor, requestTime, requestMethod }) => ({
                jid: requestJid,
                requestor,
                requestTime,
                requestMethod
            }));
        },

        async groupRequestParticipantsUpdate(jid, participants, action) {
            if (action === 'approve') return client.group.approveMembershipRequests(jid, participants);
            if (action === 'reject') return client.group.rejectMembershipRequests(jid, participants);
            throw new NexrayError(ErrorCode.OPTION_INVALID, `unknown request action "${action}"`);
        },

        /* ---------------- Profile ---------------- */
        async profilePictureUrl(jid, type = 'image') {
            return (await client.profile.getProfilePicture(jid, type))?.url ?? null;
        },

        async updateProfilePicture(jid, media) {
            const resolved = await resolveMedia(media);
            const bytes =
                typeof resolved === 'string'
                    ? new Uint8Array(await require('node:fs/promises').readFile(resolved))
                    : resolved;
            return client.profile.setProfilePicture(bytes, jid === 'self' ? undefined : jid);
        },

        removeProfilePicture: (jid) =>
            client.profile.deleteProfilePicture(jid === 'self' ? undefined : jid),
        updateProfileStatus: (text) => client.profile.setStatus(text),
        updateProfileName: (name) => client.profile.setPushName(name),

        async fetchStatus(jid) {
            return { status: (await client.profile.getStatus(jid))?.status ?? null };
        },

        async onWhatsApp(...jids) {
            const flat = jids.flat();
            const known = new Set((await client.profile.getProfiles(flat)).map((user) => user.jid));
            return flat.map((jid) => ({ jid, exists: known.has(jid) }));
        },

        /* ---------------- Privacy ---------------- */
        async updateBlockStatus(jid, action) {
            if (action === 'block') return client.privacy.blockUser(jid);
            if (action === 'unblock') return client.privacy.unblockUser(jid);
            throw new NexrayError(ErrorCode.OPTION_INVALID, `unknown block action "${action}"`);
        },

        async fetchBlocklist() {
            const { jids } = await client.privacy.getBlocklist();
            return jids;
        },

        /* ---------------- Chat / presence ---------------- */
        async chatModify(mod, jid) {
            const chat = client.chat;
            if (mod.archive !== undefined) return chat.setChatArchive(jid, mod.archive);
            if (mod.pin !== undefined) return chat.setChatPin(jid, mod.pin);
            if (mod.read !== undefined) return chat.setChatRead(jid, mod.read);
            if (mod.lock !== undefined) return chat.setChatLock(jid, mod.lock);
            if (mod.delete === true) return chat.deleteChat(jid);
            if (mod.clear === true) return chat.clearChat(jid);
            if (mod.mute !== undefined) {
                const muted = mod.mute !== null && mod.mute !== 0 && mod.mute !== false;
                const until =
                    typeof mod.mute === 'number' && mod.mute > 0 ? mod.mute : Date.now() + 8 * 3600 * 1000;
                return chat.setChatMute(jid, muted, muted ? until : undefined);
            }
            throw unsupported('chatModify', `no mapping for ${Object.keys(mod).join(', ')}`);
        },

        async sendPresenceUpdate(type, jid) {
            if (type === 'available' || type === 'unavailable') return client.presence.send(type);
            if (!jid) {
                throw new NexrayError(ErrorCode.OPTION_INVALID, `presence "${type}" requires a jid`);
            }
            if (type === 'composing') return client.presence.sendChatstate(jid, { state: 'composing' });
            if (type === 'paused') return client.presence.sendChatstate(jid, { state: 'paused' });
            if (type === 'recording') {
                return client.presence.sendChatstate(jid, { state: 'composing', media: 'audio' });
            }
            throw new NexrayError(ErrorCode.OPTION_INVALID, `unknown presence type "${type}"`);
        },

        /* ---------------- Low level ---------------- */
        query: (node, timeoutMs) => client.lowlevel.query(node, timeoutMs),
        sendNode: (node) => client.lowlevel.sendNode(node),
        logout: () => client.logout(),
        requestPairingCode: (phone, customCode) =>
            client.auth.requestPairingCode(String(phone).replace(/\D/g, ''), true, customCode)
    };

    return sock;
};

module.exports = {
    createBaileysCompatSocket,
    normalizeGroupMetadata,
    buildMessageMetadata,
    getContentType,
    createLidCache,
    GROUP_SETTINGS,
    PARTICIPANT_ACTIONS
};
