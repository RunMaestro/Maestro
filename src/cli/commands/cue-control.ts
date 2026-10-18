/**
 * `maestro-cli cue enable|disable|activity` - the Cue dashboard's per-
 * subscription toggle and its activity log, for an agent.
 *
 * `cue schedule --pause/--resume` only reaches clock-driven subscriptions;
 * these reach every event type. The toggle writes the subscription's
 * `enabled` flag into its cue.yaml through the engine, exactly as the UI's
 * switch does.
 *
 * `activity` asks the running app first, since its in-memory log holds runs
 * still in flight and their output. When the app is not running it reads
 * `cue.db` itself, read-only, through the same mapping the app uses.
 */

import { withMaestroClient } from '../services/maestro-client';
import { MaestroNotRunningError } from '../services/maestro-not-running';
import {
	errorFrameMessage,
	failCommand,
	failFromError,
	resolveAgentOrFail,
} from '../services/session-command';
import { applyDataDirOption } from '../services/data-dir-option';
import { readSessions } from '../services/storage';
import { SqliteUnavailableError } from '../utils/native-sqlite';
import {
	CUE_ACTIVITY_LOG_MAX,
	cueEventRecordsToRunResults,
	toCueActivityEntries,
} from '../../main/cue/cue-activity-entries';
import type { CueActivityEntry } from '../../main/web-server/types';
import { readCueEngineLock } from '../../main/cue/cue-engine-lock';

interface CueSubscriptionSummary {
	id: string;
	name: string;
	eventType: string;
	sessionId: string;
	sessionName: string;
	enabled: boolean;
}

interface ToggleOptions {
	agent?: string;
	json?: boolean;
}

interface ActivityOptions {
	agent?: string;
	limit?: string;
	json?: boolean;
	/** Explicit data directory; wins over MAESTRO_USER_DATA (see data-dir-option.ts). */
	dataDir?: string;
}

/**
 * Resolve what the caller typed to one subscription. Accepts the full id
 * (`<agent>::<pipeline>::<name>`, as `cue list --json` prints it) or a name.
 * A name that several agents share is refused unless `--agent` narrows it:
 * toggling the wrong agent's automation is not a guess worth making.
 */
export function resolveSubscription(
	subs: CueSubscriptionSummary[],
	target: string,
	agentId?: string
): CueSubscriptionSummary {
	const byId = subs.find((s) => s.id === target);
	if (byId) return byId;
	const pool = agentId ? subs.filter((s) => s.sessionId === agentId) : subs;
	const matches = pool.filter((s) => s.name === target);
	if (matches.length === 1) return matches[0];
	if (matches.length > 1) {
		const owners = matches.map((s) => `${s.sessionName} (${s.sessionId})`).join(', ');
		throw new Error(
			`"${target}" names ${matches.length} subscriptions (${owners}). Pass --agent or the full id from \`cue list --json\`.`
		);
	}
	throw new Error(`No Cue subscription named "${target}"${agentId ? ` on ${agentId}` : ''}.`);
}

async function setEnabled(target: string, enabled: boolean, options: ToggleOptions): Promise<void> {
	const agentId = options.agent ? resolveAgentOrFail(options.agent, options.json) : undefined;
	let sub: CueSubscriptionSummary;
	let reply: Record<string, unknown>;
	try {
		reply = await withMaestroClient(async (client) => {
			const list = await client.sendCommand<{ subscriptions?: CueSubscriptionSummary[] }>(
				{ type: 'get_cue_subscriptions' },
				'cue_subscriptions'
			);
			sub = resolveSubscription(list.subscriptions ?? [], target, agentId);
			return client.sendCommand<Record<string, unknown>>(
				{ type: 'toggle_cue_subscription', subscriptionId: sub.id, enabled },
				'toggle_cue_subscription_result'
			);
		});
	} catch (error) {
		failFromError(error, options.json);
	}

	const frameError = errorFrameMessage(reply);
	if (frameError) failCommand(frameError, options.json);
	if (reply.success !== true) {
		failCommand(`Could not ${enabled ? 'enable' : 'disable'} "${sub!.name}"`, options.json);
	}

	if (options.json) {
		console.log(JSON.stringify({ success: true, subscriptionId: sub!.id, enabled }));
	} else {
		console.log(`${enabled ? 'Enabled' : 'Disabled'} ${sub!.name} (${sub!.sessionName})`);
	}
}

export function cueEnable(target: string, options: ToggleOptions): Promise<void> {
	return setEnabled(target, true, options);
}

