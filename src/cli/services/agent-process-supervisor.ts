/** Bound headless process startup and teardown without relying on child close. */
import { execFile, type ChildProcess } from 'child_process';
import { createIdleWatchdog, type IdleWatchdog } from '../../main/utils/idle-watchdog';
import { isWindows } from '../../shared/platformDetection';
import { HEADLESS_PROCESS_KILL_GRACE_MS } from '../../shared/plugins/headless-agent-timeouts';

export function superviseAgentProcess(
	child: ChildProcess,
	options: {
		timeoutMs?: number;
		startupMs?: number;
		signal?: AbortSignal;
		onStop: (reason: string) => void;
		onForcedStop: () => void;
	}
): { modelActivity: () => void; dispose: () => void } {
	let disposed = false;
	let stopping = false;
	let startup: IdleWatchdog | undefined;
	let lifetime: IdleWatchdog | undefined;
	let escalation: ReturnType<typeof setTimeout> | undefined;

	// Supervised POSIX children are spawned as process-group leaders. Kill the
	// group too: Codex's Node launcher and children can otherwise retain pipes.
	const kill = (signal: NodeJS.Signals): void => {
		try {
			if (isWindows() && child.pid) {
				execFile(
					'taskkill',
					['/pid', String(child.pid), '/t', '/f'],
					{ timeout: HEADLESS_PROCESS_KILL_GRACE_MS },
					() => {}
				);
			} else if (child.pid) {
				process.kill(-child.pid, signal);
			} else {
				child.kill(signal);
			}
		} catch {
			// The child/group may already have exited before close drains stdio.
		}
	};
	const stop = (reason: string): void => {
		if (disposed || stopping) return;
		stopping = true;
		startup?.disarm();
		lifetime?.disarm();
		options.onStop(reason);
		// Arm before signalling: close can be delivered during kill in a harness.
		escalation = setTimeout(() => {
			if (disposed) return;
			kill('SIGKILL');
			// A descendant may retain stdio even after the provider exits. Do not
			// wait forever for close, and do not expose late output as success.
			child.stdout?.destroy();
			child.stderr?.destroy();
			options.onForcedStop();
		}, HEADLESS_PROCESS_KILL_GRACE_MS);
		kill('SIGTERM');
	};
	const abort = (): void => stop('Agent run timed out or was cancelled');
	if (options.startupMs) {
		startup = createIdleWatchdog({
			idleMs: options.startupMs,
			onIdle: () =>
				stop(
					`Codex produced no model activity within ${options.startupMs! / 1000} seconds. Startup or authentication may be blocked, for example by an interactive keyring prompt. Check Codex login and the credential store on the agent host; after fixing them, retry the request. For a host already using file credentials, verify the agent's -c cli_auth_credentials_store=file setting.`
				),
		});
	}
	if (options.timeoutMs) {
		lifetime = createIdleWatchdog({
			idleMs: options.timeoutMs,
			onIdle: () => stop('Agent run timed out or was cancelled'),
		});
	}
	options.signal?.addEventListener('abort', abort, { once: true });
	if (options.signal?.aborted) abort();
	return {
		modelActivity: () => startup?.disarm(),
		dispose: () => {
			disposed = true;
			// A launcher can close while a descendant ignores SIGTERM. Finish
			// terminating its group before clearing the pending escalation.
			if (stopping) kill('SIGKILL');
			startup?.disarm();
			lifetime?.disarm();
			if (escalation) clearTimeout(escalation);
			options.signal?.removeEventListener('abort', abort);
		},
	};
}
