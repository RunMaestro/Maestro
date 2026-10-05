/**
 * Building a desktop fold (4.5) from a client's copy of its agents.
 *
 * The applier (`desktop-fold.ts`) takes a `DesktopFold`; this is its sender's half, shared by the two
 * writers that have a whole agent in hand: the renderer's debounced flush, and the main-process store
 * facade that serves the plugin verbs and other code which still writes `sessions` as an array.
 *
 * It splits an agent along the closed ownership lists (`ownership.ts`):
 *
 * - Desktop-owned keys travel whole, with no comparison. A transcript is megabytes and a flush that
 *   deep-compared it every 2 s would cost more than it saves; the applier lands them as one record.
 * - Domain keys travel only when they differ from `baseline`, the domain view of the last record the
 *   sender applied from the runtime. A site that has not migrated to a command therefore still persists
 *   its domain edit, and the applier lands it only at the revision the sender last saw (DM12).
 * - A tab the baseline lacks is adopted; a tab the baseline holds and the copy lacks is closed.
 *
 * Turn state (`AGENT_TURN_KEYS`, `TAB_TURN_KEYS`) is sent only by a client that folds the agent's
 * stream (4.7): a window that does not own an agent holds a stale copy of its turn state, and sending it
 * could overwrite the transcript another window is writing.
 *
 * Design: `Plans/maestro-tui-desktop-migration.md` sections 4.5 and 4.7.
 */

import { valuesEqual } from '../client/mirror';
import type { AgentRecord, TabRefRecord } from '../store/records';
import type { DesktopFold, DesktopFoldAgent } from './desktop-fold-types';
import { isAgentDomainKey, isTabDomainKey, splitByOwnership } from './ownership';

/** Agent keys the turn path writes (2.2 "Turn state"). Sent only by the client that folds the agent's stream. */
export const AGENT_TURN_KEYS: ReadonlySet<string> = new Set([
	'state',
	'busySource',
	'thinkingStartTime',
	'currentCycleTokens',
	'currentCycleBytes',
	'statusMessage',
	'executionQueue',
	'activeTimeMs',
	'agentError',
	'agentErrorTabId',
	'agentErrorPaused',
	'contextUsage',
	'usageStats',
	'claudeInteractive',
	'aiCommandHistory',
	'shellCommandHistory',
	'shellLogs',
	'workLog',
	'shellCwd',
	'cliActivity',
]);

/** Tab keys the turn path writes. `agentSessionId`, `usageStats`, and `awaitingSessionId` also go through the provider epoch. */
export const TAB_TURN_KEYS: ReadonlySet<string> = new Set([
	'logs',
	'state',
	'thinkingStartTime',
	'agentSessionId',
	'awaitingSessionId',
	'usageStats',
	'agentError',
	'turnProvider',
	'turnModel',
	'turnEffort',
	'isGeneratingName',
	'lastSynopsisTime',
]);

/** Agent keys that are structure, not fields: the tab set and the order have their own parts of a fold. */
const STRUCTURAL_AGENT_KEYS: ReadonlySet<string> = new Set(['aiTabs', 'unifiedTabOrder']);

/**
 * The domain view of the last authoritative record a client applied: the only part a flush compares
 * against. Small by construction (no transcripts, no turn state), so a client can keep one per agent.
 */
export interface FoldBaseline {
	/** The agent's domain keys. */
	domain: Record<string, unknown>;
	/** Each AI tab's domain keys, by tab id. The key set is the set of tabs the runtime holds. */
	tabs: Record<string, Record<string, unknown>>;
	order: TabRefRecord[];
}

const pickDomain = (
	record: Record<string, unknown>,
	isDomain: (key: string) => boolean
): Record<string, unknown> => {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (isDomain(key)) out[key] = value;
	}
	return out;
};

/** The baseline a record gives. Takes the whole record (or a projection) and keeps only its domain part. */
export function baselineOf(record: Record<string, unknown> | AgentRecord): FoldBaseline {
	const source = record as Record<string, unknown>;
	const tabs: Record<string, Record<string, unknown>> = {};
	const aiTabs = Array.isArray(source.aiTabs)
		? (source.aiTabs as Array<Record<string, unknown>>)
		: [];
	for (const tab of aiTabs) {
		if (typeof tab?.id === 'string') tabs[tab.id] = pickDomain(tab, isTabDomainKey);
	}
	return {
		domain: pickDomain(source, isAgentDomainKey),
		tabs,
		order: Array.isArray(source.unifiedTabOrder) ? (source.unifiedTabOrder as TabRefRecord[]) : [],
	};
}

export interface BuildFoldAgentOptions {
	/** The revision the baseline was taken at. Absent: the domain parts are dropped as drift by the applier. */
	baseRev?: number;
	/** The provider the copy was computed under. Default: its `toolType`. */
	provider?: string;
	/** Send turn state. Default true; false for an agent whose stream this client does not fold. */
	ownsStream?: boolean;
}

/** Desktop-owned keys of a record, minus the structural ones and (for a non-owner) the turn state. */
function desktopKeys(
	record: Record<string, unknown>,
	isDomain: (key: string) => boolean,
	turnKeys: ReadonlySet<string>,
	ownsStream: boolean,
	skip: ReadonlySet<string> = new Set()
): Record<string, unknown> {
	const { desktop } = splitByOwnership(record, isDomain);
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(desktop)) {
		if (skip.has(key)) continue;
		if (!ownsStream && turnKeys.has(key)) continue;
		out[key] = value;
	}
	return out;
}

