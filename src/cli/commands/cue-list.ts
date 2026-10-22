import { withMaestroClient } from '../services/maestro-client';
import { exitIfMaestroNotRunning } from '../services/session-command';
import { formatCueTurnSettings, type CueTurnSettings } from '../../shared/cue/turn-settings';
import { exitWith, exitCodeForError } from '../exit-codes';

interface CueListOptions {
	json?: boolean;
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
	gate?: string;
	gateOnUnavailable?: 'run' | 'skip';
	screenInjection?: boolean;
	injectionThreshold?: number;
	lastTriggered?: number;
	triggerCount: number;
	tier?: CueTurnSettings['tier'];
	model?: string;
	effort?: CueTurnSettings['effort'];
}

export async function cueList(options: CueListOptions): Promise<void> {
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

		const subs = result.subscriptions ?? [];

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
				if (sub.gate) {
					lines.push(`     gate: ${sub.gate}`);
				}
				// Only a screen someone set is listed; the default is silent.
				if (sub.screenInjection !== undefined) {
					lines.push(`     injection screen: ${sub.screenInjection ? 'on' : 'off'}`);
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
		exitWith(exitCodeForError(error));
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
