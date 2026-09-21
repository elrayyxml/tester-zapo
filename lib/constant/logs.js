'use strict';

const LEVELS = Object.freeze(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

/**
 * Formats a uniform `[scope] message` prefix. Kept dependency free so it can
 * run before any logger is configured (and inside the websocket polyfill).
 *
 * @param {string} scope
 * @param {string} message
 * @returns {string}
 */
const format = (scope, message) => `[${scope}] ${message}`;

/**
 * Minimal dev logger. Silent unless enabled, so the default runtime stays
 * quiet while `debug: true` gives a translation trail for the adapter layer.
 *
 * @param {boolean} [enabled]
 * @param {(line: string) => void} [sink]
 */
const createDevlog = (enabled = false, sink = console.log) => {
    /** @param {string} scope @param {string} message @param {unknown} [data] */
    const devlog = (scope, message, data) => {
        if (!enabled) return;
        if (data === undefined) sink(format(scope, message));
        else sink(format(scope, message), data);
    };
    devlog.enabled = enabled;
    return devlog;
};

/**
 * Normalizes anything logger-like into the `{ child }` interface zapo expects,
 * falling back to node:console.
 *
 * @param {unknown} logger
 */
const toEngineLogger = (logger) => {
    const base =
        logger && typeof logger.child === 'function'
            ? logger
            : {
                  trace: () => {},
                  debug: () => {},
                  info: () => {},
                  warn: (...a) => console.warn(...a),
                  error: (...a) => console.error(...a),
                  child: () => base
              };
    return base;
};

module.exports = { LEVELS, format, createDevlog, toEngineLogger };