/** The domain keys of `candidate` that differ from `baseline`, `id` excluded. A key the copy dropped is `undefined`. */
function domainDiff(
	candidate: Record<string, unknown>,
	baseline: Record<string, unknown>,
	isDomain: (key: string) => boolean
): Record<string, unknown> | undefined {
	const diff: Record<string, unknown> = {};
	const keys = new Set([...Object.keys(candidate), ...Object.keys(baseline)]);
	for (const key of keys) {
		if (key === 'id' || !isDomain(key)) continue;
		if (valuesEqual(candidate[key], baseline[key])) continue;
		diff[key] = candidate[key];
	}
	return Object.keys(diff).length > 0 ? diff : undefined;
}

/** One agent's entry in a fold: `candidate` is the client's copy, `baseline` what it last applied from the runtime. */
export function buildFoldAgent(
	candidate: Record<string, unknown>,
	baseline: FoldBaseline,
	options: BuildFoldAgentOptions = {}
): DesktopFoldAgent {
	const ownsStream = options.ownsStream !== false;
	const entry: DesktopFoldAgent = {
		id: candidate.id as string,
		provider: options.provider ?? (candidate.toolType as string),
		fields: desktopKeys(
			candidate,
			isAgentDomainKey,
			AGENT_TURN_KEYS,
			ownsStream,
			STRUCTURAL_AGENT_KEYS
		),
		tabs: {},
	};
	if (options.baseRev !== undefined) entry.baseRev = options.baseRev;
	// Structural keys are not in `fields`: `id` is the entry's own, `aiTabs` and `unifiedTabOrder` follow.
	delete entry.fields.id;

	const domain = domainDiff(candidate, baseline.domain, isAgentDomainKey);
	if (domain) entry.domain = domain;

	const aiTabs = Array.isArray(candidate.aiTabs)
		? (candidate.aiTabs as Array<Record<string, unknown>>)
		: [];
	const held = new Set<string>();
	const tabDomain: Record<string, Record<string, unknown>> = {};
	const adoptTabs: Record<string, unknown>[] = [];
	for (const tab of aiTabs) {
		const id = tab?.id;
		if (typeof id !== 'string') continue;
		held.add(id);
		const known = baseline.tabs[id];
		if (!known) {
			// Created without a command: the applier adopts it unless its id was closed earlier.
			adoptTabs.push(tab);
			continue;
		}
		entry.tabs[id] = desktopKeys(tab, isTabDomainKey, TAB_TURN_KEYS, ownsStream);
		const diff = domainDiff(tab, known, isTabDomainKey);
		if (diff) tabDomain[id] = diff;
	}
	if (Object.keys(tabDomain).length > 0) entry.tabDomain = tabDomain;
	if (adoptTabs.length > 0) entry.adoptTabs = adoptTabs;

	const closeTabs = Object.keys(baseline.tabs).filter((id) => !held.has(id));
	if (closeTabs.length > 0) entry.closeTabs = closeTabs;

	if (
		Array.isArray(candidate.unifiedTabOrder) &&
		!valuesEqual(candidate.unifiedTabOrder, baseline.order)
	) {
		entry.order = candidate.unifiedTabOrder as TabRefRecord[];
	}
	return entry;
}

export interface BuildFoldOptions {
	/** The baseline of each agent the runtime holds, with the revision it was taken at. */
	baselines: ReadonlyMap<string, { baseline: FoldBaseline; rev?: number }>;
	/** Whether this client folds the stream of an agent. Default: all of them. */
	ownsStream?: (agentId: string) => boolean;
	/**
	 * `setAll` meaning for a whole-array writer: an agent the baselines hold that `candidates` leaves
	 * out is removed. Default false: a fold never removes an agent because it was left out.
	 */
	removeAbsent?: boolean;
	activeSessionId?: string;
}

/**
 * A whole fold from an array of agents. An agent the baselines lack is adopted; the rest become entries.
 * The groups part is the caller's (`collapsed` and the group list live beside the sessions, not in them).
 */
export function buildFold(
	candidates: readonly Record<string, unknown>[],
	options: BuildFoldOptions
): DesktopFold {
	const fold: DesktopFold = { agents: [] };
	const seen = new Set<string>();
	for (const candidate of candidates) {
		const id = candidate?.id;
		if (typeof id !== 'string') continue;
		seen.add(id);
		const known = options.baselines.get(id);
		if (!known) {
			(fold.adoptAgents ??= []).push(candidate);
			continue;
		}
		fold.agents.push(
			buildFoldAgent(candidate, known.baseline, {
				...(known.rev !== undefined ? { baseRev: known.rev } : {}),
				ownsStream: options.ownsStream ? options.ownsStream(id) : true,
			})
		);
	}
	if (options.removeAbsent) {
		const removed = [...options.baselines.keys()].filter((id) => !seen.has(id));
		if (removed.length > 0) fold.removeAgents = removed;
	}
	if (options.activeSessionId !== undefined) fold.activeSessionId = options.activeSessionId;
	return fold;
}