export function cueDisable(target: string, options: ToggleOptions): Promise<void> {
	return setEnabled(target, false, options);
}

/**
 * Activity from `cue.db`, for when the desktop app is not running: the same
 * window of runs the app restores at start, through the same mapping, filter
 * and limit, so `--json` is the same `CueActivityEntry[]` either way. Never
 * `initCueDb()`: a headless engine may own the database, possibly as another
 * user, and this read must not create, migrate or re-journal it.
 */
async function readActivityFromCueDb(
	sessionId: string | undefined,
	limit: number,
	json?: boolean
): Promise<CueActivityEntry[]> {
	const { readRecentCueEventsReadOnly } = await import('../../main/cue/cue-db');
	// A `running` row is a run in flight only while a live engine owns this
	// data directory (the lock and cue.db both resolve from MAESTRO_USER_DATA,
	// which --data-dir sets). Without one it is an orphan and reads as failed.
	// The lock is read BEFORE the database, so "running" always rests on an
	// engine that was live no later than the rows were read. Read the other
	// way, an engine that drained and released the lock between the two reads
	// would turn runs it had just finished into "failed", which is the
	// misleading answer this exists to avoid. The remaining window (an engine
	// killed between the reads) shows a run as running that was running a
	// moment ago, and the next read reports it failed.
	const engineLive = readCueEngineLock() !== null;
	let read: ReturnType<typeof readRecentCueEventsReadOnly>;
	try {
		read = readRecentCueEventsReadOnly(CUE_ACTIVITY_LOG_MAX);
	} catch (error) {
		if (error instanceof SqliteUnavailableError) failCommand(error.message, json);
		throw error;
	}
	if (!read.ok) {
		failCommand(
			`The desktop app is not running and Cue run history could not be read: ${read.reason}`,
			json
		);
	}
	const sessionNamesById = new Map(readSessions().map((s) => [s.id, s.name]));
	const runs = cueEventRecordsToRunResults(read.records, sessionNamesById, {
		keepRunning: engineLive,
	});
	return toCueActivityEntries(runs, { sessionId, limit });
}

/** `cue activity` - recent Cue runs, newest first. */
export async function cueActivity(options: ActivityOptions): Promise<void> {
	// First, so the agent lookup, the app's discovery file and cue.db all come
	// from the one directory, as for the `cue engine` verbs.
	applyDataDirOption(options.dataDir);
	const sessionId = options.agent ? resolveAgentOrFail(options.agent, options.json) : undefined;
	const limit = options.limit === undefined ? 20 : Number(options.limit);
	if (!Number.isInteger(limit) || limit <= 0) {
		failCommand(`--limit expects a positive integer, got "${options.limit}"`, options.json);
	}

	let reply: ({ entries?: CueActivityEntry[] } & Record<string, unknown>) | null;
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand<{ entries?: CueActivityEntry[] } & Record<string, unknown>>(
				{ type: 'get_cue_activity', sessionId, limit },
				'cue_activity'
			)
		);
	} catch (error) {
		// Only an absent app falls back. Any other failure (an old build, a
		// timeout, a renderer that never answered) is reported as before
		// rather than masked by figures from disk.
		if (!(error instanceof MaestroNotRunningError)) failFromError(error, options.json);
		reply = null;
	}

	let entries: CueActivityEntry[];
	if (reply) {
		const frameError = errorFrameMessage(reply);
		if (frameError) failCommand(frameError, options.json);
		entries = reply.entries ?? [];
	} else {
		entries = await readActivityFromCueDb(sessionId, limit, options.json);
	}
	const fromDatabase = reply === null;

	if (options.json) {
		console.log(JSON.stringify(entries, null, 2));
		return;
	}
	if (fromDatabase) {
		// stderr, so stdout stays the same lines the app's answer prints.
		console.error(
			'Read from cue.db: the desktop app is not running, so run output is not included.'
		);
	}
	if (entries.length === 0) {
		console.log('No Cue activity.');
		return;
	}
	for (const entry of entries) {
		const when = new Date(entry.timestamp).toLocaleString();
		// A run in flight has no duration yet: show how long it has run so far.
		const took =
			typeof entry.duration === 'number'
				? `  ${(entry.duration / 1000).toFixed(1)}s`
				: entry.status === 'running'
					? `  ${(Math.max(0, Date.now() - entry.timestamp) / 1000).toFixed(1)}s so far`
					: '';
		console.log(
			`${when}  ${entry.status.padEnd(9)}  ${entry.subscriptionName}  [${entry.eventType}]${took}`
		);
	}
}
