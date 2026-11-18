/**
 * The Move to Host modal (FED-SSH-06). With a connected host it draws the
 * `maestro-cli lift --dry-run` plan, rebuilds it when secret env vars are included, refuses to
 * move without a plan, and closes only once the lift landed. A failure is pinned above the plan;
 * a host too old to accept the agent gets the steps that fix it. With no host yet it is Make
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
vi.mock('../../../renderer/utils/clipboard', () => ({
	safeClipboardWrite: vi.fn().mockResolvedValue(true),
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
import type { LiftPlanSummary } from '../../../shared/maestro-lib/agents/lift-plan';
import { LIFT_HOST_TOO_OLD } from '../../../shared/federationCommands';
import { safeClipboardWrite } from '../../../renderer/utils/clipboard';

const theme = THEMES['dracula'];

function summaryWith(overrides: Partial<LiftPlanSummary> = {}): LiftPlanSummary {
	return {
		agent: { id: 's1', name: 'Docs', provider: 'claude-code' },
		peer: 'build',
		remote: { id: 'r1', name: 'build' },
		cwd: '/home/me/docs',
		env: { sent: [], secretsSent: [], withheld: [] },
		tabs: [
			{ id: 't1', name: 'Main', agentSessionId: 'sess-1', entries: 4 },
			{ id: 't2', name: 'Notes', agentSessionId: null, entries: 0 },
		],
		activeTabId: 't1',
		queued: [],
		stays: [],
		...overrides,
	};
}

const planAnswer = (text: string, summary: LiftPlanSummary = summaryWith()) =>
	({ ok: true, planText: text, result: { dryRun: true, plan: summary } }) as never;

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

const moveButton = () => screen.getByRole('button', { name: /^(Move to Host|Retry Move)$/ });

beforeEach(() => {
	vi.mocked(planMoveToHost).mockReset();
	vi.mocked(moveAgentToHost).mockReset();
	vi.mocked(setupRemoteHostFromWindow).mockReset();
});

describe('MoveToHostModal', () => {
	it('draws the dry-run plan, and rebuilds it with secret env vars', async () => {
		vi.mocked(planMoveToHost).mockImplementation(async (_id, withEnv) =>
			planAnswer(
				'Would lift "Docs"',
				summaryWith(
					withEnv
						? { env: { sent: ['TOKEN'], secretsSent: ['TOKEN'], withheld: [] } }
						: {
								env: { sent: [], secretsSent: [], withheld: ['TOKEN'] },
								stays: [{ kind: 'secret-env', ref: 'TOKEN', reason: 'Secret.' }],
							}
				)
			)
		);
		renderModal();
		expect(screen.getByTestId('move-to-host-plan-loading')).toBeTruthy();
		expect(moveButton()).toBeDisabled();
		const plan = await screen.findByTestId('move-to-host-plan');
		expect(plan).toHaveTextContent('2 conversations continue on build');
		expect(plan).toHaveTextContent('1 secret env var');
		expect(planMoveToHost).toHaveBeenCalledWith('s1', false);
		expect(moveButton()).not.toBeDisabled();

		fireEvent.click(screen.getByRole('checkbox', { name: /Send secret env vars too/ }));
		await waitFor(() => expect(planMoveToHost).toHaveBeenLastCalledWith('s1', true));
		expect(await screen.findByText('Secret env vars that move: TOKEN')).toBeTruthy();
	});

	it('copies the plan as the CLI prints it', async () => {
		vi.mocked(planMoveToHost).mockResolvedValue(planAnswer('Would lift "Docs"'));
		renderModal();
		fireEvent.click(await screen.findByTestId('move-to-host-copy-plan'));
		await waitFor(() => expect(safeClipboardWrite).toHaveBeenCalledWith('Would lift "Docs"'));
	});

	it('shows a refusal and keeps Move disabled', async () => {
		vi.mocked(planMoveToHost).mockResolvedValue({
			ok: false,
			code: 'LIFT_BUSY',
			error: '"Docs" is busy: a turn is running.',
		});
		renderModal();
		expect(await screen.findByTestId('move-to-host-pinned-error')).toHaveTextContent(
			/is busy: a turn is running/
		);
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
		expect(await screen.findByTestId('move-to-host-pinned-error')).toHaveTextContent(
			/The host's copy was removed again/
		);
		expect(moveButton()).toHaveTextContent('Retry Move');
		expect(onClose).not.toHaveBeenCalled();
	});

	it('takes the body over with the fix when the host is too old, and folds the plan', async () => {
		vi.mocked(planMoveToHost).mockResolvedValue(planAnswer('Would lift'));
		vi.mocked(moveAgentToHost).mockResolvedValue({
			ok: false,
			code: LIFT_HOST_TOO_OLD,
			error: 'Peer "build": the Maestro running there is an older build.',
		});
		renderModal();
		await screen.findByTestId('move-to-host-plan');
		fireEvent.click(moveButton());
		const card = await screen.findByTestId('move-to-host-too-old');
		expect(card).toHaveTextContent("build can't accept this agent yet");
		expect(card).toHaveTextContent('Update Maestro.app on build');
		expect(card).toHaveTextContent('maestro-cli remote-host install build --restart --force');
		expect(screen.queryByTestId('move-to-host-pinned-error')).toBeNull();
		expect(screen.queryByTestId('move-to-host-plan')).toBeNull();

		fireEvent.click(screen.getByTestId('move-to-host-plan-fold'));
		expect(screen.getByTestId('move-to-host-plan')).toBeTruthy();
		expect(moveButton()).toHaveTextContent('Retry Move');
	});

	describe('Move to Host with no host yet (sets one up first)', () => {
		const setupButton = () => screen.getByTestId('move-to-host-setup');

		it('builds no plan, sets the host up, then moves to the plan once the peer connects', async () => {
			vi.mocked(setupRemoteHostFromWindow).mockResolvedValue({
				ok: true,
				result: { cli: 'installed', cliVersion: '1.0.0' },
			});
			vi.mocked(planMoveToHost).mockResolvedValue(planAnswer('Would lift "Docs"'));
			const handle = renderModal(vi.fn(), NO_HOST);
			expect(screen.queryByText('Make Federated')).toBeNull();
			expect(screen.getAllByText('Move to Host').length).toBeGreaterThan(0);
			expect(planMoveToHost).not.toHaveBeenCalled();

			fireEvent.click(setupButton());
			await waitFor(() =>
				expect(setupRemoteHostFromWindow).toHaveBeenCalledWith('r1', {}, { toastOnError: false })
			);

			// The mirror reports the host connected: the modal becomes Move to Host with its plan.
			handle.rerenderWith(READY);
			expect(await screen.findByTestId('move-to-host-plan')).toHaveTextContent(
				'2 conversations continue on build'
			);
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

		it('cannot set up a remote Federation does not reach (opted out, disabled, not checked)', () => {
			renderModal(vi.fn(), { kind: 'ssh', remoteId: 'r1', hostReady: false });
			expect(screen.getByText('Federation does not reach this remote')).toBeTruthy();
			expect(setupButton()).toBeDisabled();
		});
	});
});
