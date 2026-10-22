// Cue trigger command - manually trigger a Cue subscription by name

import { withMaestroClient } from '../services/maestro-client';
import { MaestroNotRunningError } from '../services/maestro-not-running';
import { submitCueTrigger } from '../services/cue-trigger-inbox';
import { isCueEngineLockOwnedBy, readCueEngineLock } from '../../main/cue/cue-engine-lock';
import { readCliServerInfo } from '../../shared/cli-server-discovery';
import {
	errorFrameMessage,
	exitIfMaestroNotRunning,
	failCommand,
} from '../services/session-command';
import { applyDataDirOption, requireDataDirOrExit } from '../services/data-dir-option';

interface CueTriggerOptions {
	prompt?: string;
	json?: boolean;
	sourceAgentId?: string;
	/** Explicit data directory; decides which engine lock and inbox (or desktop discovery file) is used. */
	dataDir?: string;
}

export async function cueTrigger(
	subscriptionName: string,
	options: CueTriggerOptions
): Promise<void> {
	// Before the lock read below: the lock, the inbox and the desktop's
	// discovery file all live in the data directory. Only an EXPLICIT path is
	// checked for existence; without one, an absent desktop app keeps
	// reporting itself as MAESTRO_NOT_RUNNING (exit 3), as it always has.
	if (options.dataDir !== undefined) {
		applyDataDirOption(options.dataDir);
		requireDataDirOrExit({ json: options.json });
	}
	try {
		// Whoever holds the engine lock is the engine that will run it. A
		// standalone runner has no WebSocket, so it is reached through its
		// trigger inbox instead (see cue-trigger-inbox.ts). The exception is the
		// standalone engine inside `maestro-cli host`, which the client reaches
		// anyway: the host answers, so a shutdown drain (which stops the inbox)
		// is refused with its reason instead of timing out. "The host's own
		// engine" is decided by the lock token the host publishes, never by pid:
		// two containers on one data directory both run as pid 1.
		const viaInbox = () =>
			submitCueTrigger({
				subscriptionName,
				prompt: options.prompt,
				sourceAgentId: options.sourceAgentId,
			});
		const viaHost = () =>
			withMaestroClient(async (client) => {
				return client.sendCommand<{
					type: string;
					success: boolean;
					subscriptionName: string;
					error?: string;
				}>(
					{
						type: 'trigger_cue_subscription',
						subscriptionName,
						prompt: options.prompt,
						sourceAgentId: options.sourceAgentId,
					},
					'trigger_cue_subscription_result'
				);
			});
		const lock = readCueEngineLock();
		let result: Awaited<ReturnType<typeof viaInbox>> | Awaited<ReturnType<typeof viaHost>>;
		if (lock?.mode !== 'standalone') {
			result = await viaHost();
		} else if (!isCueEngineLockOwnedBy(lock, readCliServerInfo()?.cueLockToken)) {
			result = await viaInbox();
		} else {
			try {
				result = await viaHost();
			} catch (error) {
				// The host's engine holds the lock, but its connection never opened
				// from here: a caller that shares the data directory and not the
				// host's network (another container) dials its own loopback. The
				// request was never sent, so the inbox, which that engine also
				// reads, cannot run the trigger twice. Anything after the
				// connection opened (a refusal, a timeout, a dropped socket) is the
				// host's answer and is reported as it is.
				if (!(error instanceof MaestroNotRunningError)) throw error;
				if (!options.json) {
					console.error(
						'Sent through the Cue trigger inbox: the host that runs this Cue engine could not be reached from here.'
					);
				}
				result = await viaInbox();
			}
		}

		// A refusal with a reason (a headless host not running Cue says why and
		// what to do), not a subscription that was not found.
		const frameError = errorFrameMessage(result);
		if (frameError) failCommand(frameError, options.json);

		if (options.json) {
			console.log(
				JSON.stringify({
					type: 'trigger_result',
					success: result.success,
					subscriptionName,
					...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
					...(options.sourceAgentId !== undefined ? { sourceAgentId: options.sourceAgentId } : {}),
					...(result.error ? { error: result.error } : {}),
				})
			);
			if (!result.success) {
				process.exitCode = 1;
			}
		} else if (result.success) {
			console.log(
				`Triggered Cue subscription "${subscriptionName}"${options.prompt ? ' with custom prompt' : ''}`
			);
		} else {
			console.error(
				`Subscription "${subscriptionName}" not found or could not be triggered${
					result.error ? `: ${result.error}` : ''
				}`
			);
			process.exit(1);
		}
	} catch (error) {
		exitIfMaestroNotRunning(error, { json: options.json, jsonExtra: { type: 'error' } });
		if (options.json) {
			console.log(
				JSON.stringify({
					type: 'error',
					error: error instanceof Error ? error.message : String(error),
				})
			);
		} else {
			console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		}
		process.exit(1);
	}
}
