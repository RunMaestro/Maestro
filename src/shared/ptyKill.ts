// Moved into maestro-lib: the PTY kill rule is part of the library's stop
// ladder. Re-exported here so `maestro-p` and the process-manager callers keep
// resolving `shared/ptyKill` unchanged.
export * from './maestro-lib/control/pty-kill';
