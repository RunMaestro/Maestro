/**
 * @file PianolaDashboard.test.tsx
 * @description Tests the dashboard component's data mapping: how a DashboardData
 * shape (produced elsewhere by the pure deriveDashboard, tested separately) is
 * rendered into the four status sections, the activity feed's action labels, the
 * click-to-jump wiring, and the empty states. The hook is mocked so the test
 * exercises only the view layer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Theme } from '../../../../renderer/types';
import type { DashboardData } from '../../../../renderer/components/PianolaDashboard/usePianolaDashboardData';

const hookMock = vi.hoisted(() => ({ usePianolaDashboardData: vi.fn() }));
vi.mock('../../../../renderer/components/PianolaDashboard/usePianolaDashboardData', () => hookMock);

import { PianolaDashboard } from '../../../../renderer/components/PianolaDashboard/PianolaDashboard';

const theme = {
	colors: {
		bgMain: '#1a1a2e',
		bgSidebar: '#16213e',
		textMain: '#e8e8e8',
		textDim: '#888888',
		accent: '#7b2cbf',
		success: '#22c55e',
		warning: '#f59e0b',
		border: '#333355',
	},
} as unknown as Theme;

const now = Date.now();

function emptyData(): DashboardData {
	return { needsInput: [], working: [], recentlyDone: [], activity: [] };
}

function populatedData(): DashboardData {
	return {
		needsInput: [
			{ key: 'a', sessionId: 'a', agentName: 'Alpha', description: 'pick a name', timestamp: now },
		],
		working: [{ key: 'b', sessionId: 'b', agentName: 'Beta', description: 'refactor parser' }],
		recentlyDone: [
			{
				key: 'c',
				sessionId: 'c',
				agentName: 'Gamma',
				description: 'shipped feature',
				timestamp: now,
			},
		],
		activity: [
			{
				id: 'd1',
				sessionId: 'a',
				agentName: 'Alpha',
				action: 'auto_answer',
				topic: 'use tabs',
				timestamp: now,
				dispatched: true,
			},
			{
				id: 'd2',
				sessionId: undefined,
				agentName: 'Ghost',
				action: 'handoff',
				topic: 'orphan ask',
				timestamp: now,
				dispatched: false,
			},
		],
	};
}

const refresh = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	hookMock.usePianolaDashboardData.mockReturnValue({ data: populatedData(), refresh });
});

describe('PianolaDashboard data mapping', () => {
	it('renders each status bucket and the agents in it', () => {
		render(<PianolaDashboard theme={theme} onJumpToAgent={vi.fn()} />);

		expect(screen.getByText('Needs your input')).toBeInTheDocument();
		expect(screen.getByText('pick a name')).toBeInTheDocument();
		expect(screen.getByText('refactor parser')).toBeInTheDocument();
		expect(screen.getByText('shipped feature')).toBeInTheDocument();
		expect(screen.getByText('Beta')).toBeInTheDocument();
	});

	it('maps activity actions to their display labels', () => {
		render(<PianolaDashboard theme={theme} onJumpToAgent={vi.fn()} />);

		expect(screen.getByText('Auto-answered')).toBeInTheDocument();
		expect(screen.getByText('Handed to Pianola')).toBeInTheDocument();
		expect(screen.getByText('use tabs')).toBeInTheDocument();
		expect(screen.getByText('orphan ask')).toBeInTheDocument();
	});

	it('jumps to the owning agent when a row with a session id is clicked', () => {
		const onJump = vi.fn();
		render(<PianolaDashboard theme={theme} onJumpToAgent={onJump} />);

		fireEvent.click(screen.getByText('pick a name'));
		expect(onJump).toHaveBeenCalledWith('a');
	});

	it('disables an activity row that has no owning agent', () => {
		render(<PianolaDashboard theme={theme} onJumpToAgent={vi.fn()} />);

		const ghostRow = screen.getByText('orphan ask').closest('button');
		expect(ghostRow).toBeDisabled();
	});

	it('forwards the refresh control to the hook', () => {
		render(<PianolaDashboard theme={theme} onJumpToAgent={vi.fn()} />);

		fireEvent.click(screen.getByText('Refresh'));
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it('shows empty-state copy for every bucket when there is no data', () => {
		hookMock.usePianolaDashboardData.mockReturnValue({ data: emptyData(), refresh });
		render(<PianolaDashboard theme={theme} onJumpToAgent={vi.fn()} />);

		expect(screen.getByText('No agents are waiting on you.')).toBeInTheDocument();
		expect(screen.getByText('No agents are working right now.')).toBeInTheDocument();
		expect(screen.getByText('Nothing finished recently.')).toBeInTheDocument();
		expect(screen.getByText('No decisions recorded yet.')).toBeInTheDocument();
	});
});
