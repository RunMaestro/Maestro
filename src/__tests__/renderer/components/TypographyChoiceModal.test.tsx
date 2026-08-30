import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// useModalLayer needs a LayerStackProvider in a real render. The stack behavior
// is irrelevant here, so stub the context hook.
vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: vi.fn(() => 'layer-test'),
		unregisterLayer: vi.fn(),
		updateLayerHandler: vi.fn(),
	}),
}));

import { TypographyChoiceModal } from '../../../renderer/components/TypographyChoiceModal';
import { TYPOGRAPHY_PRESETS } from '../../../shared/typographyPresets';
import { mockTheme } from '../../helpers/mockTheme';

function renderModal(overrides: Partial<React.ComponentProps<typeof TypographyChoiceModal>> = {}) {
	const props = {
		theme: mockTheme,
		isOpen: true,
		isReturningUser: false,
		onChoose: vi.fn(),
		onDismiss: vi.fn(),
		onOpenDisplaySettings: vi.fn(),
		...overrides,
	};
	render(<TypographyChoiceModal {...props} />);
	return props;
}

afterEach(() => {
	cleanup();
});

describe('TypographyChoiceModal', () => {
	it('renders nothing when closed', () => {
		renderModal({ isOpen: false });
		expect(screen.queryByTestId('typography-choice-modal')).not.toBeInTheDocument();
	});

	it('offers both presets as cards', () => {
		renderModal();
		expect(screen.getByTestId('typography-preset-default')).toBeInTheDocument();
		expect(screen.getByTestId('typography-preset-hacker')).toBeInTheDocument();
	});

	it('points the user at the per-surface pickers', () => {
		renderModal();
		expect(screen.getByText(/Settings . Display/)).toBeInTheDocument();
	});

	describe('copy', () => {
		it('asks a fresh install to pick', () => {
			renderModal({ isReturningUser: false });
			expect(screen.getByText('Choose your typography')).toBeInTheDocument();
			expect(screen.queryByText(/You've been using Hacker/)).not.toBeInTheDocument();
		});

		it('tells a returning user what is changing and what they already have', () => {
			// New-user copy would read to an existing user as if their preference
			// were being ignored, so the same modal changes what it says.
			renderModal({ isReturningUser: true });
			expect(screen.getByText('Maestro has new typography')).toBeInTheDocument();
			expect(screen.getByText(/You've been using Hacker/)).toBeInTheDocument();
		});
	});

	describe('selection', () => {
		it('preselects Default for a fresh install', () => {
			renderModal();
			expect(screen.getByTestId('typography-preset-default')).toHaveAttribute(
				'aria-pressed',
				'true'
			);
			expect(screen.getByTestId('typography-choice-confirm')).toHaveTextContent('Use Default');
		});

		it('preselects the look a returning user already has', () => {
			renderModal({ isReturningUser: true });
			expect(screen.getByTestId('typography-preset-hacker')).toHaveAttribute(
				'aria-pressed',
				'true'
			);
			expect(screen.getByTestId('typography-choice-confirm')).toHaveTextContent('Use Hacker');
		});

		it('moves the selection when the other card is clicked', () => {
			renderModal();
			fireEvent.click(screen.getByTestId('typography-preset-hacker'));
			expect(screen.getByTestId('typography-preset-hacker')).toHaveAttribute(
				'aria-pressed',
				'true'
			);
			expect(screen.getByTestId('typography-preset-default')).toHaveAttribute(
				'aria-pressed',
				'false'
			);
		});

		it('does not apply anything until the choice is confirmed', () => {
			// Clicking a card is picking, not committing - the app must not
			// repaint underneath a user who is still comparing the two.
			const { onChoose } = renderModal();
			fireEvent.click(screen.getByTestId('typography-preset-hacker'));
			expect(onChoose).not.toHaveBeenCalled();
		});
	});

	describe('exits', () => {
		it('applies the selected preset and closes on confirm', () => {
			const { onChoose, onDismiss } = renderModal();
			fireEvent.click(screen.getByTestId('typography-preset-hacker'));
			fireEvent.click(screen.getByTestId('typography-choice-confirm'));
			expect(onChoose).toHaveBeenCalledWith('hacker');
			expect(onDismiss).toHaveBeenCalled();
		});

		it('offers no way to decline, because a preset is always in effect', () => {
			// "Not now" would imply an outcome where no typography is chosen.
			renderModal();

			expect(screen.queryByText('Not now')).not.toBeInTheDocument();
		});

		it('closes without applying anything when dismissed', () => {
			// The shipped defaults still produce the Hacker look, so leaving has
			// to leave the fonts exactly as they were.
			const { onChoose, onDismiss } = renderModal();
			fireEvent.click(screen.getByLabelText('Close modal'));
			expect(onChoose).not.toHaveBeenCalled();
			expect(onDismiss).toHaveBeenCalled();
		});

		it('applies before opening Settings so the pickers show the new choice', () => {
			const { onChoose, onDismiss, onOpenDisplaySettings } = renderModal();
			fireEvent.click(screen.getByText('Fine-tune in Settings'));
			expect(onChoose).toHaveBeenCalledWith('default');
			expect(onDismiss).toHaveBeenCalled();
			expect(onOpenDisplaySettings).toHaveBeenCalled();
		});
	});

	it('labels each surface with the face that preset gives it', () => {
		renderModal();
		const card = screen.getByTestId('typography-preset-default');
		for (const surface of TYPOGRAPHY_PRESETS.default.surfaces) {
			expect(card).toHaveTextContent(surface.label);
		}
		// Default is the mixed preset: it must show both words, or the card
		// gives the user no reason to prefer one preset over the other.
		expect(card).toHaveTextContent('Proportional');
		expect(card).toHaveTextContent('Monospace');
	});
});
