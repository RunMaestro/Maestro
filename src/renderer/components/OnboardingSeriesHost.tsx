/**
 * Runs the first-run modal series: typography, then theme, then agent powers.
 *
 * Mounts exactly ONE step at a time, driven by `onboardingSeriesStore`. The
 * three modals are deliberately not self-gating - if each opened itself off its
 * own settings flag, a fresh install would open all three at once and stack
 * them by z-index, and the user would answer the last question first.
 *
 * Each step marks its own flag as seen on dismiss, then advances the queue.
 * A forced run (the debug palette entries) skips the flag writes, so replaying
 * the series to look at it does not consume a real user's first run.
 */

import { useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { TypographyChoiceModal } from './TypographyChoiceModal';
import { ThemeChoiceModal } from './ThemeChoiceModal';
import { AgentPowersModal } from './AgentPowersModal';
import { useSettingsStore } from '../stores/settingsStore';
import { useComposerInputStore } from '../stores/composerInputStore';
import {
	selectCanGoBackInOnboarding,
	selectCurrentOnboardingStep,
	useOnboardingSeriesStore,
} from '../stores/onboardingSeriesStore';
import type { Theme, ThemeId } from '../types';

export interface OnboardingSeriesHostProps {
	theme: Theme;
	/** Every selectable theme, plugin contributions already merged in. */
	themes: Record<string, Theme>;
	/** Whether this user already had agents when the series started. */
	isReturningUser: boolean;
	/** Open Settings on a given tab, for the "customize" links. */
	onOpenSettings: (tab: 'display' | 'theme') => void;
	/** Whether there is an agent to drop an example prompt into. */
	hasActiveAgent: boolean;
}

export function OnboardingSeriesHost({
	theme,
	themes,
	isReturningUser,
	onOpenSettings,
	hasActiveAgent,
}: OnboardingSeriesHostProps) {
	const step = useOnboardingSeriesStore(selectCurrentOnboardingStep);
	const forced = useOnboardingSeriesStore((s) => s.forced);
	const advance = useOnboardingSeriesStore((s) => s.advance);
	const back = useOnboardingSeriesStore((s) => s.back);
	const canGoBack = useOnboardingSeriesStore(selectCanGoBackInOnboarding);
	// The store's audience wins when a series is running, so a forced replay can
	// show returning-user copy on an install with no agents. Falls back to the
	// prop once the series ends and the audience clears.
	const audience = useOnboardingSeriesStore((s) => s.audience);
	const showReturningCopy = audience ? audience === 'returning' : isReturningUser;

	const {
		applyTypographyPreset,
		setTypographyPromptSeen,
		setThemePromptSeen,
		setAgentPowersPromptSeen,
		setActiveThemeId,
		activeThemeId,
	} = useSettingsStore(
		useShallow((s) => ({
			applyTypographyPreset: s.applyTypographyPreset,
			setTypographyPromptSeen: s.setTypographyPromptSeen,
			setThemePromptSeen: s.setThemePromptSeen,
			setAgentPowersPromptSeen: s.setAgentPowersPromptSeen,
			setActiveThemeId: s.setActiveThemeId,
			activeThemeId: s.activeThemeId,
		}))
	);

	const setAiValue = useComposerInputStore((s) => s.setAiValue);

	/**
	 * Mark a step seen and move on. The flag is written on ANY exit, including
	 * Escape: declining is a valid answer, and a prompt that reappeared every
	 * launch until it got the answer it wanted would be a nag.
	 */
	const finishStep = useCallback(
		(markSeen: (value: boolean) => void) => {
			if (!forced) markSeen(true);
			advance();
		},
		[forced, advance]
	);

	/**
	 * Step back WITHOUT marking anything seen. Going back is the user saying
	 * they have not settled the question yet, so recording an answer on the way
	 * out would be recording one they are still in the middle of changing.
	 * Undefined on the first step, which is what hides the control there.
	 */
	const onBack = useMemo(() => (canGoBack ? () => back() : undefined), [canGoBack, back]);

	const onTryExample = useMemo(
		() =>
			hasActiveAgent
				? (prompt: string) => {
						// Dropped into the composer rather than sent: the user should see
						// what is being asked, and get to edit it, before an agent acts.
						setAiValue(prompt);
					}
				: undefined,
		[hasActiveAgent, setAiValue]
	);

	if (!step) return null;

	if (step === 'typography') {
		return (
			<TypographyChoiceModal
				theme={theme}
				isOpen
				isReturningUser={showReturningCopy}
				onChoose={applyTypographyPreset}
				onDismiss={() => finishStep(setTypographyPromptSeen)}
				onBack={onBack}
				onOpenDisplaySettings={() => onOpenSettings('display')}
			/>
		);
	}

	if (step === 'theme') {
		return (
			<ThemeChoiceModal
				theme={theme}
				isOpen
				isReturningUser={showReturningCopy}
				themes={themes}
				activeThemeId={activeThemeId}
				onSelectTheme={(id: ThemeId) => setActiveThemeId(id)}
				onDismiss={() => finishStep(setThemePromptSeen)}
				onBack={onBack}
				onOpenThemeSettings={() => onOpenSettings('theme')}
			/>
		);
	}

	return (
		<AgentPowersModal
			theme={theme}
			isOpen
			onDismiss={() => finishStep(setAgentPowersPromptSeen)}
			onBack={onBack}
			onTryExample={onTryExample}
		/>
	);
}

export default OnboardingSeriesHost;
