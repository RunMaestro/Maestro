// Live commands - turn the web interface and its Cloudflare tunnel on and off
// in the running desktop app. Mirrors the LIVE panel in the Left Bar header and
// calls the same main-process Live Mode service it does.
//
// `live on` and `live off` replace the server this CLI is connected through
// (the loopback CLI server and the LAN server share one slot). The app answers
// first with `restarting: true` and then swaps the server, so these commands
// reconnect through the refreshed discovery file and poll `live_status` until
// the swap has landed.

import { withMaestroClient } from '../services/maestro-client';
import { sendSimpleCommand, failCommand } from '../services/session-command';
import { formatSuccess } from '../output/formatter';
import { isQuiet } from '../output/verbosity';
import type { LiveModeState } from '../../shared/liveMode';

/** How long to wait for the server swap before giving up. */
const SWAP_TIMEOUT_MS = 20_000;
/** Pause between status polls while the server swaps. */
const SWAP_POLL_MS = 250;
/** Head start for the old server to go down before the first poll. */
const SWAP_SETTLE_MS = 300;
/** cloudflared can take up to 30s to report a URL (tunnel-manager's own cap). */
const TUNNEL_TIMEOUT_MS = 45_000;

interface LiveOptions {
	json?: boolean;
}

interface LiveOnOptions extends LiveOptions {
	tunnel?: boolean;
}

interface LiveStatusResult extends Partial<LiveModeState> {
	success: boolean;
	error?: string;
	cloudflaredInstalled?: boolean;
}

interface LiveToggleResult extends LiveStatusResult {
	restarting?: boolean;
}

interface TunnelStartResult {
	success: boolean;
	url?: string;
	error?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function readLiveStatus(): Promise<LiveStatusResult> {
	return sendSimpleCommand<LiveStatusResult>({ type: 'live_status' }, 'live_status_result');
}

/**
 * Poll until the app reports `live === expected`. A failed connect is normal
 * here: the discovery file is rewritten mid-swap and the old port goes away.
 */
async function waitForLive(expected: boolean): Promise<LiveStatusResult> {
	const deadline = Date.now() + SWAP_TIMEOUT_MS;
	let lastError: string | null = null;
	await sleep(SWAP_SETTLE_MS);
	while (Date.now() < deadline) {
		try {
			const status = await readLiveStatus();
			if (status.success && status.live === expected) return status;
			lastError = status.error ?? null;
		} catch (error) {
			lastError = errorMessage(error);
		}
		await sleep(SWAP_POLL_MS);
	}
	throw new Error(
		`The web interface did not ${expected ? 'start' : 'stop'} within ${SWAP_TIMEOUT_MS / 1000}s` +
			(lastError ? ` (${lastError})` : '') +
			'. Check `maestro-cli live status` and the System Log.'
	);
}

/** Add the next step to the tunnel errors an agent can act on. */
function tunnelErrorWithHint(error: string): string {
	if (/not installed/i.test(error)) {
		return `${error}. Install cloudflared (macOS: \`brew install cloudflared\`), then retry.`;
	}
	if (/live mode is off/i.test(error)) {
		return `${error} Run \`maestro-cli live on --tunnel\` to start both.`;
	}
	return error;
}

function toJson(status: LiveStatusResult): Record<string, unknown> {
	return {
		success: true,
		live: status.live ?? false,
		url: status.url ?? null,
		tunnel: {
			running: status.tunnel?.isRunning ?? false,
			url: status.tunnel?.url ?? null,
			error: status.tunnel?.error ?? null,
		},
		...(status.cloudflaredInstalled === undefined
			? {}
			: { cloudflaredInstalled: status.cloudflaredInstalled }),
	};
}

function printStatus(status: LiveStatusResult, options: LiveOptions, headline?: string): void {
	if (options.json) {
		console.log(JSON.stringify(toJson(status)));
		return;
	}
	if (headline && !isQuiet()) console.log(formatSuccess(headline));
	console.log(`Web interface: ${status.live ? 'on' : 'off'}`);
	if (status.live && status.url) console.log(`  Local:  ${status.url}`);
	const tunnel = status.tunnel;
	if (tunnel?.isRunning && tunnel.url) {
		console.log(`  Tunnel: ${tunnel.url}`);
	} else if (tunnel?.error) {
		console.log(`  Tunnel: error - ${tunnel.error}`);
	} else {
		console.log('  Tunnel: off');
	}
	if (status.cloudflaredInstalled === false) {
		console.log('  cloudflared is not installed, so the tunnel is unavailable.');
	}
}

/** `maestro-cli live status` */
export async function liveStatus(options: LiveOptions): Promise<void> {
	try {
		const status = await readLiveStatus();
		if (!status.success) throw new Error(status.error || 'Failed to read Live mode');
		printStatus(status, options);
	} catch (error) {
		failCommand(errorMessage(error), options.json);
	}
}

/** Start the tunnel against a Live server that is already up. */
async function startTunnelOrThrow(): Promise<void> {
	const result = await withMaestroClient((client) =>
		client.sendCommand<TunnelStartResult>(
			{ type: 'live_tunnel_start' },
			'live_tunnel_start_result',
			TUNNEL_TIMEOUT_MS
		)
	);
	if (!result.success) {
		throw new Error(tunnelErrorWithHint(result.error || 'Failed to start the tunnel'));
	}
}

/** `maestro-cli live on [--tunnel]` */
export async function liveOn(options: LiveOnOptions): Promise<void> {
	try {
		const start = await sendSimpleCommand<LiveToggleResult>(
			{ type: 'live_start' },
			'live_start_result'
		);
		if (!start.success) throw new Error(start.error || 'Failed to start Live mode');
		if (start.restarting) await waitForLive(true);

		if (options.tunnel) await startTunnelOrThrow();

		const status = await readLiveStatus();
		printStatus(
			status,
			options,
			options.tunnel ? 'Web interface and tunnel are on' : 'Web interface is on'
		);
	} catch (error) {
		failCommand(errorMessage(error), options.json);
	}
}

/** `maestro-cli live off` - stops the tunnel too, as the LIVE panel does. */
export async function liveOff(options: LiveOptions): Promise<void> {
	try {
		const stop = await sendSimpleCommand<LiveToggleResult>(
			{ type: 'live_stop' },
			'live_stop_result'
		);
		if (!stop.success) throw new Error(stop.error || 'Failed to stop Live mode');
		const status = stop.restarting ? await waitForLive(false) : await readLiveStatus();
		printStatus(status, options, 'Web interface is off');
	} catch (error) {
		failCommand(errorMessage(error), options.json);
	}
}

/** `maestro-cli live tunnel <on|off>` */
export async function liveTunnel(state: string, options: LiveOptions): Promise<void> {
	const normalized = state.trim().toLowerCase();
	if (normalized !== 'on' && normalized !== 'off') {
		failCommand(`Expected "on" or "off", got "${state}".`, options.json);
	}
	try {
		if (normalized === 'on') {
			await startTunnelOrThrow();
		} else {
			const stop = await sendSimpleCommand({ type: 'live_tunnel_stop' }, 'live_tunnel_stop_result');
			if (!stop.success) throw new Error(stop.error || 'Failed to stop the tunnel');
		}
		const status = await readLiveStatus();
		printStatus(status, options, normalized === 'on' ? 'Tunnel is on' : 'Tunnel is off');
	} catch (error) {
		failCommand(errorMessage(error), options.json);
	}
}
