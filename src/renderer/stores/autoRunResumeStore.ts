/**
 * Auto Run auto-resume: the fallback that clicks Resume for you.
 *
 * An Auto Run that hits an agent error parks on its error-resolution promise
 * and waits. Two mechanisms already un-park it, and both are conditional on
 * what went wrong - Agent Resilience wants a classified upstream failure, and
 * the limit coordinator wants a quota pause. An ordinary mid-run failure
 * matches neither and sits there until a human notices, which on a long
 * unattended run means the run is dead for however many hours that takes.
 *
 * This store is the unconditional fallback for that case: wait the run's
 * configured interval, resume, and stop after its configured number of
 * attempts so a genuinely stuck run is handed back rather than hammered.
 * `src/shared/autorunAutoResume.ts` explains why it is a separate mechanism
 * rather than a third Agent Resilience strategy.
 *
 * ## Ordering with the two mechanisms that outrank it
 *
 * The error listener asks Agent Resilience first and only falls through to
 * here when resilience declined, so a classified outage keeps its own backoff
 * and its own transcript card - this never double-books a resume. The limit
 * coordinator is not consulted, because it runs on its own clock rather than
 * on the error: instead `scheduleAutoResume` refuses limit errors outright and
 * leaves them to it. Two timers resolving the same promise would resume once
 * and then resume an already-running loop.
 *
 * ## Attempts are counted per run, not per error
 *
 * The ceiling has to mean "this run has failed N times", or a run that fails
 * for a different reason each time never exhausts it. The counter therefore
 * lives on the session and is cleared when the run ends, not when the error
 * changes. It is NOT cleared by a successful resume: five failures spread over
 * a long run still means the run needs a human.
 *
 * Timers are module-scope and deliberately do NOT survive an app quit, exactly
 * like the Agent Resilience timers: on restart there is no parked promise left
 * to resolve, so a timer that outlived the loop would resume nothing.
 */

import { create } from 'zustand';
import type { AgentError } from '../types';
import { isLimitError } from '../../shared/types';
import type { AutoResumePolicy } from '../../shared/autorunAutoResume';
import { getBatchResumer } from '../services/batchResumer';
import { logger } from '../utils/logger';

const LOG_CONTEXT = '[AutoRunResume]';

/** What the UI needs to explain the pause without reaching for the run config. */
export interface AutoResumeEntry {
	sessionId: string;
	/** Automatic resumes already fired for this run. */
	attempts: number;
	/** Ceiling from the run's config, so the badge can say "2 of 5". */
	maxAttempts: number;
	/** Epoch ms the next resume fires, or `null` once we have given up. */
	nextResumeAt: number | null;
	/** True once `attempts` reached `maxAttempts`: only a human continues now. */
	exhausted: boolean;
	/** The failure being waited out, for the badge tooltip. */
	lastMessage: string;
}

interface AutoRunResumeState {
	entries: Record<string, AutoResumeEntry>;
	setEntry: (sessionId: string, entry: AutoResumeEntry | null) => void;
}

export const useAutoRunResumeStore = create<AutoRunResumeState>()((set) => ({
	entries: {},
	setEntry: (sessionId, entry) =>
		set((state) => {
			const next = { ...state.entries };
			if (entry) next[sessionId] = entry;
			else delete next[sessionId];
			return { entries: next };
		}),
}));

const timers = new Map<string, ReturnType<typeof setTimeout>>();

function clearTimer(sessionId: string): void {
	const timer = timers.get(sessionId);
	if (timer) {
		clearTimeout(timer);
		timers.delete(sessionId);
	}
}

/**
 * Schedule an automatic resume for a paused Auto Run, or decline.
 *
 * Returns `true` when a resume is scheduled, which tells the caller the error
 * is being handled - the run stays paused meanwhile, so the error banner and
 * the ERR badge are still correct, they just have a countdown behind them.
 *
 * Declines, each of which leaves the run paused for the user:
 * - no policy (the run turned auto-resume off),
 * - a limit error (the limit coordinator owns those, on its own clock),
 * - no registered resumer (nothing to call; the manual controls still work),
 * - the attempt ceiling is already reached.
 */
