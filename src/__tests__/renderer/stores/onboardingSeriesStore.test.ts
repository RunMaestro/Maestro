import { describe, it, expect, beforeEach } from 'vitest';
import {
	replayOnboardingSeries,
	selectCanGoBackInOnboarding,
	selectCurrentOnboardingStep,
	startOnboardingSeries,
	useOnboardingSeriesStore,
} from '../../../renderer/stores/onboardingSeriesStore';
import { DEFAULT_THEME_ID, ONBOARDING_STEPS } from '../../../shared/onboardingSeries';

beforeEach(() => {
	useOnboardingSeriesStore.setState({ queue: [], history: [], audience: null, forced: false });
});

const current = () => selectCurrentOnboardingStep(useOnboardingSeriesStore.getState());

describe('onboardingSeriesStore', () => {
	it('shows one step at a time, in order', () => {
		// Three self-gating modals would open at once and stack by z-index, and
		// the user would answer the last question first.
		startOnboardingSeries({ audience: 'new', seen: {}, activeThemeId: DEFAULT_THEME_ID });

		expect(current()).toBe('typography');
		useOnboardingSeriesStore.getState().advance();
		expect(current()).toBe('theme');
		useOnboardingSeriesStore.getState().advance();
		expect(current()).toBe('agentPowers');
	});

	it('ends the series after the last step', () => {
		startOnboardingSeries({ audience: 'new', seen: {}, activeThemeId: DEFAULT_THEME_ID });
		for (let i = 0; i < ONBOARDING_STEPS.length; i++) {
			useOnboardingSeriesStore.getState().advance();
		}

		expect(current()).toBeNull();
		expect(useOnboardingSeriesStore.getState().audience).toBeNull();
	});

	it('clears the audience with the queue, so it cannot outlive its series', () => {
		// A stale audience would address the next series with the wrong copy.
		startOnboardingSeries({
			audience: 'returning',
			seen: { typography: true, theme: true },
			activeThemeId: DEFAULT_THEME_ID,
		});
		expect(useOnboardingSeriesStore.getState().audience).toBe('returning');

		useOnboardingSeriesStore.getState().advance();
		expect(useOnboardingSeriesStore.getState().audience).toBeNull();
	});

	it('reports whether anything will actually be shown', () => {
		const started = startOnboardingSeries({
			audience: 'new',
			seen: { typography: true, theme: true, agentPowers: true },
			activeThemeId: DEFAULT_THEME_ID,
		});

		expect(started).toBe(false);
		expect(current()).toBeNull();
	});

	it('does not start an empty series', () => {
		startOnboardingSeries({
			audience: 'returning',
			seen: { typography: true, theme: true, agentPowers: true },
			activeThemeId: 'nord',
		});

		expect(useOnboardingSeriesStore.getState().audience).toBeNull();
	});

	describe('back', () => {
		it('reopens the previous step', () => {
			startOnboardingSeries({ audience: 'new', seen: {}, activeThemeId: DEFAULT_THEME_ID });
			useOnboardingSeriesStore.getState().advance();
			expect(current()).toBe('theme');

			useOnboardingSeriesStore.getState().back();
			expect(current()).toBe('typography');
		});

		it('walks forward again from where it went back to', () => {
			startOnboardingSeries({ audience: 'new', seen: {}, activeThemeId: DEFAULT_THEME_ID });
			useOnboardingSeriesStore.getState().advance();
			useOnboardingSeriesStore.getState().back();
			useOnboardingSeriesStore.getState().advance();

			expect(current()).toBe('theme');
			// The step it came back from must not be lost on the way forward.
			expect(useOnboardingSeriesStore.getState().queue).toEqual(['theme', 'agentPowers']);
		});

		it('is a no-op on the first step', () => {
			startOnboardingSeries({ audience: 'new', seen: {}, activeThemeId: DEFAULT_THEME_ID });
			useOnboardingSeriesStore.getState().back();

			expect(current()).toBe('typography');
			expect(selectCanGoBackInOnboarding(useOnboardingSeriesStore.getState())).toBe(false);
		});

		it('reports a step to go back to only after one has been left', () => {
			startOnboardingSeries({ audience: 'new', seen: {}, activeThemeId: DEFAULT_THEME_ID });
			expect(selectCanGoBackInOnboarding(useOnboardingSeriesStore.getState())).toBe(false);

			useOnboardingSeriesStore.getState().advance();
			expect(selectCanGoBackInOnboarding(useOnboardingSeriesStore.getState())).toBe(true);
		});

		it('has nothing to go back to once the series ends', () => {
			// The queue is empty, so a leftover history would offer a Back into a
			// series that is no longer on screen.
			startOnboardingSeries({ audience: 'new', seen: {}, activeThemeId: DEFAULT_THEME_ID });
			for (let i = 0; i < ONBOARDING_STEPS.length; i++) {
				useOnboardingSeriesStore.getState().advance();
			}

			expect(selectCanGoBackInOnboarding(useOnboardingSeriesStore.getState())).toBe(false);
			expect(useOnboardingSeriesStore.getState().history).toEqual([]);
		});

		it('starts a new series with no history from the previous one', () => {
			startOnboardingSeries({ audience: 'new', seen: {}, activeThemeId: DEFAULT_THEME_ID });
			useOnboardingSeriesStore.getState().advance();
			startOnboardingSeries({ audience: 'new', seen: {}, activeThemeId: DEFAULT_THEME_ID });

			expect(selectCanGoBackInOnboarding(useOnboardingSeriesStore.getState())).toBe(false);
		});
	});

	it('stop abandons the remaining steps', () => {
		startOnboardingSeries({ audience: 'new', seen: {}, activeThemeId: DEFAULT_THEME_ID });
		useOnboardingSeriesStore.getState().advance();
		useOnboardingSeriesStore.getState().stop();

		expect(current()).toBeNull();
		expect(useOnboardingSeriesStore.getState().forced).toBe(false);
		expect(useOnboardingSeriesStore.getState().history).toEqual([]);
	});

	describe('replay', () => {
		it('runs every step regardless of seen flags or theme', () => {
			replayOnboardingSeries('returning');

			expect(useOnboardingSeriesStore.getState().queue).toEqual([...ONBOARDING_STEPS]);
		});

		it('marks the run forced, so the steps skip persisting "seen"', () => {
			// Otherwise looking at the series would consume a real first run.
			replayOnboardingSeries('new');

			expect(useOnboardingSeriesStore.getState().forced).toBe(true);
		});

		it('addresses the audience it was asked for', () => {
			replayOnboardingSeries('returning');
			expect(useOnboardingSeriesStore.getState().audience).toBe('returning');
		});

		it('clears forced when the series ends', () => {
			replayOnboardingSeries('new');
			for (let i = 0; i < ONBOARDING_STEPS.length; i++) {
				useOnboardingSeriesStore.getState().advance();
			}

			expect(useOnboardingSeriesStore.getState().forced).toBe(false);
		});
	});
});
