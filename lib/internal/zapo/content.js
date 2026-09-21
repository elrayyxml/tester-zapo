'use strict';

const { ErrorCode, NexrayError } = require('../../constant');

/**
 * Content adapter: translates high-level (Baileys-style) content into the
 * native zapo `WaSendMessageContent`, builds native send options, and keeps
 * raw `Proto.IMessage` payloads opaque.
 *
 * Contract sources: zapo-1.8.2/src/message/types.ts, context-info.ts,
 * spec/proto/WAProto.proto.
 */

/** Legacy media key -> native zapo `type`. */
const MEDIA_KEYS = Object.freeze({
    image: 'image',
    video: 'video',
    audio: 'audio',
    document: 'document',
    sticker: 'sticker',
    ptv: 'ptv'
});

/** Keys describing the send, never copied onto the media body. */
const OPTION_ONLY_KEYS = Object.freeze([
    'mentions',
    'contextInfo',
    'quoted',
    'ephemeralExpiration',
    'viewOnce',
    'linkPreview'
]);

/** Media fields forwarded to zapo when present (whitelist, so Baileys keys never leak). */
const MEDIA_FIELDS = Object.freeze([
    'caption',
    'mimetype',
    'fileName',
    'fileLength',
    'gifPlayback',
    'ptt',
    'width',
    'height',
    'jpegThumbnail',
    'pageCount',
    'duration',
    'seconds',
    'isAnimated',
    'isLottie',
    'title',
    'waveform',
    'contactName',
    'contextInfo',
    'interactiveAnnotations',
    'annotations',
    'imageSourceType',
    'videoSourceType',
    'accessibilityLabel',
    'motionPhotoPresentationOffsetMs'
]);

/** `ImageMessage.ImageSourceType` / `VideoMessage.VideoSourceType`. */
const IMAGE_SOURCE_TYPE = Object.freeze({ USER_IMAGE: 0, AI_GENERATED: 1, AI_MODIFIED: 2 });
const VIDEO_SOURCE_TYPE = Object.freeze({ USER_VIDEO: 0, AI_GENERATED: 1 });

/** `ContextInfo.PairedMediaType` (motion/paired media). */
const PAIRED_MEDIA = Object.freeze({
    NOT_PAIRED_MEDIA: 0,
    MOTION_PHOTO_PARENT: 5,
    MOTION_PHOTO_CHILD: 6
});

/** Native media type -> root `Message` proto field. */
const MEDIA_ROOT_FIELD = Object.freeze({
    image: 'imageMessage',
    video: 'videoMessage',
    ptv: 'ptvMessage',
    audio: 'audioMessage',
    document: 'documentMessage',
    sticker: 'stickerMessage'
});

/** Root `Message` fields; presence of any marks an object as raw proto. */
const PROTO_ROOT_FIELDS = Object.freeze([
    'conversation',
    'extendedTextMessage',
    'imageMessage',
    'videoMessage',
    'ptvMessage',
    'audioMessage',
    'documentMessage',
    'stickerMessage',
    'stickerPackMessage',
    'contactMessage',
    'contactsArrayMessage',
    'locationMessage',
    'liveLocationMessage',
    'pollCreationMessage',
    'pollCreationMessageV2',
    'pollCreationMessageV3',
    'pollCreationMessageV4',
    'pollCreationMessageV5',
    'pollCreationMessageV6',
    'pollResultSnapshotMessage',
    'pollUpdateMessage',
    'reactionMessage',
    'protocolMessage',
    'eventMessage',
    'buttonsMessage',
    'buttonsResponseMessage',
    'templateMessage',
    'interactiveMessage',
    'listMessage',
    'listResponseMessage',
    'productMessage',
    'orderMessage',
    'albumMessage',
    'botInvokeMessage',
    'messageContextInfo',
    'deviceSentMessage',
    'ephemeralMessage',
    'viewOnceMessage',
    'viewOnceMessageV2',
    'viewOnceMessageV2Extension'
]);

/** Keys zapo's `buildContextInfoProto` understands at the top level. */
const SEND_CONTEXT_KEYS = new Set([
    'quotedMessageId',
    'quotedParticipant',
    'quotedRemoteJid',
    'quotedMessage',
    'isForwarded',
    'forwardingScore',
    'mentionedJids',
    'isSpoiler',
    'expirationSeconds',
    'ephemeralSettingTimestamp',
    'disappearingModeInitiator',
    'disappearingModeTrigger',
    'groupSubject',
    'parentGroupJid',
    'raw'
]);

