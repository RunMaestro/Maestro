// Moved into maestro-lib (Maestro-lib Part One): provider definitions carry no
// desktop-framework dependency, so they now live in the shared library.
// Re-exported here so every existing `from '../agents/definitions'` /
// `from './definitions'` import keeps resolving unchanged.
export * from '../../shared/maestro-lib/providers/definitions';
