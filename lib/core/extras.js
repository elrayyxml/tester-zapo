'use strict';

/**
 * Legacy public extras kept for API stability with the previous major.
 *
 * These are intentionally dependency-light. `Utilities` is exported by the
 * package entry as an alias of `Utils`.
 */

/** Lazily resolves the installed engine, if any. */
const optionalEngine = () => {
    try {
        // eslint-disable-next-line global-require
        return require('zapo-js');
    } catch {
        return undefined;
    }
};

/**
 * Minimal HTTP client used by legacy plugins.
 *
 * @param {string} url
 * @param {{ method?: string, headers?: object, body?: any, timeoutMs?: number, json?: boolean, ...rest: any }} [options]
 */
const Request = (url, options = {}) => {
    const { method = 'GET', headers = {}, body, timeoutMs = 30_000, json = false } = options;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    return fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : json ? JSON.stringify(body) : body,
        signal: controller.signal
    })
        .then(async (res) => {
            const text = await res.text();
            let data = text;
            try {
                data = JSON.parse(text);
            } catch {
                /* keep text */
            }
            return { status: res.status, ok: res.ok, headers: res.headers, data };
        })
        .finally(() => clearTimeout(timer));
};

/**
 * Small scraping helper: fetches a page and exposes regex-based extractors.
 * Heavy DOM parsing is deliberately left to plugins.
 *
 * @param {string} url
 * @param {{ timeoutMs?: number }} [options]
 */
const Scraper = (url, options = {}) => ({
    async fetch() {
        const res = await fetch(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 30_000) });
        return res.text();
    },
    async text() {
        const html = await this.fetch();
        return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    },
    async title() {
        const html = await this.fetch();
        return html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? null;
    },
    async meta(property) {
        const html = await this.fetch();
        return (
            html.match(
                new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]*content=["']([^"']*)["']`, 'i')
            )?.[1]?.trim() ?? null
        );
    }
});

/**
 * Returns the engine proto (or updates a cached reference).
 *
 * zapo generates its proto definitions at build time; this hook exists so the
 * public surface matches the package contract and so callers can pin a proto
 * namespace they loaded themselves.
 *
 * @param {object} [protoNamespace]
 * @returns {object|undefined}
 */
let cachedProto = optionalEngine()?.proto;
const updateWAProto = (protoNamespace) => {
    if (protoNamespace !== undefined) cachedProto = protoNamespace;
    return cachedProto;
};

module.exports = { Request, Scraper, updateWAProto };
