import { describe, it, expect } from 'vitest';
import {
	DEFAULT_THEME_ID,
	ONBOARDING_STEPS,
	ONBOARDING_STEP_FLAGS,
	isThemeStepEligible,
	planOnboardingSeries,
} from '../../shared/onboardingSeries';

describe('onboarding step registry', () => {
	it('gives every step its own seen flag', () => {
		// One flag per step is what lets a later release add a fourth step
		// without re-showing the three a user already answered.
		const flags = ONBOARDING_STEPS.map((step) => ONBOARDING_STEP_FLAGS[step]);
		expect(flags.every(Boolean)).toBe(true);
		expect(new Set(flags).size).toBe(flags.length);
	});

	it('keeps typography first', () => {
		// It decides what every later surface is DRAWN in, so asking about
		// themes first would preview the wrong app.
		expect(ONBOARDING_STEPS[0]).toBe('typography');
	});
});

describe('isThemeStepEligible', () => {
	it('always offers a theme to a new user', () => {
		expect(isThemeStepEligible('new', DEFAULT_THEME_ID)).toBe(true);
		expect(isThemeStepEligible('new', 'nord')).toBe(true);
	});

	it('offers it to a returning user only while still on the default', () => {
		expect(isThemeStepEligible('returning', DEFAULT_THEME_ID)).toBe(true);
	});

	it('leaves a returning user who already picked a theme alone', () => {
		// They found the picker on their own. Reopening that decision uninvited
		// would be presumptuous.
		expect(isThemeStepEligible('returning', 'nord')).toBe(false);
		expect(isThemeStepEligible('returning', 'github-light')).toBe(false);
	});
});

describe('planOnboardingSeries', () => {
	const base = { seen: {}, activeThemeId: DEFAULT_THEME_ID };

	it('runs every step for a fresh install', () => {
		expect(planOnboardingSeries({ ...base, audience: 'new' })).toEqual([
			'typography',
			'theme',
			'agentPowers',
		]);
	});

	it('skips a step the user has already been shown', () => {
		expect(planOnboardingSeries({ ...base, audience: 'new', seen: { typography: true } })).toEqual([
			'theme',
			'agentPowers',
		]);
	});

	it('drops the theme step for a returning user who has chosen one', () => {
		expect(
			planOnboardingSeries({ audience: 'returning', seen: {}, activeThemeId: 'nord' })
		).toEqual(['typography', 'agentPowers']);
	});

	it('returns nothing once every step has been seen', () => {
		expect(
			planOnboardingSeries({
				...base,
				audience: 'new',
				seen: { typography: true, theme: true, agentPowers: true },
			})
		).toEqual([]);
	});

	it('keeps the declared order regardless of which steps survive', () => {
		const plan = planOnboardingSeries({ ...base, audience: 'new', seen: { theme: true } });
		expect(plan).toEqual(['typography', 'agentPowers']);
	});

	it('force ignores both the seen flags and the theme gate', () => {
		// The debug entries exist to replay a series that has, by definition,
		// already been seen.
		expect(
			planOnboardingSeries({
				audience: 'returning',
				seen: { typography: true, theme: true, agentPowers: true },
				activeThemeId: 'nord',
				force: true,
			})
		).toEqual([...ONBOARDING_STEPS]);
	});
});
