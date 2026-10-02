/**
 * @file PianolaDashboard.test.tsx
 * @description Tests the dashboard component's data mapping: how DashboardData
 * and PortfolioData shapes (produced elsewhere by the pure derivations, tested
 * separately) are rendered into the program strip, the status sections, the
 * Results section, the activity feed's action labels, the click-to-jump wiring,
 * the empty states, and founder-ask resolution. The hook is mocked so the test
 * exercises only the view layer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { Theme } from '../../../../renderer/types';
import type {
	DashboardData,
	PortfolioData,
} from '../../../../renderer/components/PianolaDashboard/usePianolaDashboardData';

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
		error: '#ef4444',
		border: '#333355',
	},
} as unknown as Theme;

const now = Date.now();

function emptyData(): DashboardData {
	return { needsInput: [], working: [], recentlyDone: [], activity: [] };
}

function emptyPortfolio(): PortfolioData {
	return {
		programs: [],
		asks: [],
		escalations: [],
		needsReview: [],
		failed: [],
		working: [],
		finished: [],
		results: [],
	};
}

/** Mirrors what derivePortfolio yields when no program exists: one untitled group. */
function portfolioFor(data: DashboardData): PortfolioData {
	const loose = <T,>(rows: T[]) => (rows.length > 0 ? [{ key: 'no-program', rows }] : []);
	return { ...emptyPortfolio(), working: loose(data.working), finished: loose(data.recentlyDone) };
}

function mockHook(data: DashboardData, portfolio: PortfolioData = portfolioFor(data)): void {
	hookMock.usePianolaDashboardData.mockReturnValue({ data, portfolio, refresh });
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
	mockHook(populatedData());
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
		mockHook(emptyData(), emptyPortfolio());
		render(<PianolaDashboard theme={theme} onJumpToAgent={vi.fn()} />);

		expect(screen.getByText('No agents are waiting on you.')).toBeInTheDocument();
		expect(screen.getByText('No agents are working right now.')).toBeInTheDocument();
		expect(screen.getByText('Nothing finished recently.')).toBeInTheDocument();
		expect(screen.getByText('No decisions recorded yet.')).toBeInTheDocument();
		expect(screen.getByText('Nothing verified yet.')).toBeInTheDocument();
		expect(screen.queryByTestId('pianola-program-strip')).not.toBeInTheDocument();
	});
});

describe('PianolaDashboard portfolio', () => {
	it('shows the program strip, a founder ask, and verified results grouped by program', () => {
		mockHook(emptyData(), {
			...emptyPortfolio(),
			programs: [
				{
					id: 'p1',
					title: 'Checkout',
					status: 'active',
					activePlanId: 'plan-1',
					activePlanTitle: 'One-page checkout',
					openAsks: 1,
					running: 2,
					verifiedLast7d: 3,
					loop: { supervised: true },
				},
			],
			asks: [
				{
					id: 'ask-1',
					title: 'Approve the provider switch',
					detail: 'fees',
					severity: 'high',
					requestedAction: 'Pick Stripe or keep Adyen',
					programTitle: 'Checkout',
					since: now,
				},
			],
			results: [
				{
					key: 'p1',
					programTitle: 'Checkout',
					rows: [
						{
							key: 'plan-1:t1',
							taskTitle: 'Address form',
							planTitle: 'One-page checkout',
							checkName: 'independent-validation',
							completedAt: now,
						},
					],
				},
			],
		});
		render(<PianolaDashboard theme={theme} onJumpToAgent={vi.fn()} />);

		const strip = screen.getByTestId('pianola-program-strip');
		expect(strip).toHaveTextContent('Plan: One-page checkout');
		expect(strip).toHaveTextContent('1 open ask · 2 running · 3 verified (7d)');
		expect(screen.getByText('Pick Stripe or keep Adyen')).toBeInTheDocument();
		expect(screen.getByText('Address form')).toBeInTheDocument();
		expect(screen.getByText('independent-validation')).toBeInTheDocument();
		expect(screen.queryByText('Nothing verified yet.')).not.toBeInTheDocument();
	});

	it('resolves a founder ask with the chosen option and note, then refreshes', async () => {
		// The global window.maestro mock resolves resolveAsk; the row ignores its value.
		mockHook(emptyData(), {
			...emptyPortfolio(),
			asks: [
				{
					id: 'ask-1',
					title: 'Approve the provider switch',
					detail: '',
					severity: 'critical',
					since: now,
				},
			],
		});
		render(<PianolaDashboard theme={theme} onJumpToAgent={vi.fn()} />);

		fireEvent.click(screen.getByText('Resolve'));
		fireEvent.change(screen.getByPlaceholderText('Your decision'), {
			target: { value: ' Stripe ' },
		});
		fireEvent.change(screen.getByPlaceholderText('Note (optional)'), {
			target: { value: 'lower fees' },
		});
		fireEvent.click(screen.getByText('Submit'));

		await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
		expect(window.maestro.pianola.resolveAsk).toHaveBeenCalledWith('ask-1', 'Stripe', 'lower fees');
	});
});

