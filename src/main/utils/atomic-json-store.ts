/**
 * Atomic JSON file I/O + per-key write serialization.
 *
 * Two failure modes plague the app's many per-entity JSON stores (history,
 * group-chat metadata, ...), both stemming from concurrent writers racing on a
 * single file with a plain `fs.writeFile`:
 *
 *  1. Partial / concatenated reads. `writeFile` truncates then streams bytes,
 *     so a reader (or a second writer's read-modify-write) that lands mid-write
 *     sees a truncated or `}{`-concatenated file. Parsing fails, and the
 *     caller's recovery path typically discards the file - silently destroying
 *     the accumulated data.
 *  2. Lost updates. Two read-modify-write callers read the same base, each
 *     appends its own entry, and the later writer clobbers the earlier one.
 *
 * `atomicWriteJson` fixes (1): write to a temp file, then `rename` over the
 * target (implemented in `src/shared/maestro-lib/store/atomic-write.ts`). rename() is atomic on POSIX and effectively atomic on NTFS, so every
 * reader sees either the whole old file or the whole new file - never a partial
 * one. This holds across processes too, which matters because both the desktop
 * app and `maestro-cli` write the same history files.
 *
 * `createKeyedWriteQueue` fixes (2) within a process: it serializes every
 * mutation for a given key (e.g. a session id) so read-modify-write sequences
 * never interleave. Its implementation lives in `src/shared/keyedWriteQueue.ts`
 * (the renderer serializes work too and cannot import `fs/promises`) and is
 * re-exported below, so this stays the import site every main-process caller
 * already uses.
 *
 * This is the canonical home for the pattern that previously lived inline in
 * `group-chat-storage.ts`.
 */

// The write functions live in the library so the headless runtime can use them
// with no desktop present; this module stays the import site main callers use.
export { atomicWriteJson, atomicWriteFile } from '../../shared/maestro-lib/store/atomic-write';

export { createKeyedWriteQueue, type KeyedWriteQueue } from '../../shared/keyedWriteQueue';
