import {
	DEFAULT_CUE_SETTINGS,
	type CueConfig,
	type CueGraphSession,
	type CueSessionStatus,
	type CueSettings,
} from './cue-types';
import {
	countActiveSubscriptions,
	isSubscriptionParticipant,
	toSessionStatus,
	type SessionState,
} from './cue-session-state';

export interface CueQueryServiceDeps {
	getAllSessions: () => Array<{
		id: string;
		name: string;
		toolType: string;
		projectRoot: string;
	}>;
	getSessionStates: () => Map<string, SessionState>;
	getActiveRunCount: (sessionId: string) => number;
	loadConfigForProjectRoot: (projectRoot: string) => CueConfig | null;
}

export interface CueQueryService {
	getStatus(): CueSessionStatus[];
	getGraphData(): CueGraphSession[];
	getSettings(): CueSettings;
}

export function createCueQueryService(deps: CueQueryServiceDeps): CueQueryService {
	return {
		getStatus(): CueSessionStatus[] {
			const result: CueSessionStatus[] = [];
			const allSessions = deps.getAllSessions();
			const reportedSessionIds = new Set<string>();

			for (const [sessionId, state] of deps.getSessionStates()) {
				const session = allSessions.find((candidate) => candidate.id === sessionId);
				if (!session) continue;

				reportedSessionIds.add(sessionId);
				result.push(
					toSessionStatus({
						sessionId,
						sessionName: session.name,
						toolType: session.toolType,
						projectRoot: session.projectRoot,
						enabled: true,
						subscriptionCount: countActiveSubscriptions(
							state.config.subscriptions,
							sessionId,
							session.name
						),
						activeRuns: deps.getActiveRunCount(sessionId),
						state,
					})
				);
			}

			for (const session of allSessions) {
				if (reportedSessionIds.has(session.id)) continue;
				const config = deps.loadConfigForProjectRoot(session.projectRoot);
				if (!config) continue;

				result.push(
					toSessionStatus({
						sessionId: session.id,
						sessionName: session.name,
						toolType: session.toolType,
						projectRoot: session.projectRoot,
						enabled: false,
						subscriptionCount: countActiveSubscriptions(
							config.subscriptions,
							session.id,
							session.name
						),
						activeRuns: 0,
					})
				);
			}

			return result;
		},

		getGraphData(): CueGraphSession[] {
			const result: CueGraphSession[] = [];
			const allSessions = deps.getAllSessions();
			const reportedSessionIds = new Set<string>();

			for (const [sessionId, state] of deps.getSessionStates()) {
				const session = allSessions.find((candidate) => candidate.id === sessionId);
				if (!session) continue;

				reportedSessionIds.add(sessionId);
				result.push({
					sessionId,
					sessionName: session.name,
					toolType: session.toolType,
					// Report every subscription the session participates in: unbound
					// (legacy / shared), owned (agent_id match), or fan-out target
					// (session name / id appears in the owner's fan_out list). Fan-out
					// targets must appear here so the dashboard can surface each
					// participating agent with Status=Active and a Run Now button —
					// otherwise a 1-trigger → N-agents pipeline shows only the owner.
					subscriptions: state.config.subscriptions.filter((sub) =>
						isSubscriptionParticipant(sub, sessionId, session.name)
					),
				});
			}

			for (const session of allSessions) {
				if (reportedSessionIds.has(session.id)) continue;
				const config = deps.loadConfigForProjectRoot(session.projectRoot);
				if (!config) continue;

				result.push({
					sessionId: session.id,
					sessionName: session.name,
					toolType: session.toolType,
					subscriptions: config.subscriptions.filter((sub) =>
						isSubscriptionParticipant(sub, session.id, session.name)
					),
				});
			}

			return result;
		},

		getSettings(): CueSettings {
			for (const [, state] of deps.getSessionStates()) {
				return { ...state.config.settings };
			}
			return { ...DEFAULT_CUE_SETTINGS };
		},
	};
}