/**
 * Routes proto-only `ContextInfo` fields under `raw`.
 *
 * zapo's `buildContextInfoProto` maps a fixed set of `WaSendContextInfo` keys
 * and ignores everything else — it only merges arbitrary proto fields through
 * `contextInfo.raw`. Without this, `forwardedNewsletterMessageInfo`, `ai`
 * metadata and `externalAdReply` would silently vanish on high-level sends.
 * @param {object} [ctx]
 */
const normalizeContextInfo = (ctx) => {
    if (!ctx) return ctx;
    const out = {};
    const raw = { ...ctx.raw };
    for (const [key, value] of Object.entries(ctx)) {
        if (key === 'raw') continue;
        if (SEND_CONTEXT_KEYS.has(key)) out[key] = value;
        else raw[key] = value;
    }
    if (Object.keys(raw).length) out.raw = raw;
    return out;
};

const isBytes = (value) =>
    Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof ArrayBuffer;

const isHttpUrl = (value) => typeof value === 'string' && /^https?:\/\//i.test(value);

/** Already uses the native zapo `{ type, ... }` shape. */
const isZapoContent = (content) =>
    !!content && typeof content === 'object' && typeof content.type === 'string' && !isBytes(content);

/** Uses one of the legacy high-level shapes. */
const looksLikeBaileysContent = (content) => {
    if (!content || typeof content !== 'object') return false;
    if (typeof content.text === 'string') return true;
    if (content.poll || content.react || content.reaction) return true;
    if (content.delete || content.revoke || content.edit) return true;
    return Object.keys(MEDIA_KEYS).some((key) => content[key] != null);
};

/**
 * Detects a raw `Proto.IMessage`. Deliberately permissive: once native and
 * Baileys branches fail, any non-empty plain object is treated as opaque proto
 * and forwarded without reinterpretation.
 * @param {unknown} content
 * @returns {boolean}
 */
const isRawProtoMessage = (content) => {
    if (!content || typeof content !== 'object' || isBytes(content)) return false;
    if (typeof content.type === 'string') return false;
    const keys = Object.keys(content);
    if (keys.length === 0) return false;
    if (keys.some((key) => PROTO_ROOT_FIELDS.includes(key))) return true;
    return !looksLikeBaileysContent(content);
};

/**
 * Resolves media to something zapo accepts: bytes stay bytes, a local path
 * stays a path, and an http(s) URL (or `{ url }`) is fetched to a Uint8Array.
 * @param {Buffer|Uint8Array|string|{url:string}} input
 */
const resolveMedia = async (input) => {
    if (input == null) throw new NexrayError(ErrorCode.INVALID_CONTENT, 'media input is required');
    if (isBytes(input)) return input;

    const url = typeof input === 'string' ? input : input.url;
    if (isHttpUrl(url)) {
        const res = await fetch(url);
        if (!res.ok) {
            throw new NexrayError(
                ErrorCode.MEDIA_RESOLVE_FAILED,
                `failed to fetch media ${url}: HTTP ${res.status}`
            );
        }
        return new Uint8Array(await res.arrayBuffer());
    }
    if (typeof url === 'string') return url;

    throw new NexrayError(ErrorCode.MEDIA_RESOLVE_FAILED, `unsupported media input: ${typeof input}`);
};

/** Copies whitelisted media fields off a legacy body. */
const pickBody = (content) =>
    Object.fromEntries(
        MEDIA_FIELDS.filter((key) => content[key] !== undefined && !OPTION_ONLY_KEYS.includes(key)).map(
            (key) => [key, content[key]]
        )
    );

/** Normalizes native content (resolve media, poll options). */
const normalizeNative = async (content) => {
    if (Object.values(MEDIA_KEYS).includes(content.type)) {
        return { ...content, media: await resolveMedia(content.media) };
    }
    if (content.type === 'poll') {
        return {
            ...content,
            options: (content.options ?? []).map((option) =>
                typeof option === 'string' ? { name: option } : option
            )
        };
    }
    if (content.type === 'text' && typeof content.text !== 'string') {
        throw new NexrayError(ErrorCode.INVALID_CONTENT, 'text content requires a string `text`');
    }
    return content;
};

/** Translates one legacy media body to native content. */
const translateMedia = async (key, content) => {
    const type = MEDIA_KEYS[key];
    const body = pickBody(content);
    const media = await resolveMedia(content[key] === true ? content.media : content[key]);

    if (type === 'audio' && content.ptt === true) body.ptt = true;

    const native =
        type === 'video' && (content.ptv === true || content.mediaType === 'ptv')
            ? { type: 'ptv', media, ...body }
            : { type, media, ...body };

    if (content.contextInfo) native.contextInfo = content.contextInfo;
    return native;
};

