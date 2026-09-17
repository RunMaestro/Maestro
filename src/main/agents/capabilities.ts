// Moved into maestro-lib (Maestro-lib Part One): capability flags carry no
// desktop-framework dependency, so they now live in the shared library.
// Re-exported here so every existing `from '../agents/capabilities'` /
// `from './capabilities'` import keeps resolving unchanged.
export * from '../../shared/maestro-lib/providers/capabilities';
