'use strict';

const { randomUUID } = require('node:crypto');

/**
 * Sticker pack payload builder.
 *
 * Produces the shape zapo expects for `WaSendStickerPackMessage`
 * (`{ type: 'sticker-pack', ... }`). It deliberately does NOT fill the fields
 * the zapo media builder owns (`thumbnailDirectPath`, `stickerPackSize`, …) —
 * guessing those corrupts the upload.
 */

/**
 * Normalizes one sticker input. `media` may be a Buffer, a Uint8Array, a local
 * path, or an http(s) URL (left as a string for the engine to resolve).
 *
 * @param {{ media: Buffer|Uint8Array|string, fileName?: string, emojis?: string[], isAnimated?: boolean, isLottie?: boolean, mimetype?: string }} sticker
 */
const normalizeSticker = (sticker) => {
    if (!sticker || sticker.media === undefined) {
        throw new Error('[sticker-pack] each sticker requires a `media` field');
    }
    return {
        media: sticker.media,
        fileName: sticker.fileName || `sticker-${randomUUID()}.webp`,
        emojis: sticker.emojis && sticker.emojis.length ? sticker.emojis : ['🙂'],
        isAnimated: sticker.isAnimated ?? false,
        isLottie: sticker.isLottie ?? false,
        ...(sticker.mimetype ? { mimetype: sticker.mimetype } : {})
    };
};

/**
 * Builds the native zapo sticker-pack content.
 *
 * @param {Array<object>} stickers
 * @param {{ name: string, publisher: string, stickerPackId?: string, trayIcon?: { media: any, fileName?: string }, coverThumbnail?: Buffer|string, contextInfo?: object }} options
 * @returns {object} `WaSendStickerPackMessage`
 */
const buildStickerPack = (stickers, options = {}) => {
    if (!Array.isArray(stickers) || stickers.length === 0) {
        throw new Error('[sticker-pack] at least one sticker is required');
    }
    if (!options.trayIcon || options.trayIcon.media === undefined) {
        throw new Error('[sticker-pack] a trayIcon { media } is required');
    }

    return {
        type: 'sticker-pack',
        stickerPackId: options.stickerPackId || randomUUID(),
        name: options.name || 'Sticker by',
        publisher: options.publisher || '@nexray/lib',
        stickers: stickers.map(normalizeSticker),
        trayIcon: {
            media: options.trayIcon.media,
            fileName: options.trayIcon.fileName || 'tray-icon.png'
        },
        ...(options.coverThumbnail ? { coverThumbnail: options.coverThumbnail } : {}),
        ...(options.contextInfo ? { contextInfo: options.contextInfo } : {})
    };
};

module.exports = { buildStickerPack, normalizeSticker };
