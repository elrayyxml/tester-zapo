import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lib = require('./index.js');

export const Client = lib.Client;
export const createInMemoryStore = lib.createInMemoryStore;
export const createJsonStore = lib.createJsonStore;
export const createSqliteStore = lib.createSqliteStore;
export const createSessionStore = lib.createSessionStore;
export const migrateBaileysSession = lib.migrateBaileysSession;
export const Request = lib.Request;
export const Scraper = lib.Scraper;
export const Utilities = lib.Utilities;
export const Utils = lib.Utils;
export const updateWAProto = lib.updateWAProto;
export const ErrorCode = lib.ErrorCode;
export const NexrayError = lib.NexrayError;
export const proto = lib.proto;

export { Client as default };

export * from 'zapo-js';
