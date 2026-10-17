/**
 * Tests for Edit Agent's System One switch on the Models tab: it applies at
 * once and flushes to main, on is the absence of the opt-out, and the line
 * under it says what a request from this agent would meet (the engine that
 * answers, the switch that refuses, or an SSH remote it cannot ask from).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { AgentSystemOneControl } from '../../../../renderer/components/NewInstanceModal/AgentSystemOneControl';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import type { Session, Theme } from '../../../../renderer/types';
import { SYSTEM_ONE_AGENT_SWITCH_DESCRIPTIONS } from '../../../../shared/local-models/system-one-agent';
import { refusedSystemOneAccess, systemOneAccess } from '../../../helpers/systemOneAccess';

const theme = {
	colors: {
		accent: '#a78bfa',
		accentDim: '#a78bfa33',
		accentForeground: '#ffffff',
		textMain: '#ffffff',
		textDim: '#888888',
		border: '#333333',
		bgMain: '#000000',
		bgActivity: '#111111',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
} as unknown as Theme;

const api = () => window.maestro.localModels.systemOne;
const toggle = () => screen.getByRole('switch', { name: 'Let Backend use System One' });
const stored = (): Session => useSessionStore.getState().sessions[0];

function seed(overrides: Partial<Session> = {}): void {
	useSessionStore.setState({
		sessions: [
			{ id: 'agent-1', name: 'Backend', toolType: 'claude-code', aiTabs: [], ...overrides },
		],
	} as never);
}

/** The control as Edit Agent mounts it: the switch shows the live store entry. */
function Mounted({ sshRemoteName }: { sshRemoteName?: string }) {
	const optedOut = useSessionStore((s) => s.sessions[0]?.systemOneOptOut === true);
	return (
		<AgentSystemOneControl
			theme={theme}
			agentId="agent-1"
			agentName="Backend"
			optedOut={optedOut}
			sshRemoteName={sshRemoteName}
		/>
	);
}

beforeEach(() => {
	vi.mocked(api().agentAccess).mockReset().mockResolvedValue(systemOneAccess());
	vi.mocked(api().test).mockClear();
	vi.mocked(window.maestro.sessions.setMany)
		.mockReset()
		.mockResolvedValue(undefined as never);
});

afterEach(() => {
	useSessionStore.setState({ sessions: [] } as never);
});

describe('AgentSystemOneControl', () => {
	it('is on for an agent that was never switched off, and says which engine answers', async () => {
		seed();
		render(<Mounted />);

		expect(toggle()).toHaveAttribute('aria-checked', 'true');
		expect(screen.getByTestId('edit-agent-system-one')).toHaveTextContent(
			SYSTEM_ONE_AGENT_SWITCH_DESCRIPTIONS.on
		);
		expect(await screen.findByTestId('edit-agent-system-one-status')).toHaveTextContent(
			'Its requests are answered by Jev (TypeSafe cloud).'
		);
		// The read is for THIS agent, and asks the engine nothing.
		expect(api().agentAccess).toHaveBeenCalledWith('agent-1');
		expect(api().test).not.toHaveBeenCalled();
	});

	it('switches the agent off at once, flushes it to main, and reads the access again', async () => {
		seed();
		render(<Mounted />);
		await screen.findByTestId('edit-agent-system-one-status');

		fireEvent.click(toggle());

		await waitFor(() => expect(stored().systemOneOptOut).toBe(true));
		expect(window.maestro.sessions.setMany).toHaveBeenCalledWith(
			[expect.objectContaining({ id: 'agent-1', systemOneOptOut: true })],
			[]
		);
		await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'false'));
		expect(screen.getByTestId('edit-agent-system-one')).toHaveTextContent(
			SYSTEM_ONE_AGENT_SWITCH_DESCRIPTIONS.off
		);
		// Off is the whole answer: no engine line under it.
		expect(screen.queryByTestId('edit-agent-system-one-status')).toBeNull();
		// The opt-out raises no settings event, so the control asks again itself.
		await waitFor(() => expect(api().agentAccess).toHaveBeenCalledTimes(2));
	});

	it('switches it back on by removing the field', async () => {
		seed({ systemOneOptOut: true });
		vi.mocked(api().agentAccess).mockResolvedValue(refusedSystemOneAccess('agent-opted-out'));
		render(<Mounted />);
		expect(toggle()).toHaveAttribute('aria-checked', 'false');

		vi.mocked(api().agentAccess).mockResolvedValue(systemOneAccess());
		fireEvent.click(toggle());

		await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'true'));
		expect('systemOneOptOut' in stored()).toBe(true);
		expect(stored().systemOneOptOut).toBeUndefined();
		expect(await screen.findByTestId('edit-agent-system-one-status')).toHaveTextContent(
			'Its requests are answered by'
		);
	});

	it('says which other switch refuses, in words for a person', async () => {
		seed();
		vi.mocked(api().agentAccess).mockResolvedValue(refusedSystemOneAccess('agents-off'));
		render(<Mounted />);

		const status = await screen.findByTestId('edit-agent-system-one-status');
		expect(status).toHaveTextContent('System One is off (agents-off).');
		// The instruction to the agent is not copy for a settings pane.
		expect(status).not.toHaveTextContent('Continue without System One');
	});

	it('says a local judge is not calibrated, and what the agent spent of its own cap', async () => {
		seed();
		vi.mocked(api().agentAccess).mockResolvedValue(
			systemOneAccess({
				engine: 'local-judge',
				engineLabel: 'Local judge',
				calibrated: false,
				budget: {
					dayStartedAt: 0,
					dailyBudgetUsd: 1,
					spentTodayUsd: 0.2,
					remainingTodayUsd: 0.8,
					agent: {
						agentId: 'agent-1',
						budgetUsd: 0.25,
						spentTodayUsd: 0.0000672,
						remainingTodayUsd: 0.2499328,
					},
				},
			})
		);
		render(<Mounted />);

		const status = await screen.findByTestId('edit-agent-system-one-status');
		expect(status).toHaveTextContent('answered by Local judge, which is not calibrated.');
		expect(status).toHaveTextContent('It has spent $0.000067 today of its $0.25.');
	});

	it('says an agent on an SSH remote cannot ask, whatever the engine is', async () => {
		seed();
		render(<Mounted sshRemoteName="build-box" />);

		const status = await screen.findByTestId('edit-agent-system-one-status');
		expect(status).toHaveTextContent('This agent runs on build-box');
		expect(status).toHaveTextContent('it is not told about System One');
		expect(status).not.toHaveTextContent('answered by');
	});

	it('shows a read that failed, and a write that was refused', async () => {
		seed();
		vi.mocked(api().agentAccess).mockRejectedValue(new Error('bridge closed'));
		render(<Mounted />);
		expect(await screen.findByTestId('edit-agent-system-one-status-error')).toHaveTextContent(
			'bridge closed'
		);

		// The agent was removed while the dialog was open.
		useSessionStore.setState({ sessions: [] } as never);
		fireEvent.click(screen.getByRole('switch'));
		expect(await screen.findByTestId('edit-agent-system-one-error')).toHaveTextContent(
			'Agent not found'
		);
	});
});
