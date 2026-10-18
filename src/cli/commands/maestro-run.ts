// MaestroRun commands - `maestro-cli maestro-run ...` (macOS only).
//
// The CLI half of the MaestroRun tile in Settings. Every verb rides the
// `maestro_run_command` WS message to the SAME MaestroRunService the tile's
// buttons call, so the app must be running. `status` is the read for both
// writes: `install` and `grant` are confirmed by the phase it reports.
//
// Not to be confused with the launcher itself: `maestro-run run <script>` is
// MaestroRun's own binary, at the path `status` prints once it is ready.

import { withMaestroClient } from '../services/maestro-client';
import { describeMaestroRunPhase } from '../../shared/maestro-run/status';
import type { MaestroRunCommandAction, MaestroRunStatus } from '../../shared/maestro-run/status';

export interface MaestroRunOptions {
	json?: boolean;
	/** `status`: also ask GitHub for the newest release. */
	checkLatest?: boolean;
	/** `grant`: also show MaestroRun.app in Finder, for dragging into the list. */
	reveal?: boolean;
}

interface MaestroRunResponse {
	type: string;
	success: boolean;
	error?: string;
	status?: MaestroRunStatus;
}

/** A download plus Gatekeeper's notarization check can outlast the default budget. */
const INSTALL_TIMEOUT_MS = 5 * 60_000;

function fail(message: string, options: MaestroRunOptions, status?: MaestroRunStatus): void {
	if (options.json) {
		console.log(JSON.stringify({ success: false, error: message, ...(status ?? {}) }));
	} else {
		console.error(`Error: ${message}`);
	}
	process.exit(1);
}

function printStatus(status: MaestroRunStatus): void {
	console.log(`MaestroRun: ${describeMaestroRunPhase(status)}`);
	if (!status.supported) return;
	console.log(`Feature: ${status.enabled ? 'on' : 'off'}`);
	console.log(`App: ${status.appPath}`);
	if (status.installedVersion) {
		const update = status.updateAvailable ? ` (update available: ${status.latestVersion})` : '';
		console.log(`Version: ${status.installedVersion}${update}`);
	}
	if (status.phase === 'needs-access' || status.phase === 'ready') {
		console.log(`Full Disk Access: ${status.fullDiskAccess}`);
		console.log(`Launcher: ${status.binaryPath}`);
	}
	if (status.watchingForAccess) console.log('Watching for the Full Disk Access switch.');
	if (status.detail) console.log(`Detail: ${status.detail}`);
	if (status.phase === 'not-installed') console.log('Next: maestro-cli maestro-run install');
	if (status.phase === 'needs-access') console.log('Next: maestro-cli maestro-run grant');
}

export async function maestroRun(
	action: MaestroRunCommandAction,
	options: MaestroRunOptions
): Promise<void> {
	const message: Record<string, unknown> = { type: 'maestro_run_command', action };
	if (action === 'status' && options.checkLatest) message.checkLatest = true;
	if (action === 'grant' && options.reveal) message.reveal = true;

	try {
		const result = await withMaestroClient((client) =>
			client.sendCommand<MaestroRunResponse>(
				message,
				'maestro_run_result',
				action === 'install' ? INSTALL_TIMEOUT_MS : undefined
			)
		);
		if (!result.success) {
			fail(result.error || `maestro-run ${action} failed`, options, result.status);
			return;
		}
		if (options.json) {
			console.log(JSON.stringify({ success: true, ...result.status }));
			return;
		}
		if (action === 'grant' && result.status?.phase === 'needs-access') {
			console.log(
				'Opened System Settings on the Full Disk Access list. Switch MaestroRun on; Maestro is watching for it.'
			);
		}
		if (result.status) printStatus(result.status);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error), options);
	}
}
