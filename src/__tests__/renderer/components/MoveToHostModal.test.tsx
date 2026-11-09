/**
 * The Move to Host modal (FED-SSH-06): it shows the `maestro-cli lift --dry-run` plan, rebuilds it
 * when secret env vars are included, refuses to move without a plan, and closes only once the lift
 * landed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../../renderer/services/agentLift', () => ({
	planMoveToHost: vi.fn(),
	moveAgentToHost: vi.fn(),
}));

import { MoveToHostModal } from '../../../renderer/components/MoveToHostModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { THEMES } from '../../../renderer/constants/themes';
import { moveAgentToHost, planMoveToHost } from '../../../renderer/services/agentLift';

const theme = THEMES['dracula'];

const planAnswer = (text: string) =>
	({ ok: true, planText: text, result: { dryRun: true } }) as never;

function renderModal(onClose = vi.fn()) {
	render(
		<LayerStackProvider>
			<MoveToHostModal theme={theme} sessionId="s1" agentName="Docs" onClose={onClose} />
		</LayerStackProvider>
	);
	return onClose;
}

const moveButton = () => screen.getByRole('button', { name: /Move to Host/ });

beforeEach(() => {
	vi.mocked(planMoveToHost).mockReset();
	vi.mocked(moveAgentToHost).mockReset();
});

describe('MoveToHostModal', () => {
	it('shows the dry-run plan, and rebuilds it with secret env vars', async () => {
		vi.mocked(planMoveToHost).mockImplementation(async (_id, withEnv) =>
			planAnswer(withEnv ? 'Would lift (with secrets)' : 'Would lift "Docs"')
		);
		renderModal();
		expect(screen.getByTestId('move-to-host-plan-loading')).toBeTruthy();
		expect(moveButton()).toBeDisabled();
		expect(await screen.findByTestId('move-to-host-plan')).toHaveTextContent('Would lift "Docs"');
		expect(planMoveToHost).toHaveBeenCalledWith('s1', false);
		expect(moveButton()).not.toBeDisabled();

		fireEvent.click(screen.getByRole('checkbox', { name: /Send secret env vars too/ }));
		await waitFor(() => expect(planMoveToHost).toHaveBeenLastCalledWith('s1', true));
		expect(await screen.findByText('Would lift (with secrets)')).toBeTruthy();
	});

	it('shows a refusal and keeps Move disabled', async () => {
		vi.mocked(planMoveToHost).mockResolvedValue({
			ok: false,
			code: 'LIFT_BUSY',
			error: '"Docs" is busy: a turn is running.',
		});
		renderModal();
		expect(await screen.findByText(/is busy: a turn is running/)).toBeTruthy();
		expect(moveButton()).toBeDisabled();
	});

	it('lifts with the chosen env option and closes on success', async () => {
		vi.mocked(planMoveToHost).mockResolvedValue(planAnswer('Would lift'));
		vi.mocked(moveAgentToHost).mockResolvedValue({ ok: true } as never);
		const onClose = renderModal();
		await screen.findByTestId('move-to-host-plan');
		fireEvent.click(moveButton());
		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(moveAgentToHost).toHaveBeenCalledWith('s1', false);
	});

	it('stays open with the reason when the lift fails', async () => {
		vi.mocked(planMoveToHost).mockResolvedValue(planAnswer('Would lift'));
		vi.mocked(moveAgentToHost).mockResolvedValue({
			ok: false,
			code: 'LIFT_POINTER_FAILED',
			error: 'Could not mark "Docs" as moved. The host\'s copy was removed again.',
		});
		const onClose = renderModal();
		await screen.findByTestId('move-to-host-plan');
		fireEvent.click(moveButton());
		expect(await screen.findByText(/The host's copy was removed again/)).toBeTruthy();
		expect(onClose).not.toHaveBeenCalled();
	});
});
