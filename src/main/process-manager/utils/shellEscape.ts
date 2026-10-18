// Moved into maestro-lib: the headless pipe spec (`run/pipe-spawn.ts`) escapes arguments the same
// way the desktop spawner does. Re-exported so every existing `from '../utils/shellEscape'` import
// keeps resolving unchanged.
export * from '../../../shared/maestro-lib/launch/windows-shell-escape';
