// Live mode commands - the CLI half of the Left Bar LIVE pill (the web
// interface switch) and its Remote Control row (the Cloudflare tunnel).
// `live on|off` and `live tunnel on|off` reach the same main-process switch the
// pill does, over the CLI-only `live_command` message; `live status` reads it
// back.
//
// A switch replaces the server this CLI is connected to, so the app answers
// first and switches after. The CLI then reconnects (the discovery file names
// the new server) and polls `status` until the switch has finished. Any other
// maestro-cli call in flight at that moment drops, as it does for the pill.

import { withMaestroClient } from '../services/maestro-client';
import { failCommand, failFromError } from '../services/session-command';
import { formatSuccess } from '../output/formatter';
import {
	LIVE_COMMAND,
	LIVE_COMMAND_RESULT,
	type LiveCommandAction,
	type LiveCommandResult,
	type LiveModeStatus,
} from '../../shared/liveMode';

export interface LiveOptions {
	json?: boolean;
	/**
	 * Accepted and intentionally ignored on `on` / `off`: a Live switch moves no
	 * view, so there is nothing for the flag to suppress. See
	 * `ALREADY_QUIET_VERBS` in `shared/focusPlacement.ts`.
	 */
	background?: boolean;
}

export interface LiveOnOptions extends LiveOptions {
	/** Also start Remote Control once Live is on. */
	tunnel?: boolean;
}

/** How long a switch may take: a Windows tunnel kill plus a failed start's retries. */
export const LIVE_SWITCH_TIMEOUT_MS = 20_000;
/** Pause between status reads while a switch finishes. */
export const LIVE_POLL_INTERVAL_MS = 250;
/** cloudflared takes up to 30s to report a URL (tunnel-manager's own cap). */
export const REMOTE_CONTROL_TIMEOUT_MS = 45_000;

async function sendLiveCommand(
	action: LiveCommandAction,
	timeoutMs?: number
): Promise<LiveCommandResult> {
	return withMaestroClient((client) =>
		client.sendCommand<LiveCommandResult & { type: string }>(
			{ type: LIVE_COMMAND, action },
			LIVE_COMMAND_RESULT,
			timeoutMs
		)
	);
}

/** Add the next step to the Remote Control failures an agent can act on. */
function remoteControlErrorWithHint(error: string): string {
	if (/not installed/i.test(error)) {
		return `${error}. Install cloudflared (macOS: \`brew install cloudflared\`), then retry.`;
	}
	if (/live mode is off/i.test(error)) {
		return `${error} Run \`maestro-cli live on --tunnel\` to start both.`;
	}
	return error;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read status until the switch the app promised has finished. While it runs
 * the old server goes away and the discovery file is briefly missing, so a
 * failed connect means "not yet", not "the app quit".
 */
async function awaitSwitch(revision: number): Promise<LiveModeStatus> {
	const deadline = Date.now() + LIVE_SWITCH_TIMEOUT_MS;
	let lastError: unknown;
	while (Date.now() < deadline) {
		await sleep(LIVE_POLL_INTERVAL_MS);
		try {
			const reply = await sendLiveCommand('status');
			if (reply.success && reply.status && reply.status.revision >= revision) return reply.status;
		} catch (error) {
			lastError = error;
		}
	}
	const detail = lastError instanceof Error ? ` (last error: ${lastError.message})` : '';
	throw new Error(
		`Live mode did not finish switching within ${LIVE_SWITCH_TIMEOUT_MS / 1000}s${detail}. Check it with \`maestro-cli live status\`.`
	);
}

function printStatus(status: LiveModeStatus): void {
	console.log(`Live: ${status.live ? 'on' : 'off'}`);
	if (status.url) console.log(`  URL: ${status.url}`);
	if (status.remoteControl && status.remoteControlUrl) {
		console.log(`  Remote Control: ${status.remoteControlUrl}`);
	} else {
		console.log(
			`  Remote Control: ${status.remoteControlError ? `error - ${status.remoteControlError}` : 'off'}`
		);
	}
	if (status.lastError) console.log(`  Last error: ${status.lastError}`);
}

function statusJson(status: LiveModeStatus, extra: Record<string, unknown> = {}) {
	return JSON.stringify({ success: true, ...extra, ...status });
}

export async function liveStatus(options: LiveOptions): Promise<void> {
	let reply: LiveCommandResult;
	try {
		reply = await sendLiveCommand('status');
	} catch (error) {
		failFromError(error, options.json);
	}
	if (!reply.success || !reply.status) {
		failCommand(reply.error || 'Could not read Live mode', options.json);
	}
	if (options.json) {
		console.log(statusJson(reply.status));
		return;
	}
	printStatus(reply.status);
}

async function liveSet(live: boolean, options: LiveOnOptions): Promise<void> {
	const json = options.json;
	const word = live ? 'on' : 'off';

	// Only the bridge calls sit inside the try blocks, so a failCommand exit
	// below is never caught and reported a second time.
	let reply: LiveCommandResult;
	try {
		reply = await sendLiveCommand(word);
	} catch (error) {
		failFromError(error, json);
	}
	if (!reply.success || !reply.status) {
		failCommand(reply.error || `Could not turn Live mode ${word}`, json);
	}

	let status = reply.status;
	const changed = reply.changed === true;
	if (changed) {
		try {
			status = await awaitSwitch(reply.awaitRevision ?? status.revision + 1);
		} catch (error) {
			failFromError(error, json);
		}
		if (status.live !== live) {
			failCommand(status.lastError || `Live mode did not turn ${word}`, json);
		}
	}

	if (live && options.tunnel) {
		status = await startRemoteControlOrFail(json);
	}

	if (json) {
		console.log(statusJson(status, { changed }));
		return;
	}
	console.log(formatSuccess(changed ? `Live mode is ${word}` : `Live mode was already ${word}`));
	printStatus(status);
}

/** Start Remote Control against a Live server that is already up. */
async function startRemoteControlOrFail(json: boolean | undefined): Promise<LiveModeStatus> {
	let reply: LiveCommandResult;
	try {
		reply = await sendLiveCommand('remote-on', REMOTE_CONTROL_TIMEOUT_MS);
	} catch (error) {
		failFromError(error, json);
	}
	if (!reply.success || !reply.status) {
		failCommand(remoteControlErrorWithHint(reply.error || 'Remote Control failed to start'), json);
	}
	return reply.status;
}

export async function liveOn(options: LiveOnOptions): Promise<void> {
	await liveSet(true, options);
}

export async function liveOff(options: LiveOptions): Promise<void> {
	await liveSet(false, options);
}

/** `maestro-cli live tunnel on|off` - Remote Control, the Cloudflare tunnel. */
export async function liveTunnel(state: string, options: LiveOptions): Promise<void> {
	const json = options.json;
	const word = state.trim().toLowerCase();
	if (word !== 'on' && word !== 'off') {
		failCommand(`Expected "on" or "off", got "${state}".`, json);
	}

	let status: LiveModeStatus;
	if (word === 'on') {
		status = await startRemoteControlOrFail(json);
	} else {
		let reply: LiveCommandResult;
		try {
			reply = await sendLiveCommand('remote-off');
		} catch (error) {
			failFromError(error, json);
		}
		if (!reply.success || !reply.status) {
			failCommand(reply.error || 'Remote Control failed to stop', json);
		}
		status = reply.status;
	}

	if (json) {
		console.log(statusJson(status));
		return;
	}
	console.log(formatSuccess(`Remote Control is ${word}`));
	printStatus(status);
}
