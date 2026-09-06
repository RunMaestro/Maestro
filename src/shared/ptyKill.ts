// src/shared/ptyKill.ts

import type * as pty from 'node-pty';

import { isWindows } from './platformDetection';

/**
 * Kill a PTY, dropping the POSIX signal on Windows.
 *
 * node-pty's Windows backend throws `Signals not supported on windows.` for any
 * signal argument at all - it only implements the no-argument form, which closes
 * the pty and kills the ConPTY/winpty agent. On POSIX the signal is honoured, so
 * it is passed straight through.
 *
 * A plain try/catch around `ptyProcess.kill(signal)` does NOT contain that throw.
 * node-pty queues the call as a *deferred* whenever the agent has not signalled
 * ready yet, and later runs the queue from a socket `data` handler - so the throw
 * surfaces on a completely different stack, escapes as an uncaught exception, and
 * takes the process down (Sentry MAESTRO-XZ: 822 fatal events from a single
 * Windows install). Callers must therefore never hand node-pty a signal on
 * Windows, rather than trying to catch what it throws.
 *
 * Windows PTYs are normally torn down by pid with `taskkill /t /f`, which also
 * gets grandchildren. This path is what remains when the pid is unavailable -
 * ConPTY reports pid 0 when the shell fails to launch - and a signal-less kill()
 * is then the only correct call.
 *
 * Lives in `shared/` rather than beside the process-manager callers because the
 * standalone `maestro-p` CLI drives its own PTY and needs the same rule. That
 * binary is esbuild-bundled from `src/maestro-p/index.ts` with everything inlined
 * except node-pty, so it cannot reach the main-process copy without pulling the
 * Electron logger and the process-tree helpers into the CLI bundle. Keep this
 * module dependency-free apart from the type-only node-pty import.
 */
export function killPty(ptyProcess: pty.IPty, signal: NodeJS.Signals): void {
	ptyProcess.kill(isWindows() ? undefined : signal);
}
