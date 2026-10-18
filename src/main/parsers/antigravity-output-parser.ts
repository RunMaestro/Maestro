// Moved into maestro-lib (Maestro-lib Part One): output parsers carry no
// desktop-framework dependency, so they now live in the shared library.
// Re-exported here so every existing `from '../parsers/antigravity-output-parser'` /
// `from './antigravity-output-parser'` import keeps resolving unchanged.
export * from '../../shared/maestro-lib/parsers/antigravity-output-parser';
