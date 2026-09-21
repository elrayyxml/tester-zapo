'use strict';

/**
 * Sticker EXIF metadata helper.
 *
 * WhatsApp reads a small EXIF blob embedded in the WebP container to display
 * the sticker pack name / publisher. `node-webpmux` is an optional dependency;
 * when it is missing the helpers degrade to a clear error instead of corrupting
 * the sticker.
 */

/** Lazily loads node-webpmux. */
const loadWebp = () => {
    try {
        // eslint-disable-next-line global-require
        return require('node-webpmux');
    } catch (error) {
        throw new Error(`[exif] optional dependency 'node-webpmux' is not installed: ${error.message}`);
    }
};

/** Serializes `{ 'sticker-pack-id', name, publisher, emojis }` to a JSON Buffer. */
const buildExifPayload = ({ packId, packname = '', author = '', categories = [''] }) => {
    const json = {
        'sticker-pack-id': packId,
        'sticker-pack-name': packname,
        'sticker-pack-publisher': author,
        emojis: categories
    };
    let jsonBuffer = Buffer.from(JSON.stringify(json), 'utf-8');
    const exifAttr = Buffer.from([
        0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00
    ]);
    const jsonBuff = Buffer.alloc(4);
    jsonBuff.writeUInt32LE(jsonBuffer.length, 0);
    return Buffer.concat([exifAttr, jsonBuff, jsonBuffer]);
};

/**
 * Reads the embedded EXIF blob from a WebP sticker.
 * @param {Buffer} buffer
 * @returns {Promise<object|null>}
 */
const readExif = async (buffer) => {
    const { Image } = loadWebp();
    const img = new Image();
    await img.load(buffer);
    if (!img.exif) return null;
    try {
        return JSON.parse(img.exif.slice(22).toString());
    } catch {
        return null;
    }
};

/**
 * Writes pack metadata into a WebP buffer, returning a new WebP Buffer.
 * @param {Buffer} buffer
 * @param {{ packname?: string, author?: string, categories?: string[], packId?: string }} [metadata]
 * @returns {Promise<Buffer>}
 */
const writeExif = async (buffer, metadata = {}) => {
    const { Image } = loadWebp();
    const img = new Image();
    await img.load(buffer);
    img.exif = buildExifPayload({
        packId: metadata.packId || (globalThis.crypto?.randomUUID?.() ?? String(Date.now())),
        packname: metadata.packname,
        author: metadata.author,
        categories: metadata.categories
    });
    return img.save(null);
};

module.exports = { buildExifPayload, readExif, writeExif };
