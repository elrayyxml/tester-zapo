'use strict';

const { ErrorCode, NexrayError, unsupported } = require('../constant');
const { resolveMedia, PAIRED_MEDIA } = require('../internal/zapo/content');
const { createMediaProcessor } = require('../internal/zapo/mediaProcessor');

/**
 * High-level messaging helpers (see docs/example.md).
 *
 * Each helper builds either native zapo content or a raw `Proto.IMessage` and
 * hands it to `sock.sendMessage`, so advanced payloads exercise the same
 * raw-proto passthrough path plugins use.
 */

/** `ButtonsMessage.HeaderType` values from spec/proto. */
const HEADER_TYPE = Object.freeze({
    EMPTY: 1,
    TEXT: 2,
    DOCUMENT: 3,
    IMAGE: 4,
    VIDEO: 5,
    LOCATION: 6
});

/** Resolves a quoted source (`m`, `m.quoted`, key) into a zapo quote ref. */
const toQuote = (source) => {
    if (!source) return undefined;
    if (source.fakeObj) return source.fakeObj;
    if (source.key || source.message || source.msg) {
        return { key: source.key, message: source.message ?? source.msg };
    }
    return source;
};

/** Builds a fake quoted message for the *V2/Verify helpers. */
const fakeQuote = (text, title = '') => ({
    key: {
        remoteJid: '0@s.whatsapp.net',
        fromMe: false,
        id: `NEXRAY${Date.now().toString(16).toUpperCase()}`,
        participant: '0@s.whatsapp.net'
    },
    message: {
        extendedTextMessage: { text: title || text, contextInfo: { isForwarded: true, forwardingScore: 999 } }
    }
});

const mimetypeFor = (filename, fallback) => {
    try {
        return require('mime-types').lookup(filename) || fallback;
    } catch {
        return fallback;
    }
};