describe('PianolaDashboard program loop', () => {
	function programsPortfolio(): PortfolioData {
		const base = { openAsks: 0, running: 0, verifiedLast7d: 0 };
		return {
			...emptyPortfolio(),
			programs: [
				{
					...base,
					id: 'p1',
					title: 'Checkout',
					status: 'active',
					loop: {
						supervised: true,
						lastWakeReason: 'plan-finished',
						lastWakeAt: new Date(now).toISOString(),
					},
				},
				{
					...base,
					id: 'p2',
					title: 'Search',
					status: 'paused',
					loop: { supervised: false },
				},
			],
		};
	}

	it('shows each program loop state with Supervise only on an unsupervised program', () => {
		mockHook(emptyData(), programsPortfolio());
		render(<PianolaDashboard theme={theme} onJumpToAgent={vi.fn()} />);

		const supervised = screen.getByTestId('pianola-program-p1');
		expect(screen.getByTestId('pianola-program-loop-p1')).toHaveTextContent(
			'Supervised · woke lead: plan finished'
		);
		expect(within(supervised).queryByText('Supervise')).not.toBeInTheDocument();
		expect(within(supervised).getByText('Pause')).toBeInTheDocument();

		const unsupervised = screen.getByTestId('pianola-program-p2');
		expect(screen.getByTestId('pianola-program-loop-p2')).toHaveTextContent('Not supervised');
		expect(within(unsupervised).getByText('Supervise')).toBeInTheDocument();
		expect(within(unsupervised).getByText('Resume')).toBeInTheDocument();
	});

	it('supervises a program by id, then refreshes', async () => {
		mockHook(emptyData(), programsPortfolio());
		render(<PianolaDashboard theme={theme} onJumpToAgent={vi.fn()} />);

		fireEvent.click(within(screen.getByTestId('pianola-program-p2')).getByText('Supervise'));

		await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
		expect(window.maestro.pianola.superviseProgram).toHaveBeenCalledWith('p2');
	});

	it('pauses an active program and resumes a paused one, refreshing after each', async () => {
		mockHook(emptyData(), programsPortfolio());
		render(<PianolaDashboard theme={theme} onJumpToAgent={vi.fn()} />);

		fireEvent.click(within(screen.getByTestId('pianola-program-p1')).getByText('Pause'));
		await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
		expect(window.maestro.pianola.setProgramStatus).toHaveBeenCalledWith('p1', 'paused');

		fireEvent.click(within(screen.getByTestId('pianola-program-p2')).getByText('Resume'));
		await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
		expect(window.maestro.pianola.setProgramStatus).toHaveBeenCalledWith('p2', 'active');
	});

	it('shows a failed status change inline and does not refresh', async () => {
		vi.mocked(window.maestro.pianola.setProgramStatus).mockRejectedValueOnce(
			new Error('PianolaDisabled')
		);
		mockHook(emptyData(), programsPortfolio());
		render(<PianolaDashboard theme={theme} onJumpToAgent={vi.fn()} />);

		fireEvent.click(within(screen.getByTestId('pianola-program-p1')).getByText('Pause'));

		expect(await screen.findByText('PianolaDisabled')).toBeInTheDocument();
		expect(refresh).not.toHaveBeenCalled();
	});

	it('renders a program-loop decision as a compact loop line beside a regular decision', () => {
		mockHook({
			...emptyData(),
			activity: [
				{
					id: 'loop1:intent',
					sessionId: 'lead',
					agentName: 'Lead',
					action: 'ignore',
					topic: '',
					timestamp: now,
					dispatched: false,
					loop: { programTitle: 'Checkout', action: 'woke lead (idle)' },
				},
				{
					id: 'd1:done',
					sessionId: 'a',
					agentName: 'Alpha',
					action: 'auto_answer',
					topic: 'use tabs',
					timestamp: now,
					dispatched: true,
				},
			],
		});
		render(<PianolaDashboard theme={theme} onJumpToAgent={vi.fn()} />);

		const loopRow = screen.getByTestId('pianola-loop-row-loop1:intent');
		expect(loopRow).toHaveTextContent('Checkout');
		expect(loopRow).toHaveTextContent('woke lead (idle)');
		expect(screen.queryByText('Ignored')).not.toBeInTheDocument();
		expect(screen.queryByText('Lead')).not.toBeInTheDocument();
		expect(screen.getByText('Auto-answered')).toBeInTheDocument();
		expect(screen.getByText('use tabs')).toBeInTheDocument();
	});
});
