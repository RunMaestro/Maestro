/**
 * @file group-chat-log.ts
 * @description Pipe-delimited log format utilities for the Group Chat feature.
 *
 * The implementation moved into the library (`src/shared/maestro-lib/groupchat/log.ts`)
 * so the headless runtime writes the same `chat.log` the desktop reads. This
 * module stays the import site every main-process caller already uses.
 */

export * from '../../shared/maestro-lib/groupchat/log';
