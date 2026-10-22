/**
 * What a headless turn needs around its process so that it always ends, and ends everywhere.
 *
 * The desktop's spawner and `ProcessManager` do both of these for a desktop turn; the headless
 * runtime's launchers (`runAgentTurn`, and the group chat and consult launcher) call this instead,
 * so `startTurn`, which the desktop shares, is left as it is:
 *
 * - **The turn settles.** `startTurn` settles on `close`, which waits on every holder of the stdio
 *   pipes. An SSH ControlMaster or a stray grandchild can hold them long after the child is dead,
 *   and a turn that never settles leaves its tab busy for good. `armStdioCloseWatchdog` forces the
 *   close a grace period after the exit.
 * - **Stop reaches the remote agent.** The local child of an SSH turn is only the ssh client, and
 *   with no TTY no signal is forwarded to the agent it started. A launch script that records the
 *   agent's pid (`recordRemoteAgent`) lets Stop signal the agent on its host as well.
 */

import { logger } from '../host';
import type { TurnHandle } from '../run/start-turn';
import {
	newRemotePidFilePath,
	signalRemoteAgent,
	sshConnectionArgs,
	withRemotePidRecord,
	type RemoteSignalMode,
} from './ssh-remote-signal';
import { armStdioCloseWatchdog } from './stdio-close-watchdog';

const LOG_CONTEXT = '[TurnGuard]';

/** Where an SSH turn's agent runs and where its pid is recorded: what a remote stop signals. */
export type RemoteAgentTarget = Parameters<typeof signalRemoteAgent>[0];

/**
 * Make an SSH stdin-script launch record its agent's pid, and say how to reach it. A launch that
 * is not one (a local turn, or an SSH command that does not end in the stdin shell) passes through
 * with no target: there is nothing on a remote to signal.
 */
export function recordRemoteAgent(launch: {
	command: string;
	args: readonly string[];
	sshStdinScript: string | undefined;
	sessionId: string;
}): { sshStdinScript: string | undefined; remote?: RemoteAgentTarget } {
	const { sshStdinScript } = launch;
	if (!sshStdinScript || !sshConnectionArgs(launch.args)) return { sshStdinScript };
	const pidFile = newRemotePidFilePath();
	return {
		sshStdinScript: withRemotePidRecord(sshStdinScript, pidFile),
		remote: {
			sshCommand: launch.command,
			sshArgs: launch.args,
			pidFile,
			sessionId: launch.sessionId,
		},
	};
}

export interface TurnGuardOptions {
	sessionId: string;
	/** How long an interrupted remote agent gets before its host is asked to terminate it. */
	graceMs: number;
	/** The agent on an SSH remote, from `recordRemoteAgent`. Absent: the turn is local. */
	remote?: RemoteAgentTarget;
	/** The turn's abort signal. Aborting stops the local process already; this stops the remote too. */
	signal?: AbortSignal;
}

/** The turn's stop methods, each reaching the remote agent as well when there is one. */
export interface GuardedTurnStops {
	interrupt(): void;
	terminate(): void;
	terminateNow(): void;
}

/**
 * Arm the stdio close watchdog on a started turn and answer its stop methods. Call it once, right
 * after the turn starts, and stop the turn only through what it returns.
 */
export function guardTurn(
	handle: Pick<TurnHandle, 'child' | 'done' | 'interrupt' | 'terminate' | 'terminateNow'>,
	options: TurnGuardOptions
): GuardedTurnStops {
	const { child } = handle;
	const { remote, sessionId } = options;
	let settled = false;
	void handle.done.then(() => {
		settled = true;
	});

	// Nothing is signalled once the turn has settled: its pid record may name a process the
	// remote has since handed to something else, and `signalRemoteAgent` only guards a recycled
	// pid by its start time.
	const signalRemote = (mode: RemoteSignalMode): void => {
		if (remote && !settled) signalRemoteAgent(remote, mode);
	};

	armStdioCloseWatchdog(child, {
		onForceClose: () => {
			logger.warn('stdio still open after exit, forcing close', LOG_CONTEXT, {
				sessionId,
				pid: child.pid,
			});
			// For SSH the open stdio usually means the remote agent is still running behind a
			// ControlMaster. Settling the turn while it keeps working would put a second writer on
			// the session next turn.
			signalRemote('terminate');
		},
	});

	const { signal } = options;
	if (remote && signal) {
		const onAbort = (): void => signalRemote('terminate');
		if (signal.aborted) onAbort();
		else {
			signal.addEventListener('abort', onAbort, { once: true });
			void handle.done.then(() => signal.removeEventListener('abort', onAbort));
		}
	}

	return {
		interrupt: () => {
			handle.interrupt();
			if (!remote || settled) return;
			// SIGINT now, the same request a local Stop makes; SIGTERM if the turn is still running
			// after the grace. An observed exit is tested, never `.killed`, which is set as soon as a
			// signal is sent.
			signalRemote('interrupt');
			const timer = setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) signalRemote('terminate');
			}, options.graceMs);
			child.once('exit', () => clearTimeout(timer));
		},
		terminate: () => {
			signalRemote('terminate');
			handle.terminate();
		},
		terminateNow: () => {
			signalRemote('terminate');
			handle.terminateNow();
		},
	};
}
