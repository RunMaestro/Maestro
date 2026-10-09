// Moved into maestro-lib (Maestro-lib Part One): output parsers carry no
// desktop-framework dependency, so they now live in the shared library.
// Re-exported here so every existing `from '../parsers/codex-output-parser'` /
// `from './codex-output-parser'` import keeps resolving unchanged.
export * from '../../shared/maestro-lib/parsers/codex-output-parser';
