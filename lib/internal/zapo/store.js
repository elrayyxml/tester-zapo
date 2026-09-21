'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { ErrorCode, NexrayError } = require('../../constant');

/**
 * Store adapter: resolves `create_session` into a real zapo `createStore()`
 * configuration. Every backend is a genuine `WaStoreBackend` bundle; no fake
 * session abstraction is introduced.
 */

/** Lazily resolves the engine, falling back to the installed `zapo-js`. */
const resolveEngine = (engine) => {
    if (engine && typeof engine.createStore === 'function') return engine;
    try {
        // eslint-disable-next-line global-require
        return require('zapo-js');
    } catch (error) {
        throw new NexrayError(
            ErrorCode.ENGINE_MISSING,
            'no engine provided and `zapo-js` is not installed',
            { cause: error }
        );
    }
};

/**
 * Resolves the memory store classes. The package root only re-exports
 * `WaAuthMemoryStore`; the full set lives under the `zapo-js/store` subpath.
 */
const resolveStoreModule = () => {
    try {
        // eslint-disable-next-line global-require
        return require('zapo-js/store');
    } catch (error) {
        throw new NexrayError(
            ErrorCode.STORE_BACKEND_MISSING,
            'the in-memory store classes require the `zapo-js/store` entry point',
            { cause: error }
        );
    }
};

/** Persistent domains that a backend may provide. */
const PERSISTENT_DOMAINS = Object.freeze([
    'auth',
    'signal',
    'preKey',
    'session',
    'identity',
    'senderKey',
    'appState',
    'messages',
    'threads',
    'contacts',
    'privacyToken'
]);

/**
 * Builds an all-memory backend bundle from the engine's exported memory stores.
 * @param {object} engine
 */
const createInMemoryStore = (engine) => {
    void resolveEngine(engine);
    const e = resolveStoreModule();
    return {
        stores: {
            auth: () => new e.WaAuthMemoryStore(),
            signal: () => new e.WaSignalMemoryStore(),
            preKey: () => new e.WaPreKeyMemoryStore(),
            session: () => new e.WaSessionMemoryStore(),
            identity: () => new e.WaIdentityMemoryStore(),
            senderKey: () => new e.SenderKeyMemoryStore(),
            appState: () => new e.WaAppStateMemoryStore(),
            messages: () => new e.WaMessageMemoryStore(),
            threads: () => new e.WaThreadMemoryStore(),
            contacts: () => new e.WaContactMemoryStore(),
            privacyToken: () => new e.WaPrivacyTokenMemoryStore()
        },
        caches: {
            retry: () => new e.WaRetryMemoryStore(),
            groupMetadata: () => new e.WaGroupMetadataMemoryStore(),
            chatMetadata: () => new e.WaChatMetadataMemoryStore(),
            deviceList: () => new e.WaDeviceListMemoryStore(),
            messageSecret: () => new e.WaMessageSecretMemoryStore()
        }
    };
};

/* ------------------------------------------------------------------ *
 * JSON backend (auth-domain persistence)
 * ------------------------------------------------------------------ */

/** Encodes typed arrays so credentials survive a JSON round-trip. */
const jsonReplacer = (_key, value) => {
    if (Buffer.isBuffer(value)) {
        return { __type: 'Buffer', data: value.toString('base64') };
    }
    if (value instanceof Uint8Array) {
        return { __type: 'Uint8Array', data: Buffer.from(value).toString('base64') };
    }
    if (typeof value === 'bigint') {
        return { __type: 'BigInt', data: value.toString() };
    }
    return value;
};

const jsonReviver = (_key, value) => {
    if (value && typeof value === 'object' && typeof value.__type === 'string') {
        if (value.__type === 'Buffer') return Buffer.from(value.data, 'base64');
        if (value.__type === 'Uint8Array') return new Uint8Array(Buffer.from(value.data, 'base64'));
        if (value.__type === 'BigInt') return BigInt(value.data);
    }
    return value;
};

const readJsonFile = async (file) => {
    try {
        const raw = await fsp.readFile(file, 'utf-8');
        return JSON.parse(raw, jsonReviver);
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
};

const writeJsonFile = async (file, data) => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data, jsonReplacer, 2), 'utf-8');
    await fsp.rename(tmp, file);
};

/**
 * `WaAuthStore` that persists credentials to a JSON file. All other domains
 * stay in memory — matching the historical "local session" semantics.
 */
class JsonAuthStore {
    /** @param {object} storeModule zapo `zapo-js/store` namespace @param {string} file */
    constructor(storeModule, file) {
        this.file = file;
        this.memory = new storeModule.WaAuthMemoryStore();
        this.hydrated = false;
    }

