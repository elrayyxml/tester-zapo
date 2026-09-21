'use strict';

/**
 * Stable library error codes.
 *
 * These identify @nexray/lib failures only. They are NOT WhatsApp protocol
 * error codes and must never be used to classify a server response.
 */
const ErrorCode = Object.freeze({
    ENGINE_MISSING: 'NEXRAY_ENGINE_MISSING',
    ENGINE_INVALID: 'NEXRAY_ENGINE_INVALID',
    SESSION_TYPE_UNSUPPORTED: 'NEXRAY_SESSION_TYPE_UNSUPPORTED',
    STORE_BACKEND_MISSING: 'NEXRAY_STORE_BACKEND_MISSING',

    SOCKET_NOT_READY: 'NEXRAY_SOCKET_NOT_READY',
    UNSUPPORTED_API: 'NEXRAY_UNSUPPORTED_API',
    INVALID_JID: 'NEXRAY_INVALID_JID',
    INVALID_CONTENT: 'NEXRAY_INVALID_CONTENT',

    MEDIA_RESOLVE_FAILED: 'NEXRAY_MEDIA_RESOLVE_FAILED',
    MEDIA_PROCESSOR_FAILED: 'NEXRAY_MEDIA_PROCESSOR_FAILED',

    MIGRATION_INVALID_SOURCE: 'NEXRAY_MIGRATION_INVALID_SOURCE',
    MIGRATION_WRITE_FAILED: 'NEXRAY_MIGRATION_WRITE_FAILED',

    OPTION_INVALID: 'NEXRAY_OPTION_INVALID'
});

/**
 * Library-level error with a stable `code`. Always carries the original cause
 * when one exists so callers can surface the real protocol failure instead of
 * a generic "send failed".
 */
class NexrayError extends Error {
    /**
     * @param {string} code one of {@link ErrorCode}
     * @param {string} message human readable description
     * @param {{ cause?: unknown, meta?: Record<string, unknown> }} [details]
     */
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'NexrayError';
        this.code = code;
        if (details.cause !== undefined) this.cause = details.cause;
        if (details.meta !== undefined) this.meta = details.meta;
    }
}

/**
 * Builds a NexrayError for an API surface that is intentionally not mirrored
 * from Baileys. The facade must throw, never return `undefined`.
 *
 * @param {string} api
 * @param {string} [reason]
 * @returns {NexrayError}
 */
const unsupported = (api, reason) =>
    new NexrayError(
        ErrorCode.UNSUPPORTED_API,
        `@nexray/lib does not implement '${api}'${reason ? `: ${reason}` : ''}`
    );

module.exports = { ErrorCode, NexrayError, unsupported };
