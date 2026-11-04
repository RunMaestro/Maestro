/**
 * `maestro-cli cue list` - every agent's Cue subscriptions.
 *
 * The peer serving the data directory answers: the desktop app, or a headless
 * `maestro-cli host` from the Cue engine it runs. A host that cannot answer
 * (its Cue is held by another engine or did not start, or it is an older
 * build) leaves the list to be read from each agent's cue.yaml, through the
 * same query the engine answers with for an agent it is not running. An
 * absent desktop app is reported as ever (exit 3).
 */

import { withMaestroClient } from '../services/maestro-client';
import { diskFallbackPeer, exitIfMaestroNotRunning } from '../services/session-command';
import { applyDataDirOption, requireDataDirOrExit } from '../services/data-dir-option';
import { readLiveSessions } from '../services/storage';
import { formatCueTurnSettings, type CueTurnSettings } from '../../shared/cue/turn-settings';
import { createCueQueryService } from '../../main/cue/cue-query-service';
import { loadCueConfigDetailed } from '../../main/cue/cue-yaml-loader';
import { toCueSubscriptionInfos } from '../../main/cue/cue-subscription-entries';
import type { CueSubscriptionInfo } from '../../main/web-server/types';

interface CueListOptions {
	json?: boolean;
	/** Explicit data directory; decides which host (or desktop) is asked and whose cue.yaml is read. */
	dataDir?: string;
}

/** On stderr beside a list read from disk, so stdout stays what the peer's answer prints. */
export const CUE_YAML_FALLBACK_NOTE =
	"Read from each agent's cue.yaml: the headless host (`maestro-cli host`) is not running Cue here, or is an older build that cannot answer.";

/**
 * Subscriptions read from disk, as the engine's `getGraphData()` reports an
 * agent it has not started: the same live agents the headless engine reads,
 * the same validating loader, the same participant filter, the same mapping.
 */
export function readCueSubscriptionsFromDisk(sessionId?: string): CueSubscriptionInfo[] {
	const query = createCueQueryService({
		getAllSessions: () =>
			readLiveSessions().map((session) => ({
				id: session.id,
				name: session.name,
				toolType: session.toolType,
				projectRoot: session.projectRoot,
			})),
		getSessionStates: () => new Map(),
		getActiveRunCount: () => 0,
		loadConfigForProjectRoot: (projectRoot) => {
			const result = loadCueConfigDetailed(projectRoot);
			return result.ok ? result.config : null;
		},
	});
	return toCueSubscriptionInfos(query.getGraphData(), sessionId);
}

interface CueSubscription {
	id: string;
	name: string;
	eventType: string;
	pattern?: string;
	schedule?: string;
	sessionId: string;
	sessionName: string;
	enabled: boolean;
	lastTriggered?: number;
	triggerCount: number;
	tier?: CueTurnSettings['tier'];
	model?: string;
	effort?: CueTurnSettings['effort'];
}

export async function cueList(options: CueListOptions): Promise<void> {
	// First, so the discovery file, the agent list and every cue.yaml come from the one directory.
	if (options.dataDir !== undefined) {
		applyDataDirOption(options.dataDir);
		requireDataDirOrExit({ json: options.json });
	}
	try {
		let subs: CueSubscription[];
		try {
			const result = await withMaestroClient(async (client) => {
				return client.sendCommand<{
					type: string;
					subscriptions: CueSubscription[];
				}>(
					{
						type: 'get_cue_subscriptions',
					},
					'cue_subscriptions'
				);
			});
			subs = result.subscriptions ?? [];
		} catch (error) {
			// Only a headless host that could not answer falls back. An absent
			// desktop, an old desktop build, or a timeout is reported below.
			if (diskFallbackPeer(error) !== 'headless-host') throw error;
			subs = readCueSubscriptionsFromDisk();
			if (!options.json) console.error(CUE_YAML_FALLBACK_NOTE);
		}

		if (options.json) {
			console.log(JSON.stringify(subs, null, 2));
		} else if (subs.length === 0) {
			console.log('No Cue subscriptions found.');
		} else {
			const lines: string[] = [];
			lines.push(`Cue Subscriptions (${subs.length}):\n`);

			for (const sub of subs) {
				const status = sub.enabled ? '✓' : '✗';
				const triggered = sub.lastTriggered
					? `last: ${formatTimeAgo(sub.lastTriggered)}`
					: 'never triggered';
				lines.push(`  ${status}  ${sub.name}`);
				lines.push(`     event: ${sub.eventType}  |  agent: ${sub.sessionName}  |  ${triggered}`);
				if (sub.pattern) {
					lines.push(`     pattern: ${sub.pattern}`);
				}
				if (sub.schedule) {
					lines.push(`     schedule: ${sub.schedule}`);
				}
				const modelNote = formatCueTurnSettings(sub);
				if (modelNote) {
					lines.push(`     model: ${modelNote}`);
				}
				lines.push('');
			}

			console.log(lines.join('\n'));
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

function formatTimeAgo(timestamp: number): string {
	const diff = Date.now() - timestamp;
	const minutes = Math.floor(diff / 60000);
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}
