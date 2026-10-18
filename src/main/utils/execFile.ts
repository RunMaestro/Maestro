// Moved into maestro-lib: the library probes binaries and runs short commands
// itself, so the exec helpers live there. Re-exported here so every existing
// `from '../utils/execFile'` import keeps resolving unchanged.
export * from '../../shared/maestro-lib/launch/exec-file';
