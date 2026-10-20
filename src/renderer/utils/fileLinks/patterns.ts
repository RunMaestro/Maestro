/**
 * Re-export of the shared file-link patterns. The regexes live in
 * `src/shared/fileLinkPatterns.ts` so the main-process Dataview index and
 * the renderer agree on what counts as a wiki link or embed. Existing
 * renderer imports keep working through this module.
 */

export * from '../../../shared/fileLinkPatterns';
