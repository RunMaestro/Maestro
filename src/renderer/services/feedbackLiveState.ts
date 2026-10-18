/**
 * Renderer half of the Feedback chat's self-diagnosis.
 *
 * Main evaluates `window[FEEDBACK_LIVE_STATE_GLOBAL]()` in this window to read
 * the state that exists nowhere else: Auto Run progress, the usage-limit and
 * auto-resume pauses, Agent Resilience retries, and queued messages. See
 * `src/shared/feedbackLiveState.ts` for why and for what is (not) included.
 *
 * Read-only: nothing here writes to a store.
 */

import { isLimitError } from '../../shared/types';
import {
	FEEDBACK_LIVE_STATE_GLOBAL,
	type FeedbackLiveAgent,
	type FeedbackRendererLiveState,
} from '../../shared/feedbackLiveState';
import { useSessionStore } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useAutoRunResumeStore } from '../stores/autoRunResumeStore';
import { useRetryStore } from '../stores/retryStore';
import { captureAutoRunSnapshots } from './debugPackage';

/** Provider error text is capped here; main redacts it before use. */
const MAX_ERROR_MESSAGE_LENGTH = 300;

/** Snapshot every agent worth a look, plus Auto Run counters for all of them. */
export function captureFeedbackLiveState(now = Date.now()): FeedbackRendererLiveState {
	const sessions = useSessionStore.getState().sessions;
	const settings = useSettingsStore.getState();
	const resumeEntries = useAutoRunResumeStore.getState().entries;
	const retries = Object.values(useRetryStore.getState().retries);
	const autoRunSnapshots = captureAutoRunSnapshots();
	const autoRunBySession = new Map(autoRunSnapshots.map((s) => [s.sessionId, s]));

	const agents: FeedbackLiveAgent[] = [];
	for (const session of sessions) {
		const error = session.agentError;
		const run = autoRunBySession.get(session.id);
		const runActive =
			!!run &&
			(run.isRunning ||
				run.isStopping ||
				run.hasError ||
				run.errorPaused ||
				run.completedTasksAcrossAllDocs > 0);
		const resume = resumeEntries[session.id];
		const sessionRetries = retries.filter((r) => r.sessionId === session.id);
		const queuedMessages = session.executionQueue?.length ?? 0;

		const notable =
			session.state !== 'idle' ||
			!!error ||
			runActive ||
			!!resume ||
			sessionRetries.length > 0 ||
			queuedMessages > 0;
		if (!notable) continue;

		agents.push({
			id: session.id,
			name: session.name,
			provider: session.toolType,
			state: session.state,
			sshRemote: !!session.sessionSshRemoteConfig?.enabled,
			queuedMessages,
			...(error
				? {
						error: {
							type: error.type,
							recoverable: error.recoverable,
							paused: !!session.agentErrorPaused,
							limit: isLimitError(error),
							ageMs: now - error.timestamp,
							...(error.limitResetAt !== undefined
								? { limitResetInMs: error.limitResetAt - now }
								: {}),
							...(error.resumeAttemptCount ? { resumeAttempts: error.resumeAttemptCount } : {}),
							message: error.message?.slice(0, MAX_ERROR_MESSAGE_LENGTH),
						},
					}
				: {}),
			...(runActive && run
				? {
						autoRun: {
							...run,
							elapsedMs: run.startTime ? now - run.startTime : undefined,
							idleMs: run.lastActiveTimestamp ? now - run.lastActiveTimestamp : undefined,
						},
					}
				: {}),
			...(resume
				? {
						autoResume: {
							attempts: resume.attempts,
							maxAttempts: resume.maxAttempts,
							nextResumeInMs: resume.nextResumeAt === null ? null : resume.nextResumeAt - now,
							exhausted: resume.exhausted,
						},
					}
				: {}),
			...(sessionRetries.length > 0
				? {
						retries: sessionRetries.map((r) => ({
							strategy: String(r.strategy),
							status: r.status,
							attempt: r.attempt,
							nextRetryInMs: r.nextRetryAt - now,
						})),
					}
				: {}),
		});
	}

	return {
		capturedAt: now,
		agentCount: sessions.length,
		agents,
		autoRunSnapshots,
		settings: {
			autoResumeOnLimit: settings.autoResumeOnLimit,
			autoResumeCheckIntervalHours: settings.autoResumeCheckIntervalHours,
			autoResumeGiveUpDays: settings.autoResumeGiveUpDays,
		},
	};
}

/** Expose the capture to main. Returns the uninstall. */
export function installFeedbackLiveStateHook(): () => void {
	const target = window as unknown as Record<string, unknown>;
	target[FEEDBACK_LIVE_STATE_GLOBAL] = () => captureFeedbackLiveState();
	return () => {
		delete target[FEEDBACK_LIVE_STATE_GLOBAL];
	};
}