    async hydrate() {
        if (this.hydrated) return;
        const fromDisk = await readJsonFile(this.file);
        if (fromDisk) await this.memory.save(fromDisk);
        this.hydrated = true;
    }

    async load() {
        await this.hydrate();
        return this.memory.load();
    }

    async save(credentials) {
        await this.memory.save(credentials);
        await writeJsonFile(this.file, credentials);
    }

    async clear() {
        await this.memory.clear();
        await fsp.rm(this.file, { force: true });
    }

    async destroy() {
        await this.clear();
    }
}

/**
 * JSON-backed backend bundle. Persists credentials under
 * `<sessionDir>/auth.json`; every other domain uses the engine's memory
 * stores.
 *
 * @param {{ path?: string, sessionDir?: string }} [options]
 * @param {object} [engine]
 */
const createJsonStore = (options = {}, engine) => {
    const e = resolveEngine(engine);
    const dir = options.sessionDir || options.path || '.auth';
    const file = path.join(dir, 'auth.json');
    const memory = createInMemoryStore(e);
    const storeModule = resolveStoreModule();

    return {
        stores: {
            ...memory.stores,
            auth: () => new JsonAuthStore(storeModule, file)
        },
        caches: memory.caches
    };
};

/**
 * SQLite backend, delegated to `@zapo-js/store-sqlite`.
 * @param {object} options `WaSqliteStoreConfig`
 */
const createSqliteStore = (options = {}) => {
    let pkg;
    try {
        // eslint-disable-next-line global-require
        pkg = require('@zapo-js/store-sqlite');
    } catch (error) {
        throw new NexrayError(
            ErrorCode.STORE_BACKEND_MISSING,
            'session type "sqlite" requires the @zapo-js/store-sqlite package',
            { cause: error }
        );
    }
    return pkg.createSqliteStore(options);
};

/** Map of session type -> backend package name. */
const BACKEND_PACKAGES = Object.freeze({
    postgres: '@zapo-js/store-postgres',
    mysql: '@zapo-js/store-mysql',
    redis: '@zapo-js/store-redis',
    mongo: '@zapo-js/store-mongo'
});

/** Builds the provider map that routes every persistent domain to `name`. */
const buildProviders = (name, only = PERSISTENT_DOMAINS) =>
    only.reduce((providers, domain) => {
        providers[domain] = name;
        return providers;
    }, {});

/**
 * Resolves `create_session` into a live zapo `WaStore`.
 *
 * @param {{ type?: string, session?: string, config?: any }} createSession
 * @param {object} engine
 * @returns {object} zapo WaStore
 */
const createSessionStore = (createSession = {}, engine) => {
    const e = resolveEngine(engine);
    const type = createSession.type || 'local';
    const session = createSession.session || 'session';

    if (type === 'local') {
        return e.createStore({
            backends: { json: createJsonStore({ sessionDir: session }, e) },
            providers: buildProviders('json')
        });
    }

    if (type === 'sqlite') {
        const backend = createSqliteStore({ path: createSession.config || `${session}.sqlite` });
        return e.createStore({
            backends: { sqlite: backend },
            providers: buildProviders('sqlite')
        });
    }

    const pkgName = BACKEND_PACKAGES[type];
    if (!pkgName) {
        throw new NexrayError(
            ErrorCode.SESSION_TYPE_UNSUPPORTED,
            `unknown session type "${type}"`,
            { meta: { supported: ['local', 'sqlite', ...Object.keys(BACKEND_PACKAGES)] } }
        );
    }

    let pkg;
    try {
        // eslint-disable-next-line global-require
        pkg = require(pkgName);
    } catch (error) {
        throw new NexrayError(
            ErrorCode.STORE_BACKEND_MISSING,
            `session type "${type}" requires the ${pkgName} package`,
            { cause: error }
        );
    }

    const factory = pkg[`create${type[0].toUpperCase()}${type.slice(1)}Store`];
    if (typeof factory !== 'function') {
        throw new NexrayError(
            ErrorCode.STORE_BACKEND_MISSING,
            `${pkgName} does not export a store factory for "${type}"`
        );
    }

    const config =
        typeof createSession.config === 'object'
            ? createSession.config
            : { connectionString: createSession.config };
    return e.createStore({
        backends: { [type]: factory(config) },
        providers: buildProviders(type)
    });
};

module.exports = {
    PERSISTENT_DOMAINS,
    resolveEngine,
    resolveStoreModule,
    createInMemoryStore,
    createJsonStore,
    createSqliteStore,
    createSessionStore,
    buildProviders,
    JsonAuthStore,
    jsonReplacer,
    jsonReviver
};