export function scheduleAutoResume(
	sessionId: string,
	policy: AutoResumePolicy | null | undefined,
	error: AgentError
): boolean {
	if (!policy) return false;

	// A quota pause is the limit coordinator's job. It probes the provider on an
	// hour scale precisely because resuming before the window reopens just burns
	// an attempt on the same wall, which is exactly what a fixed few-minute timer
	// would do here - and it would burn the whole ceiling doing it.
	if (isLimitError(error)) {
		logger.info(`${LOG_CONTEXT} Limit error left to the limit coordinator`, undefined, {
			sessionId,
		});
		return false;
	}

	if (!getBatchResumer()) {
		logger.warn(`${LOG_CONTEXT} No batch resumer registered; leaving run paused`, undefined, {
			sessionId,
		});
		return false;
	}

	const previous = useAutoRunResumeStore.getState().entries[sessionId];
	const attempts = (previous?.attempts ?? 0) + 1;

	if (attempts > policy.maxAttempts) {
		clearTimer(sessionId);
		useAutoRunResumeStore.getState().setEntry(sessionId, {
			sessionId,
			attempts: previous?.attempts ?? policy.maxAttempts,
			maxAttempts: policy.maxAttempts,
			nextResumeAt: null,
			exhausted: true,
			lastMessage: error.message,
		});
		logger.warn(`${LOG_CONTEXT} Auto-resume exhausted; run needs a human`, undefined, {
			sessionId,
			maxAttempts: policy.maxAttempts,
		});
		return false;
	}

	clearTimer(sessionId);
	const nextResumeAt = Date.now() + policy.delayMs;
	useAutoRunResumeStore.getState().setEntry(sessionId, {
		sessionId,
		attempts,
		maxAttempts: policy.maxAttempts,
		nextResumeAt,
		exhausted: false,
		lastMessage: error.message,
	});

	logger.info(`${LOG_CONTEXT} Scheduled auto-resume`, undefined, {
		sessionId,
		attempt: attempts,
		maxAttempts: policy.maxAttempts,
		delayMs: policy.delayMs,
	});

	timers.set(
		sessionId,
		setTimeout(() => {
			timers.delete(sessionId);
			fireAutoResume(sessionId);
		}, policy.delayMs)
	);
	return true;
}

/**
 * Resume now, keeping the attempt already counted by `scheduleAutoResume`.
 *
 * The entry is kept rather than cleared: the run is still on its Nth attempt,
 * and clearing here would reset the ceiling every time a resume fired, so a run
 * failing forever would auto-resume forever. `clearAutoResume` is what ends it,
 * and the run ending is what calls that.
 */
function fireAutoResume(sessionId: string): void {
	const resumer = getBatchResumer();
	if (!resumer) {
		logger.warn(`${LOG_CONTEXT} Resumer vanished before firing`, undefined, { sessionId });
		return;
	}

	const entry = useAutoRunResumeStore.getState().entries[sessionId];
	if (entry) {
		useAutoRunResumeStore.getState().setEntry(sessionId, { ...entry, nextResumeAt: null });
	}

	logger.info(`${LOG_CONTEXT} Resuming Auto Run`, undefined, {
		sessionId,
		attempt: entry?.attempts,
	});
	resumer(sessionId);
}

/**
 * Fire the pending resume immediately (the countdown's "Resume now"), or do
 * nothing when none is pending.
 */
export function resumeAutoRunNow(sessionId: string): void {
	if (!timers.has(sessionId)) return;
	clearTimer(sessionId);
	fireAutoResume(sessionId);
}

/**
 * Cancel a pending resume WITHOUT forgetting how many attempts this run has
 * already spent.
 *
 * This is what every path that un-parks the run by another route calls: the
 * user clicking Resume or Skip, an abort, and the auto-resume firing itself.
 * It deliberately does not reset `attempts` - if it did, a user who resumed by
 * hand once would hand the run a fresh ceiling, and a run failing forever would
 * auto-resume forever. Only starting or finishing a run resets the count.
 */
export function cancelPendingAutoResume(sessionId: string): void {
	clearTimer(sessionId);
	const entry = useAutoRunResumeStore.getState().entries[sessionId];
	if (entry && entry.nextResumeAt !== null) {
		useAutoRunResumeStore.getState().setEntry(sessionId, { ...entry, nextResumeAt: null });
	}
}

/**
 * Drop a run's auto-resume state and cancel any pending timer.
 *
 * Called when the run ends, is stopped, or the user resolves the error by hand
 * - all of which mean the attempt count has served its purpose. Also called
 * when a run STARTS, so a fresh run on a session that previously exhausted its
 * attempts is not born already exhausted.
 */
export function clearAutoResume(sessionId: string): void {
	clearTimer(sessionId);
	if (useAutoRunResumeStore.getState().entries[sessionId]) {
		useAutoRunResumeStore.getState().setEntry(sessionId, null);
	}
}

/** Reactive read for the ERR badge and its tooltip. */
export function useAutoResumeEntry(sessionId: string): AutoResumeEntry | undefined {
	return useAutoRunResumeStore((s) => s.entries[sessionId]);
}

/** Non-reactive read, for callers already inside an event handler. */
export function getAutoResumeEntry(sessionId: string): AutoResumeEntry | undefined {
	return useAutoRunResumeStore.getState().entries[sessionId];
}

/** Test seam: drop every timer and entry. */
export function resetAutoResumeStateForTests(): void {
	for (const sessionId of [...timers.keys()]) clearTimer(sessionId);
	useAutoRunResumeStore.setState({ entries: {} });
}
