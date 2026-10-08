import type { CueConfig, CueSessionStatus, CueSettings, CueSubscription } from './cue-types';
import type { CueTriggerSource } from './triggers/cue-trigger-source';

/**
 * Internal state per session with an active Cue config.
 *
 * Phase 4 cleanup: replaced the previous parallel `timers: Timer[]` /
 * `watchers: (() => void)[]` arrays with a single `triggerSources` array.
 * Each source owns its own underlying mechanism (interval, watcher, poller)
 * and reports its next-fire time via `nextTriggerAt()`.
 */
export interface SessionState {
	config: CueConfig;
	/** When the config was loaded from an ancestor directory (not the session's own
	 *  projectRoot), this records the ancestor root so refreshes reload from the
	 *  correct location. Undefined when the config lives at the session's own root. */
	configRoot?: string;
	triggerSources: CueTriggerSource[];
	lastTriggered?: string;
	/** Non-empty when this session's unowned subscriptions are suppressed because
	 *  ownership of the cue.yaml is contested or unresolvable. Used by the Cue
	 *  dashboard to surface a red indicator with the reason. */
	ownershipWarning?: string;
}

/**
 * Returns true when `sub` is reported as "active for" the given session - the
 * session is either the owner (by agent_id) OR an unowned legacy sub OR a
 * participating fan-out target.
 *
 * Fan-out subscriptions are owned by a single agent (so the trigger source is
 * wired exactly once, on the owner), but every fan_out target runs when the
 * trigger fires. From the dashboard's point of view all targets are active
 * participants and should surface Status=Active + a Run Now button. Matching
 * fan_out by both sessionName and sessionId mirrors the dispatch service's
 * lookup (`s.name === targetName || s.id === targetName`).
 */
export function isSubscriptionParticipant(
	sub: CueSubscription,
	sessionId: string,
	sessionName: string
): boolean {
	if (!sub.agent_id) return true;
	if (sub.agent_id === sessionId) return true;
	if (sub.fan_out && (sub.fan_out.includes(sessionName) || sub.fan_out.includes(sessionId))) {
		return true;
	}
	return false;
}

export function countActiveSubscriptions(
	subscriptions: CueSubscription[],
	sessionId: string,
	sessionName: string
): number {
	return subscriptions.filter(
		(sub) => sub.enabled !== false && isSubscriptionParticipant(sub, sessionId, sessionName)
	).length;
}

export function getEarliestNextTriggerIso(state: SessionState): string | undefined {
	let earliest: number | null = null;
	for (const source of state.triggerSources) {
		const next = source.nextTriggerAt();
		if (next == null) continue;
		if (earliest === null || next < earliest) {
			earliest = next;
		}
	}
	return earliest === null ? undefined : new Date(earliest).toISOString();
}

export function hasTimeBasedSubscriptions(config: CueConfig, sessionId: string): boolean {
	return config.subscriptions.some(
		(sub) =>
			sub.enabled !== false &&
			(!sub.agent_id || sub.agent_id === sessionId) &&
			((sub.event === 'time.heartbeat' &&
				typeof sub.interval_minutes === 'number' &&
				sub.interval_minutes > 0) ||
				(sub.event === 'time.scheduled' &&
					Array.isArray(sub.schedule_times) &&
					sub.schedule_times.length > 0))
	);
}

/**
 * Minimal shape needed by {@link computeOwnershipWarning}. Kept intentionally
 * narrow so tests don't need to construct full `SessionInfo` objects.
 */
export interface OwnershipCandidate {
	id: string;
	name: string;
	projectRoot: string;
}

/** The part of a cue config {@link computeOwnershipWarning} reads. */
export interface OwnershipConfig {
	settings: Pick<CueSettings, 'owner_agent_id'>;
}

/**
 * The sessions that compete for ownership of a cue.yaml: a tool type that
 * participates in Cue AND a cue config at their projectRoot. A terminal (or
 * any non-AI-agent) session, or one with no config, could otherwise win the
 * implicit first-in-list race at a shared projectRoot, become the "owner",
 * have nothing to dispatch, and silently suppress automation on the real
 * Cue-configured agent. The runtime and the readiness check both pass this
 * list to {@link computeOwnershipWarning}, so they pick the same owner.
 */
export function selectOwnershipCandidates<T extends OwnershipCandidate & { toolType: string }>(
	sessions: T[],
	hasCueConfig: (projectRoot: string) => boolean
): T[] {
	return sessions.filter((s) => s.toolType !== 'terminal' && hasCueConfig(s.projectRoot));
}

/**
 * Compute the ownership warning for a session that just loaded `config`.
 *
 * Returns `undefined` when the session is the effective owner (no warning is
 * needed). Returns a human-readable string otherwise - that string is the
 * single source of truth: presence means the Cue dashboard shows a red `!`
 * and uses the string as the tooltip; absence means no indicator.
 *
 * `candidates` must be pre-filtered by the caller to only include sessions
 * that would actually load this same cue.yaml - i.e. sessions whose
 * `projectRoot` contains a readable cue config. Sessions without a config
 * must not be included, otherwise a config-less agent could "win" the
 * implicit-first race and silently disable automation for the workspace.
 *
 * Ownership resolution:
 *   • `configFromAncestor` true → always `undefined`. Ancestor configs already
 *     filter to subscriptions explicitly targeting this session, so the gate
 *     doesn't apply.
 *   • `owner_agent_id` set and matches some candidate (by id or name) sharing
 *     the session's `projectRoot` → the first matching candidate owns; other
 *     candidates in the same root get a tooltip pointing to the owner. If
 *     multiple candidates match by name (display-name collision), this picks
 *     the first deterministically and tells non-winners to use the full id.
 *   • `owner_agent_id` set but matches nobody in the session's `projectRoot`
 *     → every candidate in that root gets a tooltip about the bad value.
 *   • `owner_agent_id` unset and >1 candidate shares the root → first in the
 *     list wins; non-winners get a tooltip naming the winner.
 */
