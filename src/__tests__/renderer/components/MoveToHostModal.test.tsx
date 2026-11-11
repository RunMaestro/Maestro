/**
 * The Move to Host / Make Federated modal (FED-SSH-06). With a connected host it shows the
 * `maestro-cli lift --dry-run` plan, rebuilds it when secret env vars are included, refuses to
 * move without a plan, and closes only once the lift landed. With no host yet it is Make
 * Federated: it sets the host up first (`remote-host install --start`) and offers the one retry
 * option a refusal names.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../../renderer/services/agentLift', () => ({
	planMoveToHost: vi.fn(),
	moveAgentToHost: vi.fn(),
	setupRemoteHostFromWindow: vi.fn(),
}));

import { MoveToHostModal } from '../../../renderer/components/MoveToHostModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { THEMES } from '../../../renderer/constants/themes';
import {
	moveAgentToHost,
	planMoveToHost,
	setupRemoteHostFromWindow,
} from '../../../renderer/services/agentLift';
import { createMirroredPeer } from '../../../shared/maestro-lib/client/peer-mirror';
import type { AgentFederationStatus } from '../../../renderer/utils/peerMirrorView';

const theme = THEMES['dracula'];

const planAnswer = (text: string) =>
	({ ok: true, planText: text, result: { dryRun: true } }) as never;

const peer = createMirroredPeer({ peerId: 'build', remoteId: 'r1', name: 'build' });
const READY: AgentFederationStatus = {
	kind: 'ssh',
	remoteId: 'r1',
	peer: { ...peer, connection: 'connected' },
	hostReady: true,
};
const NO_HOST: AgentFederationStatus = {
	kind: 'ssh',
	remoteId: 'r1',
	peer: { ...peer, connection: 'not-installed' },
	hostReady: false,
};

function renderModal(onClose = vi.fn(), status: AgentFederationStatus = READY) {
	const view = render(
		<LayerStackProvider>
			<MoveToHostModal
				theme={theme}
				sessionId="s1"
				agentName="Docs"
				status={status}
				onClose={onClose}
			/>
		</LayerStackProvider>
	);
	const rerenderWith = (next: AgentFederationStatus) =>
		view.rerender(
			<LayerStackProvider>
				<MoveToHostModal
					theme={theme}
					sessionId="s1"
					agentName="Docs"
					status={next}
					onClose={onClose}
				/>
			</LayerStackProvider>
		);
	return Object.assign(onClose, { rerenderWith });
}

const moveButton = () => screen.getByRole('button', { name: /Move to Host/ });

beforeEach(() => {
	vi.mocked(planMoveToHost).mockReset();
	vi.mocked(moveAgentToHost).mockReset();
	vi.mocked(setupRemoteHostFromWindow).mockReset();
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

	describe('Make Federated (no host yet)', () => {
		const setupButton = () => screen.getByTestId('move-to-host-setup');

		it('builds no plan, sets the host up, then moves to the plan once the peer connects', async () => {
			vi.mocked(setupRemoteHostFromWindow).mockResolvedValue({
				ok: true,
				result: { cli: 'installed', cliVersion: '1.0.0' },
			});
			vi.mocked(planMoveToHost).mockResolvedValue(planAnswer('Would lift "Docs"'));
			const handle = renderModal(vi.fn(), NO_HOST);
			expect(screen.getByText('Make Federated')).toBeTruthy();
			expect(planMoveToHost).not.toHaveBeenCalled();

			fireEvent.click(setupButton());
			await waitFor(() =>
				expect(setupRemoteHostFromWindow).toHaveBeenCalledWith('r1', {}, { toastOnError: false })
			);

			// The mirror reports the host connected: the modal becomes Move to Host with its plan.
			handle.rerenderWith(READY);
			expect(await screen.findByTestId('move-to-host-plan')).toHaveTextContent('Would lift "Docs"');
		});

		it('names the refusal and offers the one option that fixes it', async () => {
			vi.mocked(setupRemoteHostFromWindow)
				.mockResolvedValueOnce({
					ok: false,
					code: 'host-running',
					error: 'A host is running on build on version 0.9.0.',
				})
				.mockResolvedValueOnce({ ok: true, result: { cli: 'upgraded' } });
			renderModal(vi.fn(), NO_HOST);
			fireEvent.click(setupButton());
			expect(await screen.findByText(/A host is running on build/)).toBeTruthy();
			expect(setupButton()).toHaveTextContent('Upgrade and Restart Host');

			fireEvent.click(setupButton());
			await waitFor(() =>
				expect(setupRemoteHostFromWindow).toHaveBeenLastCalledWith(
					'r1',
					{ restart: true },
					{ toastOnError: false }
				)
			);
		});

		it('keeps an accepted option when the next refusal asks for another', async () => {
			vi.mocked(setupRemoteHostFromWindow)
				.mockResolvedValueOnce({ ok: false, code: 'host-running', error: 'A host is running.' })
				.mockResolvedValueOnce({
					ok: false,
					code: 'foreign-cli',
					error: 'Not installed by Maestro.',
				})
				.mockResolvedValueOnce({ ok: true, result: { cli: 'upgraded' } });
			renderModal(vi.fn(), NO_HOST);
			fireEvent.click(setupButton());
			await screen.findByText('A host is running.');
			fireEvent.click(setupButton());
			await screen.findByText('Not installed by Maestro.');
			fireEvent.click(setupButton());
			await waitFor(() =>
				expect(setupRemoteHostFromWindow).toHaveBeenLastCalledWith(
					'r1',
					{ restart: true, force: true },
					{ toastOnError: false }
				)
			);
		});

		it('cannot set up a remote that opted out of Federation', () => {
			renderModal(vi.fn(), { kind: 'ssh', remoteId: 'r1', hostReady: false });
			expect(screen.getByText('Federation is off for this remote')).toBeTruthy();
			expect(setupButton()).toBeDisabled();
		});
	});
});
