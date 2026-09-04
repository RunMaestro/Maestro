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

		expect(screen.getByText('Change Any Setting')).toBeInTheDocument();
		const prompt = screen.getByTestId('agent-powers-example-change-any-setting').textContent ?? '';
		expect(prompt).toMatch(/font/i);
		expect(prompt).toMatch(/theme/i);
		expect(prompt).toMatch(/notifications/i);
	});

	it('shows the range beyond appearance', () => {
		renderModal();

		expect(screen.getByText('Create Agents')).toBeInTheDocument();
		expect(screen.getByText('Write an Auto Run Doc')).toBeInTheDocument();
		expect(screen.getByText('Schedule a Task')).toBeInTheDocument();
		expect(screen.getByText('Build a Cue Pipeline')).toBeInTheDocument();
		expect(screen.getByText('Build Me a Dashboard')).toBeInTheDocument();
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

	it('tells the user they do not have to be a power user', () => {
		// The grid can read as a list of things you need to learn. The closing
		// paragraph exists to say the opposite: the keyboard-driven way is real
		// and it is optional, because plain language reaches the same places.
		renderModal();

		const closing = screen.getByText(/power tool/i).textContent ?? '';
		expect(closing).toMatch(/do not have to/i);
		expect(closing).toMatch(/plain language/i);
	});

	it('names the advanced features the agent is taught, as proof of the claim', () => {
		// "Your agent knows how to drive Maestro" is only worth saying if it names
		// something the user would not expect it to reach on its own.
		renderModal();

		const closing = screen.getByText(/power tool/i).textContent ?? '';
		expect(closing).toMatch(/Auto Run/);
		expect(closing).toMatch(/Cue/);
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
