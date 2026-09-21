'use strict';

const { ErrorCode, NexrayError, createDevlog } = require('../constant');
const { Utils } = require('../utils');
const { installWebSocketPolyfill } = require('../internal/zapo/websocket-polyfill');
const { createSessionStore, resolveEngine } = require('../internal/zapo/store');
const { createBaileysCompatSocket, createLidCache } = require('../internal/zapo/socket');
const { createMediaProcessor } = require('../internal/zapo/mediaProcessor');
const { wireEvents } = require('../internal/zapo/events');
const { attachMessagingHelpers } = require('./messaging');

/** zapo `WaClientOptions` keys forwarded untouched. */
const ENGINE_OPTION_KEYS = new Set([
    'proxy',
    'chatSocketUrls',
    'companionHost',
    'iqTimeoutMs',
    'nodeQueryTimeoutMs',
    'keepAliveIntervalMs',
    'deadSocketTimeoutMs',
    'mediaTimeoutMs',
    'appStateSyncTimeoutMs',
    'signalFetchKeyBundlesTimeoutMs',
    'messageAckTimeoutMs',
    'messageMaxAttempts',
    'messageRetryDelayMs',
    'markOnlineOnConnect',
    'recoverFromClientTooOld',
    'writeBehind',
    'history',
    'chatEvents',
    'privacyToken',
    'addons',
    'logoutStoreClear',
    'media',
    'linkPreview',
    'plugins',
    'testHooks',
    'dangerous',
    'signPasskeyAssertion',
    'deviceBrowser',
    'devicePlatform',
    'deviceOsDisplayName',
    'deviceOsVersion',
    'requireFullSync',
    'version',
    'mobileTransport',
    'url',
    'urls',
    'protocols',
    'connectTimeoutMs',
    'reconnectIntervalMs',
    'timeoutIntervalMs',
    'maxReconnectAttempts'
]);

/** Stealth fingerprints -> engine device identity. */
const STEALTH_PRESETS = Object.freeze({
    ios: { deviceBrowser: 'safari', deviceOsDisplayName: 'iOS', devicePlatform: 'ios' },
    android: { deviceBrowser: 'chrome', deviceOsDisplayName: 'Android', devicePlatform: 'android' },
    web: { deviceBrowser: 'chrome', deviceOsDisplayName: 'Linux', devicePlatform: 'web' },
    desktop: { deviceBrowser: 'chrome', deviceOsDisplayName: 'Windows', devicePlatform: 'desktop' }
});

/**
 * Translates the second constructor argument to real zapo options. Unknown
 * keys are dropped (with a debug trail) rather than passed through blindly.
 * @param {object} zapoOptions
 * @param {Function} devlog
 */
const translateEngineOptions = (zapoOptions = {}, devlog) => {
    const out = {};
    for (const [key, value] of Object.entries(zapoOptions)) {
        if (key === 'store' || key === 'sessionId' || key === 'browser' || key === 'shouldIgnoreJid') {
            continue;
        }
        if (ENGINE_OPTION_KEYS.has(key)) out[key] = value;
        else devlog('client', `dropping unsupported engine option "${key}"`);
    }

    if (Array.isArray(zapoOptions.browser)) {
        const [os, browser, osVersion] = zapoOptions.browser;
        if (os) out.deviceOsDisplayName ??= os;
        if (browser) out.deviceBrowser ??= String(browser).toLowerCase();
        if (osVersion) out.deviceOsVersion ??= osVersion;
    }
    if (zapoOptions.shouldIgnoreJid) {
        devlog('client', 'shouldIgnoreJid is unsupported; use engine.ignoreKey() or filter in handlers');
    }
    return out;
};

/** Validates and returns the public connection options. */
const normalizeOptions = (options = {}) => {
    if (!Array.isArray(options.engines) || options.engines.length === 0) {
        throw new NexrayError(ErrorCode.ENGINE_MISSING, '`engines` is required: pass [zapo]');
    }
    if (typeof options.engines[0]?.WaClient !== 'function') {
        throw new NexrayError(ErrorCode.ENGINE_INVALID, 'engines[0] does not expose WaClient');
    }
    if (!options.create_session) {
        throw new NexrayError(ErrorCode.OPTION_INVALID, '`create_session` is required');
    }
    return options;
};