/** Translates a legacy high-level body. */
const translateLegacy = async (content) => {
    if (typeof content.text === 'string') return { type: 'text', text: content.text };
    if (typeof content.caption === 'string' && !Object.keys(MEDIA_KEYS).some((k) => content[k])) {
        return { type: 'text', text: content.caption };
    }

    for (const key of Object.keys(MEDIA_KEYS)) {
        if (content[key] != null) return translateMedia(key, content);
    }

    if (content.poll) {
        const poll = content.poll;
        return {
            type: 'poll',
            name: poll.name ?? poll.question ?? '',
            options: (poll.options ?? poll.values ?? []).map((option) =>
                typeof option === 'string' ? { name: option } : option
            ),
            selectableCount: poll.selectableCount ?? (poll.multiselect ? 0 : 1),
            allowAddOption: poll.allowAddOption ?? false,
            hideParticipantName: poll.hideParticipantName ?? false
        };
    }
    if (content.react || content.reaction) {
        const react = content.react ?? content.reaction;
        return {
            type: 'reaction',
            emoji: typeof react === 'string' ? react : react.text ?? '',
            target: react.key ?? react.target ?? content.key
        };
    }
    if (content.delete || content.revoke) {
        return { type: 'revoke', target: content.delete ?? content.revoke };
    }
    if (content.pin) return { type: 'pin', target: content.pin };
    if (content.keep) return { type: 'keep', target: content.keep };

    throw new NexrayError(
        ErrorCode.INVALID_CONTENT,
        `unrecognized content shape: ${Object.keys(content).join(', ') || 'empty object'}`
    );
};

/**
 * Translates any supported content to the native zapo contract. Raw proto is
 * returned by reference — never cloned, never renamed.
 * @param {unknown} content
 */
const toZapoContent = async (content) => {
    if (typeof content === 'string') return content;
    if (content == null || typeof content !== 'object') {
        throw new NexrayError(ErrorCode.INVALID_CONTENT, 'content must be a string or object');
    }
    if (isBytes(content)) {
        throw new NexrayError(
            ErrorCode.INVALID_CONTENT,
            'a bare Buffer is not valid content; use { image: buffer } or { document: buffer }'
        );
    }
    if (isZapoContent(content)) return normalizeNative(content);
    if (isRawProtoMessage(content)) return content;
    return translateLegacy(content);
};

/** Merges a contextInfo fragment into native content or a proto payload. */
const withContextInfo = (content, fragment) => {
    if (!fragment || Object.keys(fragment).length === 0) return content;

    if (isZapoContent(content)) {
        return {
            ...content,
            contextInfo: normalizeContextInfo({ ...content.contextInfo, ...fragment })
        };
    }
    if (!content || typeof content !== 'object') return content;

    const next = { ...content };
    for (const [key, value] of Object.entries(next)) {
        if (value && typeof value === 'object' && !isBytes(value) && !Array.isArray(value)) {
            return { ...next, [key]: { ...value, contextInfo: { ...value.contextInfo, ...fragment } } };
        }
    }
    return { ...next, messageContextInfo: { ...next.messageContextInfo, ...fragment } };
};

/** Maps a newsletter config to `ContextInfo.ForwardedNewsletterMessageInfo`. */
const toForwardedNewsletter = (a = {}) => ({
    newsletterJid: a.newsletterJid,
    newsletterName: a.newsletterName,
    accessibilityText: a.accessibilityText,
    contentType: a.contentType,
    ...(a.serverMessageId !== undefined ? { serverMessageId: a.serverMessageId } : {})
});

/**
 * Attaches the AI watermark (`imageSourceType` / `videoSourceType`) when the
 * `ai` flag is on. Only marks media the engine builds from high-level content;
 * raw proto is left to the caller.
 * @param {unknown} content
 */
const applyAiWatermark = (content) => {
    if (!content || typeof content !== 'object') return content;

    if (isZapoContent(content)) {
        if (content.type === 'image') return { ...content, imageSourceType: IMAGE_SOURCE_TYPE.AI_GENERATED };
        if (content.type === 'video' || content.type === 'ptv') {
            return { ...content, videoSourceType: VIDEO_SOURCE_TYPE.AI_GENERATED };
        }
        return content;
    }

    const next = { ...content };
    if (next.imageMessage && !isBytes(next.imageMessage)) {
        next.imageMessage = { ...next.imageMessage, imageSourceType: IMAGE_SOURCE_TYPE.AI_GENERATED };
    }
    if (next.videoMessage && !isBytes(next.videoMessage)) {
        next.videoMessage = { ...next.videoMessage, videoSourceType: VIDEO_SOURCE_TYPE.AI_GENERATED };
    }
    if (next.ptvMessage && !isBytes(next.ptvMessage)) {
        next.ptvMessage = { ...next.ptvMessage, videoSourceType: VIDEO_SOURCE_TYPE.AI_GENERATED };
    }
    return next;
};