export function computeOwnershipWarning(params: {
	session: OwnershipCandidate;
	candidates: OwnershipCandidate[];
	config: OwnershipConfig;
	configFromAncestor: boolean;
}): string | undefined {
	if (params.configFromAncestor) return undefined;

	const { session, candidates, config } = params;
	const explicitOwner = config.settings.owner_agent_id?.trim();
	const sameRoot = candidates.filter((s) => s.projectRoot === session.projectRoot);

	if (explicitOwner) {
		// Prefer id match (ids are globally unique). Only consult name match
		// when no candidate matches by id, so a session that happens to have
		// a display name equal to some other agent's id string cannot
		// accidentally claim ownership. Name matches can themselves be
		// ambiguous (two agents sharing a display name); that's reported as
		// unresolved rather than silently picking one.
		let owner: OwnershipCandidate | undefined;
		const byId = sameRoot.filter((s) => s.id === explicitOwner);
		if (byId.length === 1) {
			owner = byId[0];
		} else if (byId.length === 0) {
			const byName = sameRoot.filter((s) => s.name === explicitOwner);
			if (byName.length === 1) {
				owner = byName[0];
			} else if (byName.length > 1) {
				const matchingIds = byName.map((s) => s.id).join(', ');
				return `settings.owner_agent_id "${explicitOwner}" is ambiguous - matches ${byName.length} agents in this projectRoot by display name (ids: ${matchingIds}). Unowned subscriptions are disabled until this is fixed; use a full agent id to disambiguate.`;
			}
		}

		if (!owner) {
			return `settings.owner_agent_id "${explicitOwner}" does not match any agent in this projectRoot - unowned subscriptions are disabled until this is fixed.`;
		}
		if (owner.id === session.id) return undefined;
		// Show the resolved display name rather than the raw `explicitOwner`
		// value, which is often a UUID - the dashboard tooltip is meant to be
		// human-readable, and a bare uuid is unhelpful at a glance.
		return `settings.owner_agent_id targets "${owner.name}" - unowned subscriptions run on that agent instead.`;
	}

	const firstForRoot = sameRoot[0];
	if (firstForRoot && firstForRoot.id !== session.id) {
		return `"${firstForRoot.name}" was selected as the owner of this projectRoot (no settings.owner_agent_id set - first agent wins). Set settings.owner_agent_id in cue.yaml to choose a different owner.`;
	}
	return undefined;
}

/** Who runs a cue.yaml's unpinned subscriptions at one projectRoot. */
export interface ConfigOwnerResolution<T> {
	/** The agent that runs them. Absent when no agent does. */
	owner?: T;
	/**
	 * Why no agent does: the runtime's own ownership warning (a
	 * settings.owner_agent_id that matches nobody in the root, or more than
	 * one agent by display name). Absent when there is an owner.
	 */
	problem?: string;
}

/**
 * The owner of the config at `projectRoot`, decided for each session there
 * exactly as `initSession` decides it: the first session
 * {@link computeOwnershipWarning} clears, over the
 * {@link selectOwnershipCandidates} candidates. The readiness check and the
 * bundle exporter call this so they agree with the running engine.
 */
export function resolveConfigOwner<T extends OwnershipCandidate & { toolType: string }>(params: {
	projectRoot: string;
	sessions: T[];
	hasCueConfig: (projectRoot: string) => boolean;
	config: OwnershipConfig;
}): ConfigOwnerResolution<T> {
	const candidates = selectOwnershipCandidates(params.sessions, params.hasCueConfig);
	let problem: string | undefined;
	for (const session of params.sessions) {
		if (session.projectRoot !== params.projectRoot) continue;
		const warning = computeOwnershipWarning({
			session,
			candidates,
			config: params.config,
			configFromAncestor: false,
		});
		if (!warning) return { owner: session };
		problem ??= warning;
	}
	return { problem };
}

export function toSessionStatus(params: {
	sessionId: string;
	sessionName: string;
	toolType: string;
	projectRoot: string;
	enabled: boolean;
	subscriptionCount: number;
	activeRuns: number;
	state?: SessionState;
}): CueSessionStatus {
	return {
		sessionId: params.sessionId,
		sessionName: params.sessionName,
		toolType: params.toolType,
		projectRoot: params.projectRoot,
		enabled: params.enabled,
		subscriptionCount: params.subscriptionCount,
		activeRuns: params.activeRuns,
		lastTriggered: params.state?.lastTriggered,
		nextTrigger: params.state ? getEarliestNextTriggerIso(params.state) : undefined,
		ownershipWarning: params.state?.ownershipWarning,
	};
}
