// Moved into maestro-lib: the SSH command builder quotes with it. Re-exported
// here so every existing import (and CLAUDE.md's canonical-utility entry for
// shellEscape / shellEscapeRemotePath) keeps resolving unchanged.
export * from '../../shared/maestro-lib/launch/shell-escape';
