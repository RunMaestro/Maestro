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

	it('leads with the settings the user was just offered, then keeps going', () => {
		// The font and the theme are immediately checkable, which is what makes
		// the broader "any setting" claim credible - so the pill names both and
		// then names a third thing neither wizard step showed.
		renderModal();

		expect(screen.getByText('Change any setting')).toBeInTheDocument();
		const prompt = screen.getByTestId('agent-powers-example-change-any-setting').textContent ?? '';
		expect(prompt).toMatch(/font/i);
		expect(prompt).toMatch(/theme/i);
		expect(prompt).toMatch(/notifications/i);
	});

	it('shows the range beyond appearance', () => {
		renderModal();

		expect(screen.getByText('Create agents')).toBeInTheDocument();
		expect(screen.getByText('Write an Auto Run doc')).toBeInTheDocument();
		expect(screen.getByText('Schedule a task')).toBeInTheDocument();
		expect(screen.getByText('Build a Cue pipeline')).toBeInTheDocument();
		expect(screen.getByText('Build me a dashboard')).toBeInTheDocument();
	});

	it('splits the two automation pills by what starts them', () => {
		// A Scheduled Task is clock-driven and a pipeline hangs off an event, so
		// two wall-clock prompts would present one feature twice.
		renderModal();

		const scheduled = screen.getByTestId('agent-powers-example-schedule-a-task').textContent ?? '';
		const pipeline =
			screen.getByTestId('agent-powers-example-build-a-cue-pipeline').textContent ?? '';

		expect(scheduled).toMatch(/9am|weekday/i);
		expect(pipeline).toMatch(/whenever|pull request/i);
		expect(pipeline).not.toMatch(/\bam\b|every (morning|weekday|day)/i);
	});

	it('says the list is not exhaustive', () => {
		renderModal();
		expect(screen.getByText(/not a fixed list/i)).toBeInTheDocument();
	});

	it('spends the closing paragraph on capabilities no pill already shows', () => {
		// The paragraph exists to widen the claim. Repeating a pill's label there
		// spends the only line of prose left restating the grid above it.
		renderModal();

		const closing = screen.getByText(/not a fixed list/i).textContent ?? '';
		for (const shown of [
			'Create agents',
			'Write an Auto Run doc',
			'Schedule a task',
			'Build a Cue pipeline',
			'Build me a dashboard',
		]) {
			expect(closing.toLowerCase()).not.toContain(shown.toLowerCase());
		}
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

			fireEvent.click(screen.getByTestId('agent-powers-example-change-any-setting'));
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

			const example = screen.getByTestId('agent-powers-example-change-any-setting');
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
