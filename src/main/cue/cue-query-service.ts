import type { CueFailureStreak } from '../../shared/cue/failure-streak';
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
	/** Current failure streaks for one agent. Optional so older test doubles still build. */
	getFailureStreaks?: (sessionId: string) => CueFailureStreak[];
	loadConfigForProjectRoot: (projectRoot: string) => CueConfig | null;
}

export interface CueQueryService {
	getStatus(): CueSessionStatus[];
	getGraphData(): CueGraphSession[];
	getSettings(): CueSettings;
}

export function createCueQueryService(deps: CueQueryServiceDeps): CueQueryService {
	/**
	 * Streaks at or past the alert threshold, limited to subscriptions the agent
	 * still runs: a renamed or deleted subscription must not keep the row red.
	 */
	function failingSubscriptionsFor(
		sessionId: string,
		sessionName: string,
		state: SessionState
	): CueFailureStreak[] | undefined {
		const live = new Set(
			state.config.subscriptions
				.filter(
					(sub) => sub.enabled !== false && isSubscriptionParticipant(sub, sessionId, sessionName)
				)
				.map((sub) => sub.name)
		);
		const failing = (deps.getFailureStreaks?.(sessionId) ?? []).filter(
			(streak) => streak.failing && live.has(streak.subscriptionName)
		);
		return failing.length > 0 ? failing : undefined;
	}

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
						failingSubscriptions: failingSubscriptionsFor(sessionId, session.name, state),
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
					// participating agent with Status=Active and a Run Now button -
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
				// `owner_agent_id` is per-root: it names an agent that must live at
				// THAT cue.yaml's projectRoot. Never surface it as a "global"
				// setting - otherwise the Settings modal reads the first session's
				// owner and `saveSettings()` writes it into EVERY cue.yaml, flagging
				// unrelated single-agent projects with a bogus "owner_agent_id does
				// not match any agent" ownership warning.
				const { owner_agent_id: _perRootOwner, ...global } = state.config.settings;
				return { ...global };
			}
			return { ...DEFAULT_CUE_SETTINGS };
		},
	};
}