/**
 * Builds a media root proto from an upload result plus extra proto fields.
 * @param {string} kind native media type
 * @param {object} upload zapo upload result
 * @param {object} [extra] extra submessage fields (caption, fileName, ...)
 */
const buildMediaProto = (kind, upload, extra = {}) => {
    const field = MEDIA_ROOT_FIELD[kind];
    if (!field) throw new NexrayError(ErrorCode.INVALID_CONTENT, `unknown media kind "${kind}"`);
    return {
        [field]: {
            url: upload.url,
            directPath: upload.directPath,
            mediaKey: upload.mediaKey,
            fileSha256: upload.fileSha256,
            fileEncSha256: upload.fileEncSha256,
            fileLength: upload.fileLength,
            mediaKeyTimestamp: upload.mediaKeyTimestamp,
            ...(upload.mimetype ? { mimetype: upload.mimetype } : {}),
            ...extra
        }
    };
};

/**
 * Applies the global send flags to translated content.
 *
 * - `newsletterAnnotation` -> `contextInfo.forwardedNewsletterMessageInfo`
 * - `ai` -> `contextInfo.forwardedAiBotMessageInfo` + source-type watermark
 *
 * `metaLabel` is applied earlier, in the socket facade, because it needs a
 * `messageContextInfo` root field the engine content types do not expose.
 *
 * @param {unknown} content
 * @param {{newsletterAnnotation?:object, ai?:boolean|object}} [flags]
 */
const applyGlobalFlags = (content, flags = {}) => {
    let next = content;

    if (flags.newsletterAnnotation) {
        const a = flags.newsletterAnnotation;
        next = withContextInfo(next, {
            forwardedNewsletterMessageInfo: {
                newsletterJid: a.newsletterJid,
                newsletterName: a.newsletterName,
                accessibilityText: a.accessibilityText,
                contentType: a.contentType
            }
        });
    }

    if (flags.ai) {
        const a = typeof flags.ai === 'object' ? flags.ai : {};
        next = withContextInfo(next, {
            forwardedAiBotMessageInfo: {
                botName: a.botName || flags.customId || 'Meta AI',
                botJid: a.botJid,
                creatorName: a.creatorName
            }
        });
        next = applyAiWatermark(next);
    }

    return next;
};

/**
 * Builds native `WaSendMessageOptions` from compatibility options.
 * @param {unknown} content native content
 * @param {object} [options]
 */
const buildSendOptions = (content, options = {}) => {
    const out = {};
    const id = options.id ?? options.messageId;
    if (id !== undefined) out.id = id;

    const quote = options.quote ?? options.quoted ?? options.quotedMessage;
    if (quote !== undefined) out.quote = quote;

    if (options.forward !== undefined) out.forward = options.forward;
    if (options.mentions?.length) out.mentions = options.mentions;

    const expiration = options.expirationSeconds ?? options.ephemeralExpiration;
    if (expiration !== undefined) out.expirationSeconds = Number(expiration);

    if (options.viewOnce !== undefined) out.viewOnce = options.viewOnce;
    if (options.editKey !== undefined) out.editKey = options.editKey;
    if (options.contextInfo !== undefined) out.contextInfo = normalizeContextInfo(options.contextInfo);

    for (const key of ['ackTimeoutMs', 'maxAttempts', 'retryDelayMs']) {
        if (options[key] !== undefined) out[key] = options[key];
    }
    return out;
};

module.exports = {
    MEDIA_KEYS,
    OPTION_ONLY_KEYS,
    PROTO_ROOT_FIELDS,
    isRawProtoMessage,
    isZapoContent,
    looksLikeBaileysContent,
    resolveMedia,
    pickBody,
    toZapoContent,
    buildSendOptions,
    applyGlobalFlags,
    withContextInfo,
    normalizeContextInfo,
    applyAiWatermark,
    buildMediaProto,
    IMAGE_SOURCE_TYPE,
    VIDEO_SOURCE_TYPE,
    PAIRED_MEDIA,
    MEDIA_ROOT_FIELD
};