/** Renders a simple text progress bar. */
const progressBar = (percent, width = 20) => {
    const filled = Math.round((percent / 100) * width);
    return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}] ${percent}%`;
};

/** Still frame defaults: small and low quality, it is only the live photo cover. */
const STILL_DEFAULTS = Object.freeze({ maxEdge: 480, quality: 55 });

/** Grabs the still frame of a live photo clip (or explains why it cannot). */
const extractStillFrame = async (video, options = {}) => {
    const processor = createMediaProcessor({
        jpegQuality: options.stillQuality ?? STILL_DEFAULTS.quality
    });
    const maxEdge = options.stillMaxEdge ?? STILL_DEFAULTS.maxEdge;
    const frame = await processor.generateVideoThumbnail(video, maxEdge).catch(() => null);
    if (!frame?.jpegThumbnail) {
        throw new NexrayError(
            ErrorCode.MEDIA_PROCESSOR_FAILED,
            'photo_live needs a still frame: install fluent-ffmpeg or pass options.thumbnail'
        );
    }
    return frame.jpegThumbnail;
};

/**
 * Sends a live/motion photo: the clip plus the still that tags it.
 *
 * The still (parent) is `options.thumbnail`, or a frame grabbed from the clip.
 * Both halves go out as raw proto (`contextInfo.raw.pairedMediaType`) through
 * the engine's own media path, so upload and encryption stay engine-owned.
 */
const sendLivePhoto = async (sock, jid, source, caption, m, options = {}) => {
    const clip = await resolveMedia(source);
    const stillSource = options.thumbnail ?? options.cover;
    const still = stillSource ? await resolveMedia(stillSource) : await extractStillFrame(clip, options);
    const quoted = toQuote(m);

    const paired = (value) => ({ raw: { pairedMediaType: value } });

    const parent = await sock.sendMessage(
        jid,
        {
            type: 'image',
            media: still,
            mimetype: 'image/jpeg',
            ...(caption ? { caption } : {}),
            contextInfo: paired(PAIRED_MEDIA.MOTION_PHOTO_PARENT)
        },
        { quoted }
    );

    const child = await sock.sendMessage(
        jid,
        {
            type: 'ptv',
            media: clip,
            mimetype: options.mimetype || 'video/mp4',
            contextInfo: paired(PAIRED_MEDIA.MOTION_PHOTO_CHILD)
        },
        { quoted }
    );

    return { parent, child };
};

/** Uploads media and returns an `imageMessage`/`videoMessage` body for a header. */
const uploadInteractiveHeader = async (sock, source, kind, options = {}) => {
    const media = await resolveMedia(source);
    const mimetype = options.mimetype || (kind === 'video' ? 'video/mp4' : 'image/jpeg');
    const upload = await sock.zapo.message.upload(media, { type: kind, mimetype });
    const body = {
        url: upload.url,
        directPath: upload.directPath,
        mediaKey: upload.mediaKey,
        fileSha256: upload.fileSha256,
        fileEncSha256: upload.fileEncSha256,
        fileLength: upload.fileLength,
        mediaKeyTimestamp: upload.mediaKeyTimestamp,
        mimetype: upload.mimetype || mimetype,
        ...(options.caption ? { caption: options.caption } : {})
    };
    return kind === 'video' ? { videoMessage: body } : { imageMessage: body };
};

/** Normalizes share/params input to `{ name, buttonParamsJson }`. */
const normalizeNativeFlowButtons = (buttons = []) =>
    buttons.map((button) => ({
        name: button.name,
        buttonParamsJson:
            typeof button.buttonParamsJson === 'string'
                ? button.buttonParamsJson
                : JSON.stringify(button.params ?? button.buttonParamsJson ?? {})
    }));

/** Builds a vCard string. */
const buildVCard = (contact, options = {}) => {
    const number = String(contact.number || '').replace(/\D/g, '');
    return [
        'BEGIN:VCARD',
        'VERSION:3.0',
        `FN:${contact.name}`,
        `TEL;type=CELL;type=VOICE;waid=${number}:+${number}`,
        contact.about && `NOTE:${contact.about}`,
        options.org && `ORG:${options.org}`,
        options.website && `URL:${options.website}`,
        options.email && `EMAIL:${options.email}`,
        'END:VCARD'
    ]
        .filter(Boolean)
        .join('\n');
};

/** Attaches every messaging helper onto a socket facade. */
const attachMessagingHelpers = (sock) => {
    const api = {
        reply: (jid, text, m, options = {}) => sock.sendMessage(jid, { text }, { quoted: toQuote(m), ...options }),

        sendReact: (jid, emoji, key, options = {}) =>
            sock.sendMessage(jid, { type: 'reaction', emoji, target: toQuote(key) }, options),

        sendProgress: (jid, text, m, percent = 100) =>
            sock.sendMessage(jid, { text: `${text}\n\n${progressBar(percent)}` }, { quoted: toQuote(m) }),

        async sendFile(jid, source, filename = '', caption = '', m, options = {}) {
            const name = filename || `file-${Date.now()}`;
            const mimetype = mimetypeFor(name, options.mimetype || 'application/octet-stream');
            const send = (content, extra) => sock.sendMessage(jid, content, { quoted: toQuote(m), ...extra });

            if (options.document) {
                return send({ type: 'document', media: source, fileName: name, mimetype, caption }, options);
            }
            if (options.ptt || /audio|ogg|mp3|m4a|opus|wav/i.test(mimetype)) {
                return send(
                    {
                        type: 'audio',
                        media: source,
                        mimetype: options.ptt ? 'audio/ogg; codecs=opus' : mimetype,
                        ptt: !!options.ptt,
                        ...(options.APIC ? { jpegThumbnail: options.APIC } : {})
                    },
                    options
                );
            }
            if (options.photo_live) {
                return sendLivePhoto(sock, jid, source, caption, m, options);
            }
            if (options.ptv || options.gif) {
                return send(
                    { type: 'ptv', media: source, mimetype, ...(options.gif ? { gifPlayback: true } : {}) },
                    options
                );
            }
            if (/video/i.test(mimetype)) {
                return send({ type: 'video', media: source, caption, mimetype }, options);
            }
            return send(
                {
                    type: 'image',
                    media: source,
                    caption,
                    mimetype,
                    ...(options.thumbnail ? { jpegThumbnail: options.thumbnail } : {})
                },
                options
            );
        },

        async sendSticker(jid, source, m, options = {}) {
            let media = await resolveMedia(source);
            if ((options.packname || options.author) && Buffer.isBuffer(media)) {
                try {
                    media = await require('../utils/exif').writeExif(media, {
                        packname: options.packname,
                        author: options.author
                    });
                } catch {
                    /* keep the original sticker */
                }
            }
            return sock.sendMessage(
                jid,
                {
                    type: 'sticker',
                    media,
                    mimetype: 'image/webp',
                    isAnimated: !!options.animated,
                    isLottie: !!options.lottie
                },
                { quoted: toQuote(m) }
            );
        },

        sendPoll: (jid, name, options = {}, m) =>
            sock.sendMessage(
                jid,
                {
                    type: 'poll',
                    name,
                    options: (options.options || []).map((option) =>
                        typeof option === 'string' ? { name: option } : { name: option.name }
                    ),
                    selectableCount: options.selectableCount ?? (options.multiselect ? 0 : 1)
                },
                { quoted: toQuote(m) }
            ),

        pollResult: (jid, result = {}, m) =>
            sock.sendMessage(
                jid,
                {
                    pollResultSnapshotMessage: {
                        name: result.name || 'Poll Result',
                        pollVotes: (result.votes || []).map((vote) => ({
                            optionName: vote.name,
                            optionVoteCount: vote.count
                        }))
                    }
                },
                { quoted: toQuote(m) }
            ),

        sendContact: (jid, contacts = [], m, options = {}) =>
            sock.sendMessage(
                jid,
                {
                    contactsArrayMessage: {
                        displayName: options.org || 'Contact',
                        contacts: contacts.map((contact, index) => ({
                            displayName: `${contact.name}${index === 0 && options.org ? ` | ${options.org}` : ''}`,
                            vcard: buildVCard(contact, options)
                        }))
                    }
                },
                { quoted: toQuote(m) }
            ),

        copyNForward(jid, m, options = {}) {
            const message = m?.message ?? m?.msg;
            if (!message) {
                throw new NexrayError(ErrorCode.INVALID_CONTENT, 'copyNForward requires a message payload');
            }
            return sock.sendMessage(jid, message, { forward: true, ...options });
        },

        sendFromAI: (jid, text, m, options = {}) =>
            sock.sendMessage(
                jid,
                { text },
                {
                    quoted: toQuote(m),
                    contextInfo: {
                        forwardedAiBotMessageInfo: {
                            botName: options.botName || options.customId || 'Meta AI',
                            botJid: options.botJid,
                            creatorName: options.creatorName
                        }
                    }
                }
            ),

        /* ---------------- Interactive / native flow ---------------- */

        async sendIAMessage(jid, buttons = [], m, options = {}) {
            const interactive = {
                body: { text: options.content ?? '' },
                nativeFlowMessage: { buttons: normalizeNativeFlowButtons(buttons) },
                ...(options.footer ? { footer: { text: options.footer } } : {}),
                ...(options.header ? { header: { title: options.header } } : {})
            };

            if (options.media) {
                const isVideo = /\.(mp4|mov|webm)/i.test(String(options.media));
                interactive.header = {
                    ...(interactive.header || {}),
                    ...(await uploadInteractiveHeader(sock, options.media, isVideo ? 'video' : 'image')),
                    hasMediaAttachment: true
                };
            }

            return sock.sendMessage(jid, { interactiveMessage: interactive }, { quoted: toQuote(m) });
        },

        replyButton: (jid, buttons = [], m, options = {}) => {
            const headerType = options.media
                ? options.document
                    ? HEADER_TYPE.DOCUMENT
                    : /\.(mp4|mov|webm)/i.test(String(options.media))
                      ? HEADER_TYPE.VIDEO
                      : HEADER_TYPE.IMAGE
                : options.text
                  ? HEADER_TYPE.TEXT
                  : HEADER_TYPE.EMPTY;

            const normalized = buttons.map((button) =>
                button.name && button.params
                    ? {
                          buttonId: '',
                          type: 2,
                          nativeFlowInfo: { name: button.name, paramsJson: JSON.stringify(button.params) }
                      }
                    : {
                          buttonId: button.command,
                          buttonText: { displayText: button.text },
                          type: 1
                      }
            );

            return sock.sendMessage(
                jid,
                {
                    buttonsMessage: {
                        contentText: options.text ?? '',
                        footerText: options.footer ?? '',
                        headerType,
                        buttons: normalized
                    }
                },
                { quoted: toQuote(m) }
            );
        },

        async sendCarousel(jid, cards = [], m, options = {}) {
            const normalized = await Promise.all(
                cards.map(async (card) => {
                    const entry = {
                        body: card.body,
                        nativeFlowMessage: card.nativeFlowMessage,
                        header: card.header
                    };
                    if (typeof card.header?.imageMessage === 'string') {
                        entry.header = {
                            ...card.header,
                            ...(await uploadInteractiveHeader(sock, card.header.imageMessage, 'image')),
                            hasMediaAttachment: true
                        };
                    }
                    return entry;
                })
            );

            return sock.sendMessage(
                jid,
                { interactiveMessage: { body: { text: options.content ?? '' }, carouselMessage: { cards: normalized } } },
                { quoted: toQuote(m) }
            );
        },

        async sendAlbum(jid, items = [], m) {
            const images = items.filter((item) => item.type !== 'video').length;
            await sock.sendMessage(
                jid,
                { albumMessage: { expectedImageCount: images, expectedVideoCount: items.length - images } },
                { quoted: toQuote(m) }
            );
            for (const item of items) {
                await sock.sendMessage(
                    jid,
                    item.type === 'video'
                        ? { type: 'video', media: item.url, caption: item.caption }
                        : { type: 'image', media: item.url, caption: item.caption }
                );
            }
        },

        groupStatus: (jid, content = {}) =>
            sock.zapo.status.send({
                content: content.text
                    ? { type: 'text', text: content.text }
                    : {
                          type: /\.(mp4|mov|webm)/i.test(String(content.media)) ? 'video' : 'image',
                          media: content.media,
                          caption: content.caption
                      },
                recipients: [jid]
            }),

        sendMessageModify: (jid, text, m, options = {}) =>
            sock.sendMessage(
                jid,
                { text },
                {
                    quoted: toQuote(m),
                    contextInfo: {
                        externalAdReply: {
                            title: options.title ?? '',
                            body: options.body ?? text,
                            mediaType: options.largeThumb ? 2 : 1,
                            thumbnailUrl: typeof options.thumbnail === 'string' ? options.thumbnail : undefined,
                            sourceUrl: options.url,
                            renderLargerThumbnail: !!options.largeThumb,
                            showAdAttribution: !!options.ads,
                            ...(Buffer.isBuffer(options.thumbnail) ? { thumbnail: options.thumbnail } : {})
                        }
                    }
                }
            ),

        sendMessageModifyV2: (jid, text, m, options = {}) =>
            api.sendMessageModify(jid, text, m?.key ? m : fakeQuote(text, options.title), options),

        sendMessageVerify: (jid, text, title) =>
            sock.sendMessage(jid, { text }, { quoted: fakeQuote(text, title) }),

        sendMetaMsg: () =>
            unsupported(
                'sendMetaMsg',
                'rich AI/business meta messages require the bot/AI proto pipeline, which is not wired yet'
            )
    };

    Object.assign(sock, api);
    return sock;
};

module.exports = {
    attachMessagingHelpers,
    toQuote,
    fakeQuote,
    progressBar,
    normalizeNativeFlowButtons,
    buildVCard,
    uploadInteractiveHeader,
    HEADER_TYPE
};
