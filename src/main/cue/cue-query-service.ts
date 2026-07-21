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
import { traverseCueSessions, type CueQuerySession } from './cue-query-traversal';

export interface CueQueryServiceDeps {
	getAllSessions: () => CueQuerySession[];
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
			return traverseCueSessions({
				sessions: deps.getAllSessions(),
				sessionStates: deps.getSessionStates(),
				loadConfigForProjectRoot: deps.loadConfigForProjectRoot,
			}).map(({ session, state, config, active }) =>
				toSessionStatus({
					sessionId: session.id,
					sessionName: session.name,
					toolType: session.toolType,
					projectRoot: session.projectRoot,
					enabled: active,
					subscriptionCount: countActiveSubscriptions(
						config.subscriptions,
						session.id,
						session.name
					),
					activeRuns: state ? deps.getActiveRunCount(session.id) : 0,
					state,
				})
			);
		},

		getGraphData(): CueGraphSession[] {
			return traverseCueSessions({
				sessions: deps.getAllSessions(),
				sessionStates: deps.getSessionStates(),
				loadConfigForProjectRoot: deps.loadConfigForProjectRoot,
			}).map(({ session, config }) => ({
				sessionId: session.id,
				sessionName: session.name,
				toolType: session.toolType,
				// Keep disabled subscriptions and unresolved/cyclic fan-out metadata
				// intact; this is a projection, not a graph walk.
				subscriptions: config.subscriptions.filter((sub) =>
					isSubscriptionParticipant(sub, session.id, session.name)
				),
			}));
		},

		getSettings(): CueSettings {
			for (const [, state] of deps.getSessionStates()) {
				// `owner_agent_id` is per-root: it names an agent that must live at
				// THAT cue.yaml's projectRoot. Never surface it as a "global"
				// setting — otherwise the Settings modal reads the first session's
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
