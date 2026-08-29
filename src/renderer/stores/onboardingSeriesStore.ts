/**
 * Runs the first-run modal series as a sequence rather than three independent
 * modals.
 *
 * Each step's own dismiss handler advances this store, so exactly one modal is
 * mounted at a time and the next opens only when the previous closes. The
 * alternative - three modals each self-gating on their own flag - would open
 * all of them at once on a fresh install and stack them by z-index, which is
 * how you get a user answering the third question first.
 *
 * The store holds only the running sequence. Whether a step has been SEEN lives
 * in settings, because that has to survive a restart; this does not.
 */

import { create } from 'zustand';
import {
	planOnboardingSeries,
	type OnboardingAudience,
	type OnboardingStep,
} from '../../shared/onboardingSeries';

interface OnboardingSeriesState {
	/** Steps still to run, current one first. Empty when idle. */
	queue: OnboardingStep[];
	/** Who the copy is addressed to. Null when idle. */
	audience: OnboardingAudience | null;
	/**
	 * True when a debug palette entry started this run. The steps still behave
	 * normally, but the caller can skip persisting "seen" so a replay does not
	 * consume the real first run.
	 */
	forced: boolean;
	/** Begin a series. A no-op when the planned queue is empty. */
	start: (params: {
		audience: OnboardingAudience;
		queue: OnboardingStep[];
		forced?: boolean;
	}) => void;
	/** Finish the current step and open the next, or end the series. */
	advance: () => void;
	/** Abandon the whole series without running the remaining steps. */
	stop: () => void;
}

export const useOnboardingSeriesStore = create<OnboardingSeriesState>((set) => ({
	queue: [],
	audience: null,
	forced: false,

	start: ({ audience, queue, forced = false }) => {
		if (queue.length === 0) return;
		set({ queue, audience, forced });
	},

	advance: () =>
		set((state) => {
			const next = state.queue.slice(1);
			// Clearing the audience with the queue keeps "idle" a single
			// observable state, so a stale audience cannot outlive its series and
			// address the next one with the wrong copy.
			return next.length === 0 ? { queue: next, audience: null, forced: false } : { queue: next };
		}),

	stop: () => set({ queue: [], audience: null, forced: false }),
}));

/** The step currently on screen, or null when no series is running. */
export function selectCurrentOnboardingStep(state: OnboardingSeriesState): OnboardingStep | null {
	return state.queue[0] ?? null;
}

/** Imperative access for the debug palette entries and the startup effect. */
export function getOnboardingSeriesActions() {
	const { start, advance, stop } = useOnboardingSeriesStore.getState();
	return { start, advance, stop };
}

/**
 * Plan and start a series in one call. Returns whether anything will be shown,
 * so the caller can tell "nothing to do" from "started".
 */
export function startOnboardingSeries(params: {
	audience: OnboardingAudience;
	seen: Partial<Record<OnboardingStep, boolean>>;
	activeThemeId: string;
	forced?: boolean;
}): boolean {
	const queue = planOnboardingSeries({
		audience: params.audience,
		seen: params.seen,
		activeThemeId: params.activeThemeId,
		force: params.forced,
	});
	useOnboardingSeriesStore
		.getState()
		.start({ audience: params.audience, queue, forced: params.forced });
	return queue.length > 0;
}

/**
 * Replay a series from the debug palette, ignoring every seen flag AND the
 * theme gate, so the whole sequence is reachable on an install that has
 * already been through it. `forced` is threaded through so the steps can skip
 * persisting "seen" and leave the real first run intact.
 */
export function replayOnboardingSeries(audience: OnboardingAudience): void {
	startOnboardingSeries({ audience, seen: {}, activeThemeId: '', forced: true });
}

/**
 * Console access, mirroring the other first-run modals.
 * Usage: window.__replayOnboarding('new' | 'returning')
 */
export function exposeOnboardingSeriesDebug(): void {
	(window as unknown as Record<string, unknown>).__replayOnboarding = (
		audience: OnboardingAudience = 'new'
	) => replayOnboardingSeries(audience);
}
