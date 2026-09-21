'use strict';

const { Readable } = require('node:stream');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

const { ErrorCode, NexrayError } = require('../../constant');

/**
 * `WaMediaProcessor` implementation for zapo.
 *
 * zapo never generates chat thumbnails itself — it delegates to this. Missing
 * optional tooling degrades to `null` rather than aborting a send.
 * Interface: zapo-1.8.2/src/media/processor.ts.
 */

const loadSharp = () => {
    try {
        return require('sharp');
    } catch {
        return null;
    }
};

const loadFfmpeg = () => {
    try {
        const ffmpeg = require('fluent-ffmpeg');
        try {
            const installer = require('@ffmpeg-installer/ffmpeg');
            if (installer?.path) ffmpeg.setFfmpegPath(installer.path);
        } catch {
            /* use system ffmpeg */
        }
        return ffmpeg;
    } catch {
        return null;
    }
};

/** Normalizes any processor input to a Buffer. */
const toBuffer = async (input) => {
    if (typeof input === 'string') return fsp.readFile(input);
    if (Buffer.isBuffer(input)) return input;
    if (input instanceof Uint8Array) return Buffer.from(input);
    if (input instanceof Readable) {
        const chunks = [];
        for await (const chunk of input) chunks.push(chunk);
        return Buffer.concat(chunks);
    }
    throw new NexrayError(ErrorCode.MEDIA_PROCESSOR_FAILED, 'unsupported media input');
};

/** Minimal magic-byte detection (no dependency). */
const sniffMimetype = (buffer) => {
    if (buffer.length < 12) return null;
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
    if (buffer[0] === 0x89 && buffer.toString('ascii', 1, 4) === 'PNG') return 'image/png';
    if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
        return 'image/webp';
    }
    if (buffer.toString('ascii', 4, 8) === 'ftyp') {
        return buffer.toString('ascii', 8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4';
    }
    if (buffer.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
    if (buffer.toString('ascii', 0, 3) === 'ID3') return 'audio/mpeg';
    if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return 'audio/mpeg';
    if (buffer.toString('ascii', 0, 4) === '%PDF') return 'application/pdf';
    return null;
};

/** Grabs a single video frame to a temp JPEG (or null). */
const grabVideoFrame = (input) =>
    new Promise((resolve) => {
        const ffmpeg = loadFfmpeg();
        if (!ffmpeg) return resolve(null);
        const out = path.join(os.tmpdir(), `nexray-frame-${Date.now()}.jpg`);
        const source =
            Buffer.isBuffer(input) || input instanceof Uint8Array
                ? Readable.from(Buffer.from(input))
                : input.path || input;
        ffmpeg(source)
            .on('end', () =>
                fs.readFile(out, (error, data) => {
                    fs.rm(out, { force: true }, () => {});
                    resolve(error ? null : data);
                })
            )
            .on('error', () => resolve(null))
            .screenshots({
                count: 1,
                timemarks: ['00:00:01.000'],
                filename: path.basename(out),
                folder: path.dirname(out)
            });
    });

/**
 * Builds a processor usable as zapo's `media.processor`.
 * @param {{jpegQuality?:number}} [options]
 */
const createMediaProcessor = (options = {}) => {
    const quality = options.jpegQuality ?? 60;

    const resizeJpeg = async (buffer, maxEdge) => {
        const sharp = loadSharp();
        if (!sharp) return null;
        const meta = await sharp(buffer).metadata();
        const jpeg = await sharp(buffer)
            .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality })
            .toBuffer();
        return { jpegThumbnail: new Uint8Array(jpeg), width: meta.width ?? 0, height: meta.height ?? 0 };
    };

    const requireSharp = () => {
        const sharp = loadSharp();
        if (!sharp) {
            throw new NexrayError(ErrorCode.MEDIA_PROCESSOR_FAILED, 'sharp is required for image thumbnails');
        }
        return sharp;
    };

    return {
        async generateImageThumbnail(input, maxEdge) {
            requireSharp();
            try {
                const result = await resizeJpeg(await toBuffer(input), maxEdge);
                return result;
            } catch (error) {
                if (error instanceof NexrayError) throw error;
                throw new NexrayError(ErrorCode.MEDIA_PROCESSOR_FAILED, error.message, { cause: error });
            }
        },

        async generateVideoThumbnail(input, maxEdge) {
            const frame = await grabVideoFrame(input);
            return frame ? resizeJpeg(frame, maxEdge).catch(() => null) : null;
        },

        async probeMedia(input) {
            const ffmpeg = loadFfmpeg();
            if (!ffmpeg) return {};
            return new Promise((resolve) => {
                ffmpeg.ffprobe(input, (error, data) => {
                    const video = data?.streams?.find((stream) => stream.codec_type === 'video');
                    resolve({
                        durationSeconds: data?.format?.duration ? Number(data.format.duration) : undefined,
                        width: video?.width,
                        height: video?.height
                    });
                });
            });
        },

        computeWaveform: async () => null,

        async normalizeVoiceNote(input) {
            const ffmpeg = loadFfmpeg();
            if (!ffmpeg) return null;
            const out = path.join(os.tmpdir(), `nexray-voice-${Date.now()}.ogg`);
            const source = typeof input === 'string' ? input : await toBuffer(input);
            await new Promise((resolve, reject) =>
                ffmpeg(source)
                    .audioCodec('libopus')
                    .format('ogg')
                    .on('end', resolve)
                    .on('error', reject)
                    .save(out)
            ).catch(() => null);
            try {
                return Readable.from(await fsp.readFile(out));
            } catch {
                return null;
            } finally {
                await fsp.rm(out, { force: true });
            }
        },

        async generateStickerThumbnail(input, maxEdge) {
            const sharp = requireSharp();
            const buffer = await toBuffer(input);
            const meta = await sharp(buffer).metadata();
            const png = await sharp(buffer)
                .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
                .png()
                .toBuffer();
            return { pngThumbnail: new Uint8Array(png), width: meta.width ?? 0, height: meta.height ?? 0 };
        },

        async detectMimetype(input) {
            try {
                if (typeof input === 'string') return require('mime-types').lookup(input) || null;
                return sniffMimetype(Buffer.from(input));
            } catch {
                return null;
            }
        }
    };
};

module.exports = { createMediaProcessor, sniffMimetype, toBuffer };
