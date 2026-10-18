// Moved into maestro-lib: the working-directory check carries no desktop-framework
// dependency, so it now lives in the shared library. Re-exported here so every
// existing `from './utils/spawnCwd'` import keeps resolving unchanged.
export * from '../../../shared/maestro-lib/launch/cwd';
