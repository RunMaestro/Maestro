// Moved into maestro-lib (client/discovery.ts) beside the bridge connection
// that reads it, so a library client finds a running desktop without reaching
// outside the library. Re-exported so every existing import (main writes the
// file, the CLI reads it) keeps resolving unchanged.
export * from './maestro-lib/client/discovery';
