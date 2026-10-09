/** Bound headless process startup and teardown without relying on child close. */
import type { ChildProcess } from 'child_process';
import { createIdleWatchdog, type IdleWatchdog } from '../../main/utils/idle-watchdog';
import { killProcessTreeNow } from '../../main/utils/processTree';
import { HEADLESS_PROCESS_CLOSE_TIMEOUT_MS } from '../../shared/plugins/headless-agent-timeouts';

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
	let closeDeadline: ReturnType<typeof setTimeout> | undefined;

	const stop = (reason: string): void => {
		if (disposed || stopping) return;
		stopping = true;
		startup?.disarm();
		lifetime?.disarm();
		options.onStop(reason);
		// Arm before killing: close can be delivered during kill in a harness.
		closeDeadline = setTimeout(() => {
			if (disposed) return;
			// A descendant may retain stdio even after the provider exits. Do not
			// wait forever for close, and do not expose late output as success.
			child.stdout?.destroy();
			child.stderr?.destroy();
			options.onForcedStop();
		}, HEADLESS_PROCESS_CLOSE_TIMEOUT_MS);
		// Snapshot and terminate descendants before their launcher can exit and
		// reparent them. Reuse the same tree kill as the host's Stop action.
		if (child.pid) killProcessTreeNow(child.pid, { label: 'headless agent' });
		else child.kill('SIGKILL');
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
			if (disposed) return;
			disposed = true;
			startup?.disarm();
			lifetime?.disarm();
			if (closeDeadline) clearTimeout(closeDeadline);
			options.signal?.removeEventListener('abort', abort);
		},
	};
}
