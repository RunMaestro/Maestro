/**
 * The first-run modal series - what Maestro shows a user once, and to whom.
 *
 * Three steps run back to back: pick your typography, pick your theme, then
 * learn that your agents can drive all of it themselves. Each is a decision or
 * a disclosure that only makes sense before the user has settled in, so each is
 * shown at most once.
 *
 * Every step carries its OWN seen flag rather than one flag for the series.
 * That is what lets a later release add a fourth step without re-showing the
 * three a user already answered - and it is why the typography step keeps
 * working for anyone who dismissed it before the other two existed.
 *
 * Shared rather than renderer-local so the planner is testable without React
 * and cannot drift from the flags the settings store persists.
 */

export const ONBOARDING_STEPS = ['typography', 'theme', 'agentPowers'] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/**
 * Who we are talking to. A returning user was already using Maestro before
 * these steps existed, so their copy names the look they ALREADY have rather
 * than reading as if their preference were being ignored.
 */
export type OnboardingAudience = 'new' | 'returning';

/** Settings key holding each step's "already shown" flag. */
export const ONBOARDING_STEP_FLAGS: Record<OnboardingStep, string> = {
	typography: 'typographyPromptSeen',
	theme: 'themePromptSeen',
	agentPowers: 'agentPowersPromptSeen',
};

/** The theme id every install starts on, and the one the theme step gates on. */
export const DEFAULT_THEME_ID = 'dracula';

export interface OnboardingPlanInput {
	audience: OnboardingAudience;
	/** Which steps this user has already been shown. */
	seen: Partial<Record<OnboardingStep, boolean>>;
	/** The theme currently applied, used to gate the theme step. */
	activeThemeId: string;
	/**
	 * Ignore the seen flags and the theme gate, and plan every step for the
	 * audience. For the debug palette entries, which exist to replay a series
	 * that by definition has already been seen.
	 */
	force?: boolean;
}

/**
 * Whether the theme step is worth showing.
 *
 * A new user always gets it - they have expressed no preference yet.
 *
 * A returning user gets it only while still on the default theme. Anyone who
 * has moved off Dracula has already found the theme picker and made a choice,
 * and re-opening that decision uninvited would be presumptuous. Note this reads
 * the CURRENT theme rather than a "has ever changed it" flag: a user who
 * switched away and deliberately came back to Dracula looks identical to one
 * who never touched it, and showing them a theme picker is harmless either way.
 */
export function isThemeStepEligible(audience: OnboardingAudience, activeThemeId: string): boolean {
	if (audience === 'new') return true;
	return activeThemeId === DEFAULT_THEME_ID;
}

/**
 * The steps to run, in order. Empty when there is nothing left to show, which
 * is the steady state for everyone who has already been through it.
 */
export function planOnboardingSeries(input: OnboardingPlanInput): OnboardingStep[] {
	return ONBOARDING_STEPS.filter((step) => {
		if (input.force) return true;
		if (input.seen[step]) return false;
		if (step === 'theme') return isThemeStepEligible(input.audience, input.activeThemeId);
		return true;
	});
}
