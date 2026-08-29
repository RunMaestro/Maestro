import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: vi.fn(() => 'layer-test'),
		unregisterLayer: vi.fn(),
		updateLayerHandler: vi.fn(),
	}),
}));

import { ThemeChoiceModal } from '../../../renderer/components/ThemeChoiceModal';
import { THEMES } from '../../../renderer/constants/themes';
import { mockTheme } from '../../helpers/mockTheme';

function renderModal(overrides: Partial<React.ComponentProps<typeof ThemeChoiceModal>> = {}) {
	const props = {
		theme: mockTheme,
		isOpen: true,
		isReturningUser: false,
		themes: THEMES as unknown as Record<string, typeof mockTheme>,
		activeThemeId: 'dracula',
		onSelectTheme: vi.fn(),
		onDismiss: vi.fn(),
		onOpenThemeSettings: vi.fn(),
		...overrides,
	};
	const view = render(<ThemeChoiceModal {...props} />);
	return { ...props, view };
}

afterEach(() => {
	cleanup();
});

describe('ThemeChoiceModal', () => {
	it('renders nothing when closed', () => {
		renderModal({ isOpen: false });
		expect(screen.queryByTestId('theme-choice-modal')).not.toBeInTheDocument();
	});

	it('offers dark, light, and vibe themes', () => {
		renderModal();

		expect(screen.getByTestId('theme-choice-dracula')).toBeInTheDocument();
		expect(screen.getByTestId('theme-choice-github-light')).toBeInTheDocument();
		expect(screen.getByTestId('theme-choice-pedurple')).toBeInTheDocument();
	});

	it('omits the Custom theme, which has nothing to preview', () => {
		// On a fresh install it is a copy of the default, so it would render as a
		// duplicate swatch that appears to do nothing.
		renderModal();
		expect(screen.queryByTestId('theme-choice-custom')).not.toBeInTheDocument();
	});

	it('marks the active theme as selected', () => {
		renderModal({ activeThemeId: 'nord' });

		expect(screen.getByTestId('theme-choice-nord')).toHaveAttribute('aria-pressed', 'true');
		expect(screen.getByTestId('theme-choice-dracula')).toHaveAttribute('aria-pressed', 'false');
	});

	describe('live preview', () => {
		it('applies a theme on click, without waiting for confirm', () => {
			// No swatch can honestly preview a whole-app repaint at swatch size,
			// so the preview is the app itself.
			const { onSelectTheme } = renderModal();

			fireEvent.click(screen.getByTestId('theme-choice-nord'));
			expect(onSelectTheme).toHaveBeenCalledWith('nord');
		});

		it('does not dismiss on a preview click', () => {
			const { onDismiss } = renderModal();

			fireEvent.click(screen.getByTestId('theme-choice-nord'));
			expect(onDismiss).not.toHaveBeenCalled();
		});
	});

	describe('exits', () => {
		it('offers no way to decline, because a theme is always applied', () => {
			// "Not now" would imply an outcome where no theme is chosen. Whatever
			// is on screen when this closes IS the answer.
			renderModal();

			expect(screen.queryByText('Not now')).not.toBeInTheDocument();
		});

		it('keeps the previewed theme on confirm', () => {
			// The theme is already live, so confirming is the ABSENCE of a revert.
			const { onSelectTheme, onDismiss } = renderModal({ activeThemeId: 'nord' });

			fireEvent.click(screen.getByTestId('theme-choice-confirm'));
			expect(onDismiss).toHaveBeenCalled();
			expect(onSelectTheme).not.toHaveBeenCalled();
		});

		it('reverts to the theme that was live when it opened', () => {
			// Browsing has to cost nothing, or the user cannot explore freely.
			const onSelectTheme = vi.fn();
			const { view } = renderModal({ activeThemeId: 'dracula', onSelectTheme });

			view.rerender(
				<ThemeChoiceModal
					theme={mockTheme}
					isOpen
					isReturningUser={false}
					themes={THEMES as unknown as Record<string, typeof mockTheme>}
					activeThemeId="nord"
					onSelectTheme={onSelectTheme}
					onDismiss={vi.fn()}
					onOpenThemeSettings={vi.fn()}
				/>
			);
			fireEvent.click(screen.getByLabelText('Close modal'));

			expect(onSelectTheme).toHaveBeenCalledWith('dracula');
		});

		it('does not revert when nothing was previewed', () => {
			const { onSelectTheme } = renderModal({ activeThemeId: 'dracula' });

			fireEvent.click(screen.getByLabelText('Close modal'));
			expect(onSelectTheme).not.toHaveBeenCalled();
		});

		it('keeps the previewed theme when opening Settings', () => {
			// The user is going there to refine it; throwing it away first would
			// be perverse.
			const onSelectTheme = vi.fn();
			const { view, onOpenThemeSettings } = renderModal({
				activeThemeId: 'dracula',
				onSelectTheme,
			});

			view.rerender(
				<ThemeChoiceModal
					theme={mockTheme}
					isOpen
					isReturningUser={false}
					themes={THEMES as unknown as Record<string, typeof mockTheme>}
					activeThemeId="nord"
					onSelectTheme={onSelectTheme}
					onDismiss={vi.fn()}
					onOpenThemeSettings={onOpenThemeSettings}
				/>
			);
			fireEvent.click(screen.getByText('Customize in Settings'));

			expect(onOpenThemeSettings).toHaveBeenCalled();
			expect(onSelectTheme).not.toHaveBeenCalled();
		});
	});

	describe('confirm label', () => {
		it('asks a new user to CHOOSE, having no prior theme to keep or leave', () => {
			renderModal({ isReturningUser: false, activeThemeId: 'dracula' });

			expect(screen.getByTestId('theme-choice-confirm')).toHaveTextContent('Choose Dracula');
		});

		it('still says CHOOSE after a new user browses to another theme', () => {
			// There is nothing to switch FROM on a fresh install.
			renderModal({ isReturningUser: false, activeThemeId: 'monokai' });

			expect(screen.getByTestId('theme-choice-confirm')).toHaveTextContent('Choose Monokai');
		});

		it('offers to KEEP the theme a returning user arrived with', () => {
			renderModal({ isReturningUser: true, activeThemeId: 'dracula' });

			expect(screen.getByTestId('theme-choice-confirm')).toHaveTextContent('Keep Dracula');
		});

		it('offers to SWITCH TO a theme a returning user previews', () => {
			// Adopting Monokai is not keeping it, and the button naming the wrong
			// verb is the user's only readout of what the click will do.
			const onSelectTheme = vi.fn();
			const { view } = renderModal({
				isReturningUser: true,
				activeThemeId: 'dracula',
				onSelectTheme,
			});
			expect(screen.getByTestId('theme-choice-confirm')).toHaveTextContent('Keep Dracula');

			view.rerender(
				<ThemeChoiceModal
					theme={mockTheme}
					isOpen
					isReturningUser
					themes={THEMES as unknown as Record<string, typeof mockTheme>}
					activeThemeId="monokai"
					onSelectTheme={onSelectTheme}
					onDismiss={vi.fn()}
					onOpenThemeSettings={vi.fn()}
				/>
			);

			expect(screen.getByTestId('theme-choice-confirm')).toHaveTextContent('Switch to Monokai');
		});

		it('says KEEP again when a returning user browses back to where they started', () => {
			const onSelectTheme = vi.fn();
			const { view } = renderModal({
				isReturningUser: true,
				activeThemeId: 'dracula',
				onSelectTheme,
			});

			const rerenderWith = (activeThemeId: string) =>
				view.rerender(
					<ThemeChoiceModal
						theme={mockTheme}
						isOpen
						isReturningUser
						themes={THEMES as unknown as Record<string, typeof mockTheme>}
						activeThemeId={activeThemeId}
						onSelectTheme={onSelectTheme}
						onDismiss={vi.fn()}
						onOpenThemeSettings={vi.fn()}
					/>
				);

			rerenderWith('monokai');
			rerenderWith('dracula');

			expect(screen.getByTestId('theme-choice-confirm')).toHaveTextContent('Keep Dracula');
		});

		it('measures KEEP against the theme it opened on, not the shipped default', () => {
			// A returning user who already moved to Nord is keeping Nord.
			renderModal({ isReturningUser: true, activeThemeId: 'nord' });

			expect(screen.getByTestId('theme-choice-confirm')).toHaveTextContent('Keep Nord');
		});
	});

	describe('copy', () => {
		it('tells a returning user they have been on the default', () => {
			renderModal({ isReturningUser: true });
			expect(screen.getByText(/you've been on the default theme/i)).toBeInTheDocument();
		});

		it('simply asks a new user to pick', () => {
			renderModal({ isReturningUser: false });
			expect(screen.getByText('Pick a theme')).toBeInTheDocument();
		});

		it('points both audiences at Settings for customization', () => {
			renderModal();
			expect(screen.getByText(/Settings . Themes/)).toBeInTheDocument();
		});
	});
});
