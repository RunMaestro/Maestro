// Moved into maestro-lib (Maestro-lib Part One): binary detection carries no
// desktop-framework dependency, so it now lives in the shared library.
// Re-exported here so every existing `from '../agents/path-prober'` /
// `from './path-prober'` import keeps resolving unchanged.
export * from '../../shared/maestro-lib/launch/path-prober';
