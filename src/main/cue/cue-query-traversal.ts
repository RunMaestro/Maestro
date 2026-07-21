import type { CueConfig } from './cue-types';
import type { SessionState } from './cue-session-state';

/** The minimal session shape shared by Cue status and graph projections. */
export interface CueQuerySession {
	id: string;
	name: string;
	toolType: string;
	projectRoot: string;
}

/**
 * A single deterministic Cue session/config pair.
 *
 * Active registry entries are yielded first in registry insertion order. Sessions
 * that only have a config on disk follow in the caller-provided session order.
 * The traversal never follows subscription references: fan-out cycles and
 * missing targets remain data for the projection layer, rather than becoming
 * recursion or a reason to omit a configured (including disabled) node.
 */
export interface CueSessionTraversalEntry {
	session: CueQuerySession;
	config: CueConfig;
	state?: SessionState;
	active: boolean;
}

export interface CueSessionTraversalInput {
	sessions: readonly CueQuerySession[];
	sessionStates: ReadonlyMap<string, SessionState>;
	loadConfigForProjectRoot: (projectRoot: string) => CueConfig | null;
	/** Bound result size without changing which inputs are considered active. */
	limit?: number;
}

export function traverseCueSessions({
	sessions,
	sessionStates,
	loadConfigForProjectRoot,
	limit,
}: CueSessionTraversalInput): CueSessionTraversalEntry[] {
	const firstSessionById = new Map<string, CueQuerySession>();
	for (const session of sessions) {
		if (!firstSessionById.has(session.id)) {
			firstSessionById.set(session.id, session);
		}
	}

	const result: CueSessionTraversalEntry[] = [];
	const reportedSessionIds = new Set<string>();

	for (const [sessionId, state] of sessionStates) {
		const session = firstSessionById.get(sessionId);
		if (!session) continue;
		reportedSessionIds.add(sessionId);
		result.push({ session, config: state.config, state, active: true });
	}

	for (const session of sessions) {
		if (reportedSessionIds.has(session.id)) continue;
		const config = loadConfigForProjectRoot(session.projectRoot);
		if (!config) continue;
		result.push({ session, config, active: false });
	}

	if (limit === undefined) return result;
	if (!Number.isSafeInteger(limit) || limit < 0) {
		throw new RangeError(
			`Cue session traversal limit must be a non-negative safe integer, got ${limit}`
		);
	}
	return result.slice(0, limit);
}
