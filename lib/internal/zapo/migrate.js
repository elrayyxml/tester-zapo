'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { ErrorCode, NexrayError } = require('../../constant');
const { jsonReplacer, jsonReviver } = require('./store');

/**
 * Auth-state migration: converts a Baileys multi-file session into a zapo
 * store without re-pairing. Purely local — never opens a WhatsApp socket.
 *
 * Signal key conversion is delegated to a pluggable `converter`; the built-in
 * one maps the directly-compatible credential fields only.
 */

const readJson = async (file) => {
    try {
        return JSON.parse(await fsp.readFile(file, 'utf-8'), jsonReviver);
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw new NexrayError(ErrorCode.MIGRATION_INVALID_SOURCE, `cannot read ${file}: ${error.message}`, {
            cause: error
        });
    }
};

const writeJson = async (file, data) => {
    await fsp.writeFile(file, JSON.stringify(data, jsonReplacer, 2), 'utf-8');
};

/** True when `sessionDir` looks like a Baileys session (has creds.json). */
const hasBaileysCreds = (sessionDir) => fs.existsSync(path.join(sessionDir, 'creds.json'));

/** True when `sessionDir` already contains a zapo store (auth.json / *.sqlite). */
const hasZapoStore = (sessionDir) => {
    if (!fs.existsSync(sessionDir)) return false;
    return fs
        .readdirSync(sessionDir)
        .some((file) => file === 'auth.json' || file.endsWith('.sqlite'));
};

/** Lists every JSON key file in a Baileys session (excluding creds.json). */
const listBaileysKeyFiles = (sessionDir) => {
    if (!fs.existsSync(sessionDir)) return [];
    return fs
        .readdirSync(sessionDir)
        .filter((file) => file.endsWith('.json') && file !== 'creds.json')
        .map((file) => path.join(sessionDir, file));
};

/**
 * Built-in converter for directly-mappable credential fields. Signal key
 * reconstruction is left to a dedicated converter.
 * @param {object} creds Baileys `creds.json`
 * @returns {object} partial `WaAuthCredentials`
 */
const defaultConverter = (creds = {}) => {
    const out = {
        registrationInfo: creds.registrationInfo,
        signedIdentity: creds.signedIdentity,
        advSecretKey: creds.advSecretKey
            ? new Uint8Array(Buffer.from(creds.advSecretKey, 'base64'))
            : undefined,
        noiseKeyPair: creds.noiseKey,
        signedPreKey: creds.signedPreKey,
        meJid: creds.me?.id,
        meLid: creds.me?.lid,
        meDisplayName: creds.me?.name,
        platform: creds.platform,
        pushName: creds.pushName
    };

    return Object.fromEntries(Object.entries(out).filter(([, value]) => value !== undefined));
};

/**
 * Migrates a Baileys session directory into a zapo store.
 *
 * @param {object} input
 * @param {string} input.sessionDir
 * @param {object} input.store live zapo `WaStore`
 * @param {string} [input.sessionId]
 * @param {(creds: object, ctx: { keyFiles: string[] }) => object|Promise<object>} [input.converter]
 * @param {boolean} [input.force] migrate even when a zapo store already exists
 * @returns {Promise<{ migrated: boolean, reason?: string, fields: number }>}
 */
const migrateBaileysSession = async (input) => {
    const { sessionDir, store, sessionId = 'default', converter = defaultConverter, force = false } = input;

    if (!sessionDir) {
        throw new NexrayError(ErrorCode.MIGRATION_INVALID_SOURCE, 'sessionDir is required');
    }
    if (!store || typeof store.session !== 'function') {
        throw new NexrayError(ErrorCode.MIGRATION_INVALID_SOURCE, 'a live zapo store is required');
    }

    if (!hasBaileysCreds(sessionDir)) {
        return { migrated: false, reason: 'no Baileys creds.json found', fields: 0 };
    }
    if (!force && hasZapoStore(sessionDir)) {
        return { migrated: false, reason: 'a zapo store already exists', fields: 0 };
    }

    const creds = await readJson(path.join(sessionDir, 'creds.json'));
    if (!creds || typeof creds !== 'object') {
        throw new NexrayError(ErrorCode.MIGRATION_INVALID_SOURCE, 'creds.json is empty or invalid');
    }

    const keyFiles = listBaileysKeyFiles(sessionDir);
    const credentials = await converter(creds, { keyFiles });
    if (!credentials || typeof credentials !== 'object') {
        throw new NexrayError(ErrorCode.MIGRATION_INVALID_SOURCE, 'converter returned no credentials');
    }

    const session = store.session(sessionId);
    try {
        await session.auth.save(credentials);
    } catch (error) {
        throw new NexrayError(ErrorCode.MIGRATION_WRITE_FAILED, error.message, { cause: error });
    }

    const persisted = await session.auth.load();
    if (!persisted) {
        throw new NexrayError(
            ErrorCode.MIGRATION_WRITE_FAILED,
            'store did not return the migrated credentials'
        );
    }

    return { migrated: true, fields: Object.keys(credentials).length };
};

/** Backs up the source Baileys folder next to itself before removal. */
const backupBaileysSession = async (sessionDir) => {
    const backup = `${sessionDir}.bak-${Date.now()}`;
    await fsp.cp(sessionDir, backup, { recursive: true });
    return backup;
};

module.exports = {
    hasBaileysCreds,
    hasZapoStore,
    listBaileysKeyFiles,
    migrateBaileysSession,
    backupBaileysSession,
    defaultConverter,
    readJson,
    writeJson
};
