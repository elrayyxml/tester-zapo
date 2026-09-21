'use strict';

const { Client } = require('./core');
const { Utils } = require('./utils');
const { ErrorCode, NexrayError, unsupported } = require('./constant');
const storeAdapters = require('./internal/zapo/store');
const migrate = require('./internal/zapo/migrate');
const { Request, Scraper, updateWAProto } = require('./core/extras');
const types = require('./types');

/**
 * @nexray/lib — Simplicity WhatsApp Bot (zapo-js)
 *
 * CommonJS entry. The ESM bridge (`index.mjs`) re-exports this module's
 * surface as named exports and forwards the whole `zapo-js` namespace.
 */

const engine = () => {
    try {
        // eslint-disable-next-line global-require
        return require('zapo-js');
    } catch {
        return undefined;
    }
};

module.exports = {
    Client,
    default: Client,
    Utils,
    Utilities: Utils,
    createInMemoryStore: (engineOverride) => storeAdapters.createInMemoryStore(engineOverride || engine()),
    createJsonStore: (options, engineOverride) =>
        storeAdapters.createJsonStore(options, engineOverride || engine()),
    createSqliteStore: storeAdapters.createSqliteStore,
    createSessionStore: storeAdapters.createSessionStore,
    migrateBaileysSession: migrate.migrateBaileysSession,
    Request,
    Scraper,
    updateWAProto,
    ErrorCode,
    NexrayError,
    unsupported,
    ...types,
    proto: engine()?.proto
};
