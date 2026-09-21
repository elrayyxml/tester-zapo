'use strict';

const { Utils } = require('./utils');

/**
 * Link preview helper: fetches a page and extracts Open Graph fields plus the
 * og:image bytes. Uses the global `fetch` (Node >= 20) so no extra dependency
 * is required. Never throws on a missing field — callers get `null`s.
 */

/** Extracts a `<meta property="..." content="...">` value. */
const metaContent = (html, property) => {
    const pattern = new RegExp(
        `<meta[^>]+(?:property|name)=["']${property}["'][^>]*content=["']([^"']*)["']`,
        'i'
    );
    const match = html.match(pattern);
    return match ? match[1].trim() : null;
};

/**
 * Resolves Open Graph metadata for a URL.
 * @param {string} url
 * @param {{ timeoutMs?: number, fetch?: typeof fetch }} [options]
 * @returns {Promise<{ url: string, title: string|null, description: string|null, siteName: string|null, imageUrl: string|null }>}
 */
const resolveLinkPreview = async (url, options = {}) => {
    if (!Utils.isURL(url)) throw new Error(`[link-preview] invalid URL: ${url}`);

    const fetchImpl = options.fetch || fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);

    try {
        const res = await fetchImpl(url, { signal: controller.signal });
        const html = await res.text();
        const image = metaContent(html, 'og:image');
        return {
            url,
            title: metaContent(html, 'og:title') || (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? null),
            description: metaContent(html, 'og:description'),
            siteName: metaContent(html, 'og:site_name'),
            imageUrl: image ? new URL(image, url).toString() : null
        };
    } finally {
        clearTimeout(timer);
    }
};

/**
 * Downloads the preview thumbnail as a Buffer (or null when unavailable).
 * @param {string} url
 * @param {{ timeoutMs?: number, fetch?: typeof fetch }} [options]
 * @returns {Promise<Buffer|null>}
 */
const fetchThumbnail = async (url, options = {}) => {
    if (!url) return null;
    const fetchImpl = options.fetch || fetch;
    try {
        const res = await fetchImpl(url);
        if (!res.ok) return null;
        return Buffer.from(await res.arrayBuffer());
    } catch {
        return null;
    }
};

module.exports = { resolveLinkPreview, fetchThumbnail, metaContent };