/**
 * Public Client: owns the lifecycle, builds the store, constructs the engine
 * `WaClient`, and exposes a Baileys-compatible `sock`.
 */
class Client {
    /** @param {object} options `ConnectionOpts` @param {object} [zapoOptions] engine options */
    constructor(options = {}, zapoOptions = {}) {
        this.options = normalizeOptions(options);
        this.devlog = createDevlog(!!this.options.debug);
        this.Config = this.options.setting || {};
        this.Utils = Utils;
        this.engine = resolveEngine(this.options.engines[0]);

        installWebSocketPolyfill();

        this.store = createSessionStore(this.options.create_session, this.engine);
        this.sessionId = this.options.create_session.session || this.options.custom_id || 'default';

        const engineOptions = translateEngineOptions(zapoOptions, this.devlog);
        engineOptions.media ??= { processor: createMediaProcessor(), generateThumbnail: true };
        Object.assign(engineOptions, this.options.stealth ? STEALTH_PRESETS[this.options.stealth] ?? {} : {});

        this.zapo = new this.engine.WaClient({
            store: this.store,
            sessionId: this.sessionId,
            ...engineOptions
        });

        this.lidCache = createLidCache();
        this.sock = createBaileysCompatSocket(this.zapo, {
            contacts: this.options.setting?.contacts || {},
            globalFlags: {
                newsletterAnnotation: this.options.newsletterAnnotation,
                ai: this.options.ai,
                metaLabel: this.options.metaLabel,
                customId: this.options.custom_id
            },
            botPredicate: typeof this.options.bot === 'function' ? this.options.bot : () => false,
            lidCache: this.lidCache
        });
        attachMessagingHelpers(this.sock);

        this.ev = this.sock.ev;
        this.sock.on = this.on.bind(this);
        this.sock.once = this.once.bind(this);
        this.sock.off = this.off.bind(this);

        wireEvents(this.zapo, this.sock, { botPredicate: this.options.bot, lidCache: this.lidCache });
        this._wireConnection();

        if (this.options.autoConnect !== false) {
            setImmediate(() => this.connect().catch(() => {}));
        }
    }

    on(event, listener) {
        this.ev?.on(event, listener);
        return this;
    }

    once(event, listener) {
        this.ev?.once(event, listener);
        return this;
    }

    off(event, listener) {
        this.ev?.off(event, listener);
        return this;
    }

    emit(event, ...args) {
        return this.ev.emit(event, ...args);
    }

    /** True once the session can send messages. */
    sessionReady() {
        return this.sock.sessionReady();
    }

    /** Requests a pairing code and publishes presence once connected. */
    _wireConnection() {
        const { pairing, presence, online } = this.options;

        this.zapo.on('auth_pairing_required', async () => {
            if (!pairing?.state || !pairing.number) return;
            try {
                this.devlog('client', `pairing code: ${await this.sock.requestPairingCode(pairing.number, pairing.code)}`);
            } catch (error) {
                this.ev.emit('error', error);
            }
        });

        this.zapo.on('connection', async (event) => {
            if (event?.status !== 'open' || (!presence && !online)) return;
            try {
                await this.sock.sendPresenceUpdate('available');
            } catch (error) {
                this.devlog('client', `presence update failed: ${error.message}`);
            }
        });
    }

    connect() {
        return this.zapo.connect();
    }

    disconnect() {
        return this.zapo.disconnect();
    }

    logout() {
        return this.zapo.logout();
    }

    /** Disconnects and tears down the store. */
    async destroy() {
        await this.zapo.disconnect().catch(() => {});
        await this.store.destroy?.();
    }

    /** Escape hatch for zapo features without a compatibility mapping. */
    get raw() {
        return this.zapo;
    }
}

module.exports = { Client, ENGINE_OPTION_KEYS, STEALTH_PRESETS, translateEngineOptions, normalizeOptions };
