/**
 * `maestro-cli app-stats` - the palette's "Debug: View Application Stats", for
 * an agent. Memory, CPU and process counts for Electron, every agent tree and
 * the model server, the models resident in the main process, and the disk
 * Local Models occupies.
 *
 * The snapshot is `collectAppStats()` in the running app, the same function the
 * modal reads. The modal's per-agent data footprint (logs, file tree) is held
 * by the renderer alone and is not part of it.
 */

import type { AppStatsSnapshot } from '../../shared/appStats';
import { formatAppStats } from '../output/formatter';
import { sendBridgeCommand } from '../services/session-command';

/** Measuring model directories walks every file; give a large store room. */
const APP_STATS_TIMEOUT_MS = 30_000;

interface AppStatsOptions {
	json?: boolean;
}

export async function appStats(options: AppStatsOptions): Promise<void> {
	const reply = await sendBridgeCommand<{
		success: boolean;
		error?: string;
		snapshot: AppStatsSnapshot;
	}>({ type: 'app_stats' }, 'app_stats_result', options.json, APP_STATS_TIMEOUT_MS);

	if (options.json) {
		console.log(JSON.stringify({ success: true, ...reply.snapshot }));
		return;
	}
	console.log(formatAppStats(reply.snapshot));
}
