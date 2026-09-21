'use strict';

/**
 * Global WebSocket polyfill.
 *
 * zapo-js resolves `globalThis.WebSocket` during client construction. Node 20
 * does not expose a stable global implementation, so the `ws` package is
 * installed here. This module MUST be required before `new WaClient(...)`.
 *
 * `ws` is optional: if it is not installed we leave the environment untouched
 * and report whether a usable implementation exists.
 */

let installed = false;

/**
 * Installs the polyfill if (and only if) no global WebSocket is present.
 * @param {{ WebSocket?: unknown }} [target]
 * @returns {{ installed: boolean, source: string }}
 */
const installWebSocketPolyfill = (target = globalThis) => {
    if (typeof target.WebSocket !== 'undefined') {
        return { installed: false, source: 'global' };
    }

    let WebSocket;
    try {
        // eslint-disable-next-line global-require
        ({ WebSocket } = require('ws'));
    } catch (error) {
        return { installed: false, source: `missing:${error.code || 'ws'}` };
    }

    target.WebSocket = WebSocket;
    installed = true;
    return { installed: true, source: 'ws' };
};

module.exports = { installWebSocketPolyfill, get installed() { return installed; } };
