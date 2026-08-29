import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: vi.fn(() => 'layer-test'),
		unregisterLayer: vi.fn(),
		updateLayerHandler: vi.fn(),
	}),
}));

import { AgentPowersModal } from '../../../renderer/components/AgentPowersModal';
import { mockTheme } from '../../helpers/mockTheme';

function renderModal(overrides: Partial<React.ComponentProps<typeof AgentPowersModal>> = {}) {
	const props = {
		theme: mockTheme,
		isOpen: true,
		onDismiss: vi.fn(),
		...overrides,
	};
	render(<AgentPowersModal {...props} />);
	return props;
}

afterEach(() => {
	cleanup();
});

describe('AgentPowersModal', () => {
	it('renders nothing when closed', () => {
		renderModal({ isOpen: false });
		expect(screen.queryByTestId('agent-powers-modal')).not.toBeInTheDocument();
	});

	it('leads with the two things the user was just offered', () => {
		// Fonts and themes are immediately checkable, which is what makes the
		// broader claim credible.
		renderModal();

		expect(screen.getByText('Change the fonts')).toBeInTheDocument();
		expect(screen.getByText('Change the theme')).toBeInTheDocument();
	});

	it('shows the range beyond appearance', () => {
		renderModal();

		expect(screen.getByText('Create agents')).toBeInTheDocument();
		expect(screen.getByText('Write an Auto Run doc')).toBeInTheDocument();
	});

	it('says the list is not exhaustive', () => {
		renderModal();
		expect(screen.getByText(/not a fixed list/i)).toBeInTheDocument();
	});

	it('closes on Got it', () => {
		const { onDismiss } = renderModal();

		fireEvent.click(screen.getByTestId('agent-powers-confirm'));
		expect(onDismiss).toHaveBeenCalled();
	});

	describe('example prompts', () => {
		it('drops the prompt into the composer rather than sending it', () => {
			// The user should see what is being asked, and get to edit it, before
			// an agent acts on their app.
			const onTryExample = vi.fn();
			renderModal({ onTryExample });

			fireEvent.click(screen.getByTestId('agent-powers-example-change-the-theme'));
			expect(onTryExample).toHaveBeenCalledWith(expect.stringContaining('theme'));
		});

		it('closes after handing over an example', () => {
			const onTryExample = vi.fn();
			const { onDismiss } = renderModal({ onTryExample });

			fireEvent.click(screen.getByTestId('agent-powers-example-create-agents'));
			expect(onDismiss).toHaveBeenCalled();
		});

		it('renders the examples inert when there is no agent to talk to', () => {
			// A fresh install may have no agent yet; the examples still explain
			// the idea, they just cannot be handed anywhere.
			renderModal({ onTryExample: undefined });

			const example = screen.getByTestId('agent-powers-example-change-the-theme');
			expect(example).toBeDisabled();
		});

		it('mentions the composer only when an example can reach one', () => {
			const withAgent = renderModal({ onTryExample: vi.fn() });
			expect(screen.getByText(/drop it into the composer/i)).toBeInTheDocument();
			void withAgent;

			cleanup();
			renderModal({ onTryExample: undefined });
			expect(screen.queryByText(/drop it into the composer/i)).not.toBeInTheDocument();
		});
	});
});
