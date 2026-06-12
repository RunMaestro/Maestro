import type {
	AchievementPlaygroundState,
	BatonPlaygroundState,
	ConfettiPlaygroundState,
} from '../../../../renderer/components/PlaygroundPanel/types';
import { expect, vi } from 'vitest';
import {
	DEFAULT_CONFETTI_COLORS,
	type ConfettiShape,
} from '../../../../renderer/components/PlaygroundPanel/utils/confettiSettings';
import { BATON_DEFAULTS } from '../../../../renderer/components/PlaygroundPanel/utils/batonCss';
import type { AutoRunStats, Theme } from '../../../../renderer/types';
import { mockTheme } from '../../../helpers/mockTheme';

export { mockTheme };

export function makeAutoRunStats(overrides: Partial<AutoRunStats> = {}): AutoRunStats {
	return {
		cumulativeTimeMs: 0,
		longestRunMs: 0,
		longestRunTimestamp: 123,
		totalRuns: 0,
		currentBadgeLevel: 0,
		lastBadgeUnlockLevel: 0,
		lastAcknowledgedBadgeLevel: 0,
		badgeHistory: [],
		...overrides,
	};
}

export function makeAchievementState(
	overrides: Partial<AchievementPlaygroundState> = {}
): AchievementPlaygroundState {
	return {
		mockCumulativeTime: 0,
		setMockCumulativeTime: vi.fn(),
		mockLongestRun: 0,
		setMockLongestRun: vi.fn(),
		mockTotalRuns: 0,
		setMockTotalRuns: vi.fn(),
		mockAutoRunStats: makeAutoRunStats(),
		showStandingOvation: false,
		ovationBadgeLevel: 1,
		setOvationBadgeLevel: vi.fn(),
		ovationIsNewRecord: false,
		setOvationIsNewRecord: vi.fn(),
		showKeyboardMasteryCelebration: false,
		keyboardMasteryLevel: 1,
		setKeyboardMasteryLevel: vi.fn(),
		setToBadgeLevel: vi.fn(),
		triggerOvation: vi.fn(),
		closeStandingOvation: vi.fn(),
		triggerKeyboardMastery: vi.fn(),
		closeKeyboardMastery: vi.fn(),
		resetMockData: vi.fn(),
		...overrides,
	};
}

export function makeConfettiState(
	overrides: Partial<ConfettiPlaygroundState> = {}
): ConfettiPlaygroundState {
	return {
		particleCount: 100,
		angle: 90,
		spread: 45,
		startVelocity: 45,
		gravity: 1,
		decay: 0.9,
		drift: 0,
		scalar: 1,
		ticks: 200,
		flat: false,
		shapes: ['square', 'circle'] as ConfettiShape[],
		colors: DEFAULT_CONFETTI_COLORS,
		setParticleCount: vi.fn(),
		setAngle: vi.fn(),
		setSpread: vi.fn(),
		setStartVelocity: vi.fn(),
		setGravity: vi.fn(),
		setDecay: vi.fn(),
		setDrift: vi.fn(),
		setScalar: vi.fn(),
		setTicks: vi.fn(),
		setFlat: vi.fn(),
		selectedOrigins: new Set(['2-1']),
		copySuccess: false,
		toggleOrigin: vi.fn(),
		toggleShape: vi.fn(),
		setColorAt: vi.fn(),
		addColor: vi.fn(),
		removeColor: vi.fn(),
		firePlaygroundConfetti: vi.fn(),
		resetConfettiSettings: vi.fn(),
		copyConfettiSettings: vi.fn(),
		...overrides,
	};
}

export function makeBatonState(
	overrides: Partial<BatonPlaygroundState> = {}
): BatonPlaygroundState {
	return {
		duration: BATON_DEFAULTS.duration,
		fadeOutStart: BATON_DEFAULTS.fadeOutStart,
		fadeInStart: BATON_DEFAULTS.fadeInStart,
		translateAmount: BATON_DEFAULTS.translateAmount,
		staggerOffset: BATON_DEFAULTS.staggerOffset,
		easing: BATON_DEFAULTS.easing,
		batonActive: true,
		batonCopySuccess: false,
		setDuration: vi.fn(),
		setFadeOutStart: vi.fn(),
		setFadeInStart: vi.fn(),
		setTranslateAmount: vi.fn(),
		setStaggerOffset: vi.fn(),
		setEasing: vi.fn(),
		toggleBatonActive: vi.fn(),
		resetBatonDefaults: vi.fn(),
		copyBatonSettings: vi.fn(),
		...overrides,
	};
}

export function expectThemeCardStyles(element: HTMLElement, theme: Theme = mockTheme): void {
	expect(element).toHaveStyle({
		borderColor: theme.colors.border,
		backgroundColor: theme.colors.bgActivity,
	});
}
