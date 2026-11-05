import {
	signalRemoteAgent as signalRemoteAgentCore,
	type RemoteSignalMode,
} from '../../shared/maestro-lib/control/ssh-remote-signal';
import { withWorktreeTurnActivity } from '../git/worktreeTurnActivity';
import { captureException } from './sentry';

// Keep the scripts and connection helpers shared with the headless runtime.
export * from '../../shared/maestro-lib/control/ssh-remote-signal';

/** The main-process signal helper owns a separate, detached local SSH child. */
export function signalRemoteAgent(
	target: Parameters<typeof signalRemoteAgentCore>[0],
	mode: RemoteSignalMode
): boolean {
	return withWorktreeTurnActivity(
		(_start, observe) =>
			signalRemoteAgentCore(
				target,
				mode,
				(child) => {
					// Hold before attaching: a missing handle/observer is unknown, even
					// when the core catches setup failure and returns false. Exit/error,
					// unref and a timeout kill request cannot prove child/stdio close.
					const closed = Promise.withResolvers<void>();
					observe(closed.promise);
					child.on('close', () => closed.resolve());
				},
				(callback) => withWorktreeTurnActivity(callback, (error) => captureException(error))
			),
		(error) => captureException(error)
	);
}
