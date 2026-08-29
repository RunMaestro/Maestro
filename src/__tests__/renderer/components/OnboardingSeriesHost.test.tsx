import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: vi.fn(() => 'layer-test'),
		unregisterLayer: vi.fn(),
		updateLayerHandler: vi.fn(),
	}),
}));

import { OnboardingSeriesHost } from '../../../renderer/components/OnboardingSeriesHost';
import {
	replayOnboardingSeries,
	startOnboardingSeries,
	useOnboardingSeriesStore,
} from '../../../renderer/stores/onboardingSeriesStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { THEMES } from '../../../renderer/constants/themes';
import { DEFAULT_THEME_ID } from '../../../shared/onboardingSeries';
import { mockTheme } from '../../helpers/mockTheme';

function renderHost(overrides: Partial<React.ComponentProps<typeof OnboardingSeriesHost>> = {}) {
	const props = {
		theme: mockTheme,
		themes: THEMES as unknown as Record<string, typeof mockTheme>,
		isReturningUser: false,
		onOpenSettings: vi.fn(),
		hasActiveAgent: true,
		...overrides,
	};
	render(<OnboardingSeriesHost {...props} />);
	return props;
}

beforeEach(() => {
	useOnboardingSeriesStore.setState({ queue: [], history: [], audience: null, forced: false });
	useSettingsStore.setState({
		typographyPromptSeen: false,
		themePromptSeen: false,
		agentPowersPromptSeen: false,
		activeThemeId: DEFAULT_THEME_ID,
	});
	vi.spyOn(window.maestro.settings, 'set').mockResolvedValue(undefined as never);
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe('OnboardingSeriesHost', () => {
	it('renders nothing when no series is running', () => {
		renderHost();
		expect(screen.queryByTestId('typography-choice-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('theme-choice-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('agent-powers-modal')).not.toBeInTheDocument();
	});

	it('mounts exactly one step at a time', () => {
		// Three self-gating modals would open at once and stack by z-index.
		startOnboardingSeries({ audience: 'new', seen: {}, activeThemeId: DEFAULT_THEME_ID });
		renderHost();

		expect(screen.getByTestId('typography-choice-modal')).toBeInTheDocument();
		expect(screen.queryByTestId('theme-choice-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('agent-powers-modal')).not.toBeInTheDocument();
	});

	it('walks the whole series as each step is dismissed', () => {
		startOnboardingSeries({ audience: 'new', seen: {}, activeThemeId: DEFAULT_THEME_ID });
		renderHost();

		fireEvent.click(screen.getByTestId('typography-choice-confirm'));
		expect(screen.getByTestId('theme-choice-modal')).toBeInTheDocument();

		fireEvent.click(screen.getByTestId('theme-choice-confirm'));
		expect(screen.getByTestId('agent-powers-modal')).toBeInTheDocument();

		fireEvent.click(screen.getByTestId('agent-powers-confirm'));
		expect(screen.queryByTestId('agent-powers-modal')).not.toBeInTheDocument();
	});

	describe('back', () => {
		it('offers no way back on the first step', () => {
			// A disabled Back would claim a history the series does not have.
			startOnboardingSeries({ audience: 'new', seen: {}, activeThemeId: DEFAULT_THEME_ID });
			renderHost();

			expect(screen.queryByTestId('typography-choice-back')).not.toBeInTheDocument();
		});

		it('reopens the previous step from every later step', () => {
			startOnboardingSeries({ audience: 'new', seen: {}, activeThemeId: DEFAULT_THEME_ID });
			renderHost();

			fireEvent.click(screen.getByTestId('typography-choice-confirm'));
			fireEvent.click(screen.getByTestId('theme-choice-back'));
			expect(screen.getByTestId('typography-choice-modal')).toBeInTheDocument();

			fireEvent.click(screen.getByTestId('typography-choice-confirm'));
			fireEvent.click(screen.getByTestId('theme-choice-confirm'));
			fireEvent.click(screen.getByTestId('agent-powers-back'));
			expect(screen.getByTestId('theme-choice-modal')).toBeInTheDocument();
		});

		it('does not mark the step it leaves as seen', () => {
			// Going back says the question is not settled yet, so recording an
			// answer on the way out would record one still being changed.
			startOnboardingSeries({ audience: 'new', seen: {}, activeThemeId: DEFAULT_THEME_ID });
			renderHost();

			fireEvent.click(screen.getByTestId('typography-choice-confirm'));
			fireEvent.click(screen.getByTestId('theme-choice-back'));

			expect(useSettingsStore.getState().themePromptSeen).toBe(false);
		});

		it('reverts a previewed theme on the way back', () => {
			// Browsing has to cost nothing. Back is not an answer, so the theme
			// the pointer last passed over must not stick.
			startOnboardingSeries({ audience: 'new', seen: {}, activeThemeId: DEFAULT_THEME_ID });
			renderHost();

			fireEvent.click(screen.getByTestId('typography-choice-confirm'));
			fireEvent.click(screen.getByTestId('theme-choice-nord'));
			expect(useSettingsStore.getState().activeThemeId).toBe('nord');

			fireEvent.click(screen.getByTestId('theme-choice-back'));
			expect(useSettingsStore.getState().activeThemeId).toBe(DEFAULT_THEME_ID);
		});
	});

	describe('seen flags', () => {
		it('marks each step seen as it is dismissed', () => {
			startOnboardingSeries({ audience: 'new', seen: {}, activeThemeId: DEFAULT_THEME_ID });
			renderHost();

			fireEvent.click(screen.getByTestId('typography-choice-confirm'));
			expect(useSettingsStore.getState().typographyPromptSeen).toBe(true);

			fireEvent.click(screen.getByTestId('theme-choice-confirm'));
			expect(useSettingsStore.getState().themePromptSeen).toBe(true);

			fireEvent.click(screen.getByTestId('agent-powers-confirm'));
			expect(useSettingsStore.getState().agentPowersPromptSeen).toBe(true);
		});

		it('marks a step seen even when the user declines it', () => {
			// Declining is a valid answer. A prompt that reappeared every launch
			// until it got the answer it wanted would be a nag.
			startOnboardingSeries({
				audience: 'new',
				seen: { typography: true },
				activeThemeId: DEFAULT_THEME_ID,
			});
			renderHost();

			fireEvent.click(screen.getByLabelText('Close modal'));
			expect(useSettingsStore.getState().themePromptSeen).toBe(true);
		});

		it('does NOT persist anything during a forced replay', () => {
			// Otherwise looking at the series would consume a real first run.
			replayOnboardingSeries('new');
			renderHost();

			fireEvent.click(screen.getByTestId('typography-choice-confirm'));
			fireEvent.click(screen.getByTestId('theme-choice-confirm'));
			fireEvent.click(screen.getByTestId('agent-powers-confirm'));

			const state = useSettingsStore.getState();
			expect(state.typographyPromptSeen).toBe(false);
			expect(state.themePromptSeen).toBe(false);
			expect(state.agentPowersPromptSeen).toBe(false);
		});
	});

	describe('audience', () => {
		it('uses the running series audience over the prop', () => {
			// A forced replay must be able to show returning-user copy on an
			// install that has no agents.
			replayOnboardingSeries('returning');
			renderHost({ isReturningUser: false });

			expect(screen.getByText('Maestro has new typography')).toBeInTheDocument();
		});

		it('falls back to the prop when no series is running', () => {
			startOnboardingSeries({ audience: 'new', seen: {}, activeThemeId: DEFAULT_THEME_ID });
			renderHost({ isReturningUser: true });

			expect(screen.getByText('Choose your typography')).toBeInTheDocument();
		});
	});

	it('applies a theme immediately when previewed', () => {
		startOnboardingSeries({
			audience: 'new',
			seen: { typography: true },
			activeThemeId: DEFAULT_THEME_ID,
		});
		renderHost();

		fireEvent.click(screen.getByTestId('theme-choice-nord'));
		expect(useSettingsStore.getState().activeThemeId).toBe('nord');
	});

	it('routes each customize link to its own Settings tab', () => {
		startOnboardingSeries({ audience: 'new', seen: {}, activeThemeId: DEFAULT_THEME_ID });
		const { onOpenSettings } = renderHost();

		fireEvent.click(screen.getByText('Fine-tune in Settings'));
		expect(onOpenSettings).toHaveBeenCalledWith('display');

		fireEvent.click(screen.getByText('Customize in Settings'));
		expect(onOpenSettings).toHaveBeenCalledWith('theme');
	});

	it('offers no example prompts when there is no agent to receive them', () => {
		startOnboardingSeries({
			audience: 'new',
			seen: { typography: true, theme: true },
			activeThemeId: DEFAULT_THEME_ID,
		});
		renderHost({ hasActiveAgent: false });

		expect(screen.getByTestId('agent-powers-example-change-the-theme')).toBeDisabled();
	});
});
