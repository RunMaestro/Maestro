/**
 * Fan-in completion tracker for the Cue Engine.
 *
 * Tracks multi-source agent.completed subscriptions: when a subscription
 * lists multiple source_sessions, this module accumulates completions
 * and fires the downstream subscription when all sources have reported
 * (or on timeout, depending on the timeout_on_fail setting).
 */

import type { MainLogLevel } from '../../shared/logger-types';
import type { SessionInfo } from '../../shared/types';
import {
	createCueEvent,
	type AgentCompletionData,
	type CueEvent,
	type CueSettings,
	type CueSubscription,
} from './cue-types';
import {
	buildFilteredOutputs,
	SOURCE_OUTPUT_MAX_CHARS,
	type FanInSourceCompletion,
} from './cue-output-filter';
import { sliceTailByChars } from './cue-text-utils';
import type { CueFanInPersistence, CueFanInStateRecord } from './cue-fan-in-persistence';

// Re-exports preserve call-site compatibility for existing importers.
export { SOURCE_OUTPUT_MAX_CHARS, type FanInSourceCompletion };

export interface CueFanInDeps {
	onLog: (level: MainLogLevel, message: string, data?: unknown) => void;
	getSessions: () => SessionInfo[];
	dispatchSubscription: (
		ownerSessionId: string,
		sub: CueSubscription,
		event: CueEvent,
		sourceSessionName: string,
		chainDepth?: number,
		promptOverride?: string,
		chainRootId?: string,
		parentEventId?: string
	) => number;
	/**
	 * Write-through durability (standalone engine only, see
	 * cue-fan-in-persistence.ts). Absent: the tracker is in memory only, as on
	 * the desktop.
	 */
	persistence?: CueFanInPersistence;
}

/** What `restore` needs to know about a fan-in subscription as configured NOW. */
export type FanInRestoreLookup = (
	ownerSessionId: string,
	subscriptionName: string
) => { sub: CueSubscription; settings: CueSettings; sources: string[] } | null;

/** Outcome of `CueFanInTracker.restore`. */
export interface FanInRestoreResult {
	/** Fan-ins re-armed with their remaining time. */
	resumed: number;
	/** Fan-ins whose timeout ran out while the engine was down; `timeout_on_fail` applied. */
	expired: number;
	/** Fan-ins that had every source already and fired. */
	completed: number;
	/** Fan-ins dropped because their subscription or a source no longer exists. */
	invalid: number;
}

/**
 * Health status for a single active fan-in tracker. Phase 12D surfaces these
 * entries in the dashboard when a stall exceeds 50% of the configured timeout
 * so users can intervene before the tracker actually times out.
 */
export interface FanInHealthEntry {
	key: string;
	ownerSessionId: string;
	subscriptionName: string;
	completedCount: number;
	expectedCount: number;
	elapsedMs: number;
	timeoutMs: number;
	percentElapsed: number;
	pendingSourceIds: string[];
	firstCompletionAt: number;
}

/** Parameters for `checkHealth`. Caller looks up per-tracker subscription config. */
export interface FanInHealthCheckParams {
	sessions: SessionInfo[];
	lookupSubscription: (
		key: string
	) => { sub: CueSubscription; settings: CueSettings; sources: string[] } | null;
	now?: number;
}

