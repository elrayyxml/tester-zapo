'use strict';

const { readFile } = require('node:fs/promises');

/**
 * Public Utils API. Every member here is pure or near-pure: it never touches a
 * `WaClient` / socket. Anything that needs a session lives on the Client or
 * the socket facade instead.
 */
const Utils = {};

/**
 * Formats a byte count, or compares it to a threshold.
 *
 * @param {Buffer|Uint8Array|number} input
 * @param {number|null} [thresholdMB]
 * @returns {string|boolean}
 */
Utils.size = (input, thresholdMB = null) => {
    const bytes = Buffer.isBuffer(input) || input instanceof Uint8Array ? input.length : input;

    if (thresholdMB !== null) {
        return bytes > thresholdMB * 1024 * 1024;
    }

    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    if (bytes < 1024 * 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }

    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

/**
 * Resizes any image input to a 300x300 cover JPEG Buffer. `sharp` is an
 * optional dependency: when it is not installed this throws a clear error
 * rather than silently returning the wrong bytes.
 *
 * @param {Buffer|string} input Buffer, URL or local path
 * @returns {Promise<Buffer>}
 */
Utils.sharp = async (input) => {
    let sharp;
    try {
        // eslint-disable-next-line global-require
        sharp = require('sharp');
    } catch (error) {
        throw new Error(`[Utils.sharp] optional dependency 'sharp' is not installed: ${error.message}`);
    }

    let buffer;
    if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
        buffer = Buffer.from(input);
    } else if (Utils.isURL(input)) {
        const res = await fetch(input);
        if (!res.ok) throw new Error(`[Utils.sharp] failed to fetch ${input}: HTTP ${res.status}`);
        buffer = Buffer.from(await res.arrayBuffer());
    } else {
        buffer = await readFile(input);
    }

    return sharp(buffer).resize(300, 300, { fit: 'cover' }).jpeg().toBuffer();
};

/** Returns a random element of `arr`. @template T @param {T[]} arr @returns {T} */
Utils.random = (arr) => arr[Math.floor(Math.random() * arr.length)];

/**
 * Applies a WhatsApp text format.
 * @param {'bold'|'italic'|'strike'|'mono'} font
 * @param {string} text
 * @returns {string}
 */
Utils.texted = (font, text) => {
    const formats = {
        bold: `*${text}*`,
        italic: `_${text}_`,
        strike: `~${text}~`,
        mono: `\`\`\`${text}\`\`\``
    };

    return formats[font] || text;
};

/**
 * Builds a standard "example usage" line.
 * @param {string} prefix
 * @param {string} command
 * @param {string} args
 * @returns {string}
 */
Utils.example = (prefix, command, args) =>
    `• ${Utils.texted('bold', 'Example')} : ${prefix + command} ${args}`;

/** Valid absolute URL (any protocol `URL` accepts). @param {unknown} url */
Utils.isURL = (url) => {
    try {
        // eslint-disable-next-line no-new
        new URL(url);
        return true;
    } catch {
        return false;
    }
};

/** Contains an http(s) URL. @param {string} str */
Utils.isUrlValid = (str) => /https?:\/\/\S+/i.test(String(str));

/** Contains a URL-like token, with or without a scheme. @param {string} str */
Utils.isUrlInText = (str) =>
    /(?:https?:\/\/)?(?:www\.)?[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?:\/[^\s]*)?/g.test(String(str));

/** First http(s) URL in `text`, or null. @param {string} text */
Utils.extractLink = (text) => {
    const matches = String(text).match(/https?:\/\/[^\s]+/g);
    return matches ? matches[0] : null;
};

/**
 * Pretty JSON with circular-reference protection.
 * @param {object|string} data
 * @returns {string}
 */
Utils.jsonFormat = (data) => {
    const seen = new WeakSet();

    const replacer = (_, value) => {
        if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) return '[Circular]';
            seen.add(value);
        }

        return value;
    };

    try {
        const obj = typeof data === 'string' ? JSON.parse(data) : data;
        return JSON.stringify(obj, replacer, 2);
    } catch {
        return String(data);
    }
};

module.exports = { Utils };
