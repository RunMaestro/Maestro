// Moved into maestro-lib: the child-process environment builder carries no
// desktop-framework dependency, so it now lives in the shared library.
// Re-exported here so every existing `from '../utils/envBuilder'` import keeps
// resolving unchanged.
export * from '../../../shared/maestro-lib/launch/env';
