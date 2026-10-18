// Moved into maestro-lib: the headless pipe spec (`run/pipe-spawn.ts`) builds the same stdin
// message the desktop spawner does. Re-exported so every existing import keeps resolving unchanged.
export { buildStreamJsonMessage } from '../../../shared/maestro-lib/launch/stream-json-message';
