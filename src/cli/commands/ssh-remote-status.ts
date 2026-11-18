// SSH remote status command - which remotes the running app holds as unreachable.
//
// The CLI side of the "Can't reach <remote> over SSH" dialog. Without an
// argument it is the dialog's read: every remote the app has confirmed down,
// since when, and why. With `--check <remote-id>` it is the dialog's "Check
// Now": the app probes that remote, settles its state, and closes the dialog in
// every window when the host answers.
//
// Unlike `test-ssh-remote`, which dials on its own so it works with Maestro
// closed, this asks the running app, because the outage state lives there.

import { withMaestroClient } from '../services/maestro-client';
import { resolveSshRemoteId } from '../services/storage';
import { formatError, formatSuccess, colorize } from '../output/formatter';
import { formatRelativeTime } from '../../shared/formatters';
import type { SshReachabilityEvent } from '../../shared/sshConnection';

/** Longer than any sane `ConnectTimeout`, so a slow dead host still gets its answer. */
const CHECK_TIMEOUT_MS = 120_000;

interface SshRemoteStatusOptions {
	check?: string;
	json?: boolean;
}

function fail(message: string, json?: boolean): never {
	if (json) console.log(JSON.stringify({ success: false, error: message }));
	else console.error(formatError(message));
	process.exit(1);
}

function printOutage(event: SshReachabilityEvent): void {
	console.log(
		`${colorize('red', 'UNREACHABLE')} ${event.remoteName} (${event.remoteId}) since ${formatRelativeTime(event.since)}`
	);
	if (event.message) console.log(`  ${event.message}`);
}

export async function sshRemoteStatus(options: SshRemoteStatusOptions): Promise<void> {
	if (options.check !== undefined) {
		let remoteId: string;
		try {
			remoteId = resolveSshRemoteId(options.check);
		} catch (error) {
			fail(error instanceof Error ? error.message : String(error), options.json);
		}

		let result: {
			success: boolean;
			error?: string;
			reachable?: boolean;
			event?: SshReachabilityEvent;
		};
		try {
			result = await withMaestroClient((client) =>
				client.sendCommand<typeof result & { type: string }>(
					{ type: 'ssh_reachability_check', remoteId },
					'ssh_reachability_check_result',
					// The probe waits out ssh's own ConnectTimeout (45s on a tunnelled remote).
					CHECK_TIMEOUT_MS
				)
			);
		} catch (error) {
			fail(error instanceof Error ? error.message : String(error), options.json);
		}

		if (!result.success) fail(result.error || 'Reachability check failed', options.json);
		if (options.json) {
			console.log(
				JSON.stringify({
					success: true,
					remoteId,
					reachable: result.reachable,
					event: result.event,
				})
			);
		} else if (result.reachable) {
			console.log(formatSuccess(`Remote ${remoteId} is reachable`));
		} else if (result.event) {
			printOutage(result.event);
		} else {
			console.log(`${colorize('red', 'UNREACHABLE')} ${remoteId}`);
		}
		if (!result.reachable) process.exitCode = 2;
		return;
	}

	let result: { success: boolean; error?: string; unreachable?: SshReachabilityEvent[] };
	try {
		result = await withMaestroClient((client) =>
			client.sendCommand<typeof result & { type: string }>(
				{ type: 'ssh_reachability_status' },
				'ssh_reachability_status_result'
			)
		);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error), options.json);
	}

	if (!result.success) fail(result.error || 'Failed to read SSH reachability', options.json);
	const unreachable = result.unreachable ?? [];
	if (options.json) {
		console.log(JSON.stringify({ success: true, unreachable }));
		return;
	}
	if (unreachable.length === 0) {
		console.log(formatSuccess('No SSH remote is known to be unreachable'));
		return;
	}
	for (const event of unreachable) printOutage(event);
}
