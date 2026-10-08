// Moved into maestro-lib: the spawn PATH builder carries no desktop-framework
// dependency, so it now lives in the shared library. Re-exported here so every
// existing `from '../utils/spawnPath'` import keeps resolving unchanged.
export * from '../../shared/maestro-lib/launch/spawn-path';