export interface CueFanInTracker {
	handleCompletion(
		ownerSessionId: string,
		settings: CueSettings,
		sub: CueSubscription,
		sources: string[],
		completedSessionId: string,
		completedSessionName: string,
		completionData?: AgentCompletionData
	): void;
	clearForSession(sessionId: string): void;
	reset(): void;
	/**
	 * Forget every tracker in memory (timers included) WITHOUT deleting
	 * persisted progress. The drain's teardown: what it keeps on disk is
	 * restored at the next start.
	 */
	forgetInMemory(): void;
	/**
	 * Rebuild partial fan-ins from persisted progress at engine start. The
	 * timeout counts from when the first source arrived, wall clock, downtime
	 * included: one that already ran out gets `timeout_on_fail` exactly as a
	 * live timeout would. Rows whose subscription or sources no longer exist
	 * are dropped and logged.
	 */
	restore(
		rows: CueFanInStateRecord[],
		lookup: FanInRestoreLookup,
		now?: number
	): FanInRestoreResult;
	/** Returns all active tracker keys (for cleanup inspection). */
	getActiveTrackerKeys(): string[];
	/** Returns the ms timestamp when the first completion arrived for a tracker, or undefined if not found. */
	getTrackerCreatedAt(key: string): number | undefined;
	/** Force-expire a tracker by key without dispatching or waiting for timeout. Used by the cleanup service. */
	expireTracker(key: string): void;
	/**
	 * Phase 12D - returns active trackers stalled >50% of their timeout. Empty
	 * result is the healthy case. Caller supplies `lookupSubscription` since
	 * the tracker itself doesn't hold subscription config.
	 */
	checkHealth(params: FanInHealthCheckParams): FanInHealthEntry[];
}

export function createCueFanInTracker(deps: CueFanInDeps): CueFanInTracker {
	const fanInTrackers = new Map<string, Map<string, FanInSourceCompletion>>();
	const fanInTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/** Tracks when the first completion arrived for each tracker key (for cleanup staleness checks). */
	const fanInCreatedAt = new Map<string, number>();
	/** Owner and subscription per tracker key, so persisted rows can be addressed without re-splitting the key. */
	const fanInOwners = new Map<string, { ownerSessionId: string; subscriptionName: string }>();

	/** Drop a tracker from memory and, when durable, its persisted rows. */
	function forgetTracker(key: string, opts: { keepPersisted?: boolean } = {}): void {
		const owner = fanInOwners.get(key);
		fanInTrackers.delete(key);
		fanInCreatedAt.delete(key);
		fanInOwners.delete(key);
		const timer = fanInTimers.get(key);
		if (timer) {
			clearTimeout(timer);
			fanInTimers.delete(key);
		}
		if (owner && !opts.keepPersisted) {
			deps.persistence?.remove(owner.ownerSessionId, owner.subscriptionName);
		}
	}

	function timeoutMsFor(sub: CueSubscription, settings: CueSettings): number {
		return (sub.fan_in_timeout_minutes ?? settings.timeout_minutes ?? 30) * 60 * 1000;
	}

	/** Every source has completed: drop the tracker (rows first: at most once) and dispatch. */
	function fireComplete(key: string, ownerSessionId: string, sub: CueSubscription): void {
		const tracker = fanInTrackers.get(key);
		if (!tracker) return;
		forgetTracker(key);

		const completions = [...tracker.values()];
		const { outputCompletions, perSourceOutputs, forwardedOutputs } = buildFilteredOutputs(
			completions,
			sub
		);

		const event = createCueEvent('agent.completed', sub.name, {
			completedSessions: completions.map((c) => c.sessionId),
			sourceSession: completions.map((c) => c.sessionName).join(', '),
			sourceOutput: outputCompletions.map((c) => c.output).join('\n---\n'),
			outputTruncated: outputCompletions.some((c) => c.truncated),
			perSourceOutputs,
			...(Object.keys(forwardedOutputs).length > 0 ? { forwardedOutputs } : {}),
		});
		const maxChainDepth =
			completions.length > 0 ? Math.max(...completions.map((c) => c.chainDepth)) : 0;
		deps.onLog('cue', `[CUE] "${sub.name}" triggered (agent.completed, fan-in complete)`);
		deps.dispatchSubscription(
			ownerSessionId,
			sub,
			event,
			completions.map((c) => c.sessionName).join(', '),
			maxChainDepth
		);
	}

	/**
	 * Resolve a user-authored `sources` list (names or IDs, possibly mixed) to a
	 * deduped set of canonical session IDs. This is the source of truth for
	 * fan-in completion counting - the raw `sources.length` is NOT reliable
	 * because (a) the same session may be referenced by both name and ID, and
	 * (b) names may fail to resolve, in which case we fall back to treating the
	 * raw string as an identity (same as the pre-refactor behavior) so a user's
	 * config never silently hangs fan-in.
	 */
	function resolveSourcesToIds(sources: string[]): Set<string> {
		const allSessions = deps.getSessions();
		const resolved = new Set<string>();
		for (const src of sources) {
			const session = allSessions.find((s) => s.name === src || s.id === src);
			resolved.add(session?.id ?? src);
		}
		return resolved;
	}

	function handleFanInTimeout(
		key: string,
		ownerSessionId: string,
		settings: CueSettings,
		sub: CueSubscription,
		sources: string[]
	): void {
		fanInTimers.delete(key);
		const tracker = fanInTrackers.get(key);
		if (!tracker) return;

		const completedNames = [...tracker.values()].map((c) => c.sessionName);
		const completedIds = new Set([...tracker.keys()]);

		// Determine which sources haven't completed yet - using the canonical
		// resolved-ID set so duplicate references (name + id for same session)
		// don't get reported twice as timed out.
		const resolvedSourceIds = resolveSourcesToIds(sources);
		const timedOutSources: string[] = [];
		for (const resolvedId of resolvedSourceIds) {
			if (!completedIds.has(resolvedId)) {
				timedOutSources.push(resolvedId);
			}
		}

		// Total counted against the deduped resolved-ID set, not the raw
		// `sources` array. The user's yaml may list the same session by both
		// name and id ('Agent A' + 'agent-a'); the dedupe pass collapses those
		// to a single entry, and the log totals must reflect the deduped count
		// or they'll show misleading "1/2 completed" messages when the fan-in
		// is actually waiting for 0 more sources.
		const totalSources = resolvedSourceIds.size;

		if ((sub.fan_in_timeout_on_fail ?? settings.timeout_on_fail) === 'continue') {
			// Fire with partial data
			const completions = [...tracker.values()];
			forgetTracker(key);

			const { outputCompletions, perSourceOutputs, forwardedOutputs } = buildFilteredOutputs(
				completions,
				sub
			);

			const event = createCueEvent('agent.completed', sub.name, {
				completedSessions: completions.map((c) => c.sessionId),
				timedOutSessions: timedOutSources,
				sourceSession: completions.map((c) => c.sessionName).join(', '),
				sourceOutput: outputCompletions.map((c) => c.output).join('\n---\n'),
				outputTruncated: outputCompletions.some((c) => c.truncated),
				perSourceOutputs,
				...(Object.keys(forwardedOutputs).length > 0 ? { forwardedOutputs } : {}),
				partial: true,
			});
			const maxChainDepth =
				completions.length > 0 ? Math.max(...completions.map((c) => c.chainDepth)) : 0;
			deps.onLog(
				'cue',
				`[CUE] Fan-in "${sub.name}" timed out (continue mode) - firing with ${completedNames.length}/${totalSources} sources`
			);
			deps.dispatchSubscription(
				ownerSessionId,
				sub,
				event,
				completedNames.join(', '),
				maxChainDepth
			);
		} else {
			// 'break' mode - log failure and clear
			forgetTracker(key);
			deps.onLog(
				'cue',
				`[CUE] Fan-in "${sub.name}" timed out (break mode) - ${completedNames.length}/${totalSources} completed, waiting for: ${timedOutSources.join(', ')}`
			);
		}
	}

	return {
		handleCompletion(
			ownerSessionId: string,
			settings: CueSettings,
			sub: CueSubscription,
			sources: string[],
			completedSessionId: string,
			completedSessionName: string,
			completionData?: AgentCompletionData
		): void {
			const key = `${ownerSessionId}:${sub.name}`;

			if (!fanInTrackers.has(key)) {
				fanInTrackers.set(key, new Map());
			}
			const tracker = fanInTrackers.get(key)!;
			fanInOwners.set(key, { ownerSessionId, subscriptionName: sub.name });
			const rawOutput = completionData?.stdout ?? '';
			const completion: FanInSourceCompletion = {
				sessionId: completedSessionId,
				sessionName: completedSessionName,
				output: sliceTailByChars(rawOutput, SOURCE_OUTPUT_MAX_CHARS),
				truncated: rawOutput.length > SOURCE_OUTPUT_MAX_CHARS,
				chainDepth: completionData?.chainDepth ?? 0,
			};
			tracker.set(completedSessionId, completion);

			// Start timeout timer on first source completion
			if (tracker.size === 1 && !fanInTimers.has(key)) {
				fanInCreatedAt.set(key, Date.now());
				const timer = setTimeout(
					() => {
						handleFanInTimeout(key, ownerSessionId, settings, sub, sources);
					},
					timeoutMsFor(sub, settings)
				);
				fanInTimers.set(key, timer);
			}

			// Write-through, so a crash or a drain keeps this source's arrival.
			const now = Date.now();
			deps.persistence?.saveSource({
				ownerSessionId,
				subscriptionName: sub.name,
				sourceSessionId: completion.sessionId,
				sourceSessionName: completion.sessionName,
				output: completion.output,
				truncated: completion.truncated,
				chainDepth: completion.chainDepth,
				startedAt: fanInCreatedAt.get(key) ?? now,
				completedAt: now,
			});

			// Use the deduped resolved-ID set as the completion target so fan-in
			// does not hang when the same session is referenced by both name and
			// ID in the user's yaml.
			const resolvedSourceIds = resolveSourcesToIds(sources);
			const remainingIds: string[] = [];
			for (const resolvedId of resolvedSourceIds) {
				if (!tracker.has(resolvedId)) remainingIds.push(resolvedId);
			}

			if (remainingIds.length > 0) {
				deps.onLog(
					'cue',
					`[CUE] Fan-in "${sub.name}": waiting for ${remainingIds.length} more session(s)`
				);
				return;
			}

			// All sources completed - fire.
			fireComplete(key, ownerSessionId, sub);
		},

		clearForSession(sessionId: string): void {
			for (const key of [...fanInTrackers.keys()]) {
				if (key.startsWith(`${sessionId}:`)) forgetTracker(key);
			}
		},

		reset(): void {
			// Per key rather than a table wipe: cue.db is shared by every engine
			// on the data dir, and only this tracker's rows are its to delete.
			for (const key of [...fanInTrackers.keys()]) forgetTracker(key);
			for (const timer of fanInTimers.values()) {
				clearTimeout(timer);
			}
			fanInTimers.clear();
			fanInCreatedAt.clear();
		},

		forgetInMemory(): void {
			for (const key of [...fanInTrackers.keys()]) forgetTracker(key, { keepPersisted: true });
			for (const timer of fanInTimers.values()) {
				clearTimeout(timer);
			}
			fanInTimers.clear();
		},

		restore(rows, lookup, now = Date.now()): FanInRestoreResult {
			const result: FanInRestoreResult = { resumed: 0, expired: 0, completed: 0, invalid: 0 };
			const groups = new Map<string, CueFanInStateRecord[]>();
			for (const row of rows) {
				const key = `${row.ownerSessionId}:${row.subscriptionName}`;
				const group = groups.get(key) ?? [];
				group.push(row);
				groups.set(key, group);
			}

			for (const [key, group] of groups) {
				const { ownerSessionId, subscriptionName } = group[0];
				const config = lookup(ownerSessionId, subscriptionName);
				const resolved = config ? resolveSourcesToIds(config.sources) : new Set<string>();
				const strangers = group.filter((row) => !resolved.has(row.sourceSessionId));
				if (!config || resolved.size < 2 || strangers.length > 0) {
					deps.persistence?.remove(ownerSessionId, subscriptionName);
					result.invalid++;
					deps.onLog(
						'warn',
						!config || resolved.size < 2
							? `[CUE] Dropped saved fan-in progress for "${subscriptionName}": the subscription is no longer a fan-in in cue.yaml`
							: `[CUE] Dropped saved fan-in progress for "${subscriptionName}": source(s) ${strangers.map((r) => r.sourceSessionName).join(', ')} are no longer among its sources`
					);
					continue;
				}

				const { sub, settings, sources } = config;
				const tracker = new Map<string, FanInSourceCompletion>();
				for (const row of group) {
					tracker.set(row.sourceSessionId, {
						sessionId: row.sourceSessionId,
						sessionName: row.sourceSessionName,
						output: row.output,
						truncated: row.truncated,
						chainDepth: row.chainDepth,
					});
				}
				const startedAt = Math.min(...group.map((row) => row.startedAt));
				fanInTrackers.set(key, tracker);
				fanInCreatedAt.set(key, startedAt);
				fanInOwners.set(key, { ownerSessionId, subscriptionName });

				if ([...resolved].every((id) => tracker.has(id))) {
					result.completed++;
					fireComplete(key, ownerSessionId, sub);
					continue;
				}

				const remainingMs = timeoutMsFor(sub, settings) - (now - startedAt);
				if (remainingMs <= 0) {
					result.expired++;
					deps.onLog(
						'cue',
						`[CUE] Saved fan-in "${subscriptionName}" ran out of time while the engine was down (${tracker.size}/${resolved.size} sources) - applying timeout_on_fail`
					);
					handleFanInTimeout(key, ownerSessionId, settings, sub, sources);
					continue;
				}

				const timer = setTimeout(() => {
					handleFanInTimeout(key, ownerSessionId, settings, sub, sources);
				}, remainingMs);
				fanInTimers.set(key, timer);
				result.resumed++;
			}
			return result;
		},

		getActiveTrackerKeys(): string[] {
			return [...fanInTrackers.keys()];
		},

		getTrackerCreatedAt(key: string): number | undefined {
			return fanInCreatedAt.get(key);
		},

		expireTracker(key: string): void {
			forgetTracker(key);
		},

		// Phase 12D - return entries for trackers stalled > 50% of their timeout.
		// The tracker doesn't know its subscription config, so we accept a
		// `lookupSubscription` callback that the engine wires up against its
		// registry. Entries whose subscription can't be resolved (renamed /
		// deleted mid-wait) are excluded - the cleanup service will evict them.
		checkHealth({
			sessions,
			lookupSubscription,
			now = Date.now(),
		}: FanInHealthCheckParams): FanInHealthEntry[] {
			const out: FanInHealthEntry[] = [];
			for (const [key, tracker] of fanInTrackers) {
				const createdAt = fanInCreatedAt.get(key);
				if (createdAt === undefined) continue;
				const lookup = lookupSubscription(key);
				if (!lookup) continue;

				const { sub, settings, sources } = lookup;
				const timeoutMs =
					(sub.fan_in_timeout_minutes ?? settings.timeout_minutes ?? 30) * 60 * 1000;
				// Clamp clock-backward cases to 0 so we never report phantom negative stalls.
				const elapsedMs = Math.max(0, now - createdAt);
				const percentElapsed = timeoutMs > 0 ? (elapsedMs / timeoutMs) * 100 : 0;
				if (percentElapsed <= 50) continue;

				// Resolve expected count via dedup - same logic used for completion counting.
				// We inline it here because calling the private helper from outside the
				// closure would require exposing it, which leaks implementation detail.
				const resolvedExpected = new Set<string>();
				for (const s of sources) {
					const match = sessions.find((sess) => sess.name === s || sess.id === s);
					resolvedExpected.add(match?.id ?? s);
				}
				const completedIds = new Set(tracker.keys());
				const pendingSourceIds: string[] = [];
				for (const id of resolvedExpected) {
					if (!completedIds.has(id)) pendingSourceIds.push(id);
				}

				const [ownerSessionId, ...subNameParts] = key.split(':');
				out.push({
					key,
					ownerSessionId,
					subscriptionName: subNameParts.join(':'),
					completedCount: tracker.size,
					expectedCount: resolvedExpected.size,
					elapsedMs,
					timeoutMs,
					percentElapsed,
					pendingSourceIds,
					firstCompletionAt: createdAt,
				});
			}
			return out;
		},
	};
}
