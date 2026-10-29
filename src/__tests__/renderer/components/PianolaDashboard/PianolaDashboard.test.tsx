/**
 * @file PianolaDashboard.test.tsx
 * @description Tests the dashboard component's data mapping: how DashboardData
 * and PortfolioData shapes (produced elsewhere by the pure derivations, tested
 * separately) are rendered into the program strip, the status sections, the
 * Results section, the activity feed's action labels, the click-to-jump wiring,
 * the empty states, and founder-ask resolution. The hook is mocked so the test
 * exercises only the view layer.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { createMockNativeDecisionPair } from '../../../helpers/pianola';
import { startPianolaDecision } from '../../../../shared/pianola/pianola-decision-lifecycle';
import type { PianolaDecisionLifecycle } from '../../../../shared/pianola/storage';
import type { Theme } from '../../../../renderer/types';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { createMockSession } from '../../../helpers/mockSession';
import { createMockAITab } from '../../../helpers/mockTab';
import type {
	DashboardData,
	PortfolioData,
} from '../../../../renderer/components/PianolaDashboard/usePianolaDashboardData';

const hookMock = vi.hoisted(() => ({ usePianolaDashboardData: vi.fn() }));
vi.mock('../../../../renderer/components/PianolaDashboard/usePianolaDashboardData', () => hookMock);
const supervisorMock = vi.hoisted(() => ({ usePianolaSupervisor: vi.fn() }));
vi.mock(
	'../../../../renderer/components/PianolaDashboard/usePianolaSupervisor',
	() => supervisorMock
);

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
	hookMock.usePianolaDashboardData.mockReturnValue({ data, portfolio, decisions: [], refresh });
}

function selectWorkspaceTab(label: string): void {
	fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${label}\\s*\\d*$`) }));
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
	useSessionStore.setState({ sessions: [] });
	mockHook(populatedData());
	supervisorMock.usePianolaSupervisor.mockReturnValue({
		targets: [],
		health: [],
		checkpoints: [],
		saveScope: vi.fn(),
		watched: [],
		watchable: [],
		autoWatchNewAgents: false,
		setAutoWatchNewAgents: vi.fn(),
		watch: vi.fn(),
		unwatch: vi.fn(),
		setEnabled: vi.fn(),
		refresh: vi.fn(),
	});
});

describe('PianolaDashboard data mapping', () => {
	it('collapses a long watch list and keeps the add action accessible', () => {
		supervisorMock.usePianolaSupervisor.mockReturnValue({
			...supervisorMock.usePianolaSupervisor(),
			watched: Array.from({ length: 6 }, (_, i) => ({
				targetId: `target-${i}`,
				agentId: `agent-${i}`,
				agentName: `Agent ${i}`,
				enabled: true,
			})),
		});
		render(<PianolaDashboard theme={theme} onJumpToAgent={vi.fn()} />);
		expect(screen.queryByText('Watched by Pianola')).not.toBeInTheDocument();
		expect(screen.queryByText('Agent 0')).not.toBeInTheDocument();
		selectWorkspaceTab('Watched');
		expect(screen.getByText('Watched by Pianola')).toBeInTheDocument();
		expect(screen.getByText('Watch an agent')).toBeInTheDocument();
		expect(screen.queryByText('Agent 0')).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: '+ Add selection' })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Show agents' }));
		expect(screen.getByText('Agent 0')).toBeInTheDocument();
		expect(screen.getByText('Agent 5')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Hide agents' }));
		expect(screen.queryByText('Agent 5')).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Show agents' }));
		expect(screen.getByText('Agent 5')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Hide agents' }));
		expect(screen.queryByText('Agent 5')).not.toBeInTheDocument();
	});

	it('shows failures and backing-off watches while the watch list is collapsed', () => {
		supervisorMock.usePianolaSupervisor.mockReturnValue({
			...supervisorMock.usePianolaSupervisor(),
			watched: Array.from({ length: 6 }, (_, i) => ({
				targetId: `target-${i}`,
				agentId: `agent-${i}`,
				agentName: `Agent ${i}`,
				enabled: true,
				state: i === 0 ? 'failed' : i === 1 ? 'backing-off' : 'running',
			})),
		});
		render(<PianolaDashboard theme={theme} onJumpToAgent={vi.fn()} />);
		expect(screen.queryByText('Agent 0')).not.toBeInTheDocument();
		selectWorkspaceTab('Watched');
		expect(screen.getByRole('status')).toHaveTextContent('2 failing');
	});

	it('offers the automatic watch setting in the dashboard', () => {
		const setAutoWatchNewAgents = vi.fn();
		supervisorMock.usePianolaSupervisor.mockReturnValue({
			...supervisorMock.usePianolaSupervisor(),
			setAutoWatchNewAgents,
		});
		render(<PianolaDashboard theme={theme} onJumpToAgent={vi.fn()} />);
		selectWorkspaceTab('Watched');
		fireEvent.click(screen.getByRole('checkbox', { name: 'Automatically watch new agents' }));
		expect(setAutoWatchNewAgents).toHaveBeenCalledWith(true);
	});
	it('renders each status bucket and the agents in it', () => {
		render(<PianolaDashboard theme={theme} onJumpToAgent={vi.fn()} />);

		expect(screen.getByRole('heading', { name: 'Needs you' })).toBeInTheDocument();
		expect(screen.getByText('pick a name')).toBeInTheDocument();
		expect(screen.getByText('refactor parser')).toBeInTheDocument();
		expect(screen.queryByText('shipped feature')).not.toBeInTheDocument();
		selectWorkspaceTab('Outcomes');
		expect(screen.getByText('shipped feature')).toBeInTheDocument();
		expect(screen.getByText('Beta')).toBeInTheDocument();
	});

	it('maps activity actions to their display labels', () => {
		render(<PianolaDashboard theme={theme} onJumpToAgent={vi.fn()} />);
		expect(screen.queryByText('Auto-answered')).not.toBeInTheDocument();
		selectWorkspaceTab('Activity');

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

	it.each([false, true])(
		'forwards the working tab when clicking a row (worktree: %s)',
		(isChild) => {
			const busyRow = {
				key: 'busy-agent',
				sessionId: 'busy-agent',
				tabId: 'busy-tab',
				agentName: 'Busy agent',
				description: 'Working task',
			};
			const data = emptyData();
			data.working = isChild
				? [
						{
							key: 'parent',
							sessionId: 'parent',
							agentName: 'Parent',
							description: '1 worktree working',
							worktreeChildren: [busyRow],
						},
					]
				: [busyRow];
			mockHook(data);
			const onJump = vi.fn();
			render(<PianolaDashboard theme={theme} onJumpToAgent={onJump} />);

			fireEvent.click(screen.getByText('Working task'));

			expect(onJump).toHaveBeenCalledWith('busy-agent', 'busy-tab');
		}
	);

	it('disables an activity row that has no owning agent', () => {
		render(<PianolaDashboard theme={theme} onJumpToAgent={vi.fn()} />);
		selectWorkspaceTab('Activity');

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

		expect(
			screen.getByText("You're clear. No decisions or failures need attention.")
		).toBeInTheDocument();
		expect(screen.getByText('No agents are working right now.')).toBeInTheDocument();
		selectWorkspaceTab('Outcomes');
		expect(screen.getByText('Nothing finished recently.')).toBeInTheDocument();
		expect(screen.getByText('Nothing verified yet.')).toBeInTheDocument();
		selectWorkspaceTab('Activity');
		expect(screen.getByText('No decisions recorded yet.')).toBeInTheDocument();
		expect(screen.queryByTestId('pianola-program-strip')).not.toBeInTheDocument();
	});
});

describe('PianolaDashboard portfolio', () => {
	it('jumps to the original escalation tab rather than the currently active conversation', () => {
		useSessionStore.setState({
			sessions: [
				createMockSession({
					id: 'lead',
					activeTabId: 'other',
					aiTabs: [createMockAITab({ id: 'origin' }), createMockAITab({ id: 'other' })],
				}),
			],
		});
		mockHook(emptyData(), {
			...emptyPortfolio(),
			escalations: [
				{
					key: 'escalation:d1',
					kind: 'escalation',
					title: 'Choose provider',
					sessionId: 'lead',
					tabId: 'origin',
					since: now,
				},
			],
		});
		const onJump = vi.fn();
		render(<PianolaDashboard theme={theme} onJumpToAgent={onJump} />);
		fireEvent.click(screen.getByRole('button', { name: 'Choose provider' }));
		expect(onJump).toHaveBeenCalledWith('lead');
		expect(useSessionStore.getState().sessions[0].activeTabId).toBe('origin');
	});

	it('keeps founder context readable and described while entering and submitting a decision', async () => {
		const detail =
			'Stripe costs 2 percent; Adyen costs 3 percent. Choose the provider for checkout.';
		mockHook(emptyData(), {
			...emptyPortfolio(),
			asks: [{ id: 'context', title: 'Choose provider', detail, severity: 'high', since: now }],
		});
		render(<PianolaDashboard theme={theme} onJumpToAgent={vi.fn()} />);
		const row = within(screen.getByTestId('pianola-ask-context'));
		expect(row.getByText(detail)).toBeVisible();
		const resolve = row.getByRole('button', { name: 'Resolve' });
		expect(resolve).toHaveAccessibleDescription(detail);
		resolve.focus();
		fireEvent.click(resolve);
		expect(row.getByRole('group', { name: 'Resolve Choose provider' })).toHaveAccessibleDescription(
			detail
		);
		expect(row.getByText(detail)).toBeVisible();
		fireEvent.change(row.getByPlaceholderText('Your decision'), { target: { value: 'Stripe' } });
		const submit = row.getByRole('button', { name: 'Submit' });
		expect(submit).toHaveAccessibleDescription(detail);
		fireEvent.click(submit);
		await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
		expect(window.maestro.pianola.resolveAsk).toHaveBeenCalledWith('context', 'Stripe', undefined);
	});

	it('offers restart and skip actions for failed tasks', () => {
		mockHook(emptyData(), {
			...emptyPortfolio(),
			failed: [
				{
					key: 'failed:plan-1:task-1',
					kind: 'failed',
					title: 'Broken deploy',
					planId: 'plan-1',
					taskId: 'task-1',
					since: now,
				},
			],
		});
		render(<PianolaDashboard theme={theme} onJumpToAgent={vi.fn()} />);

		expect(screen.getByRole('button', { name: 'Restart' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Revise' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Skip task' })).toBeInTheDocument();
	});

	it('restarts, revises, and skips failed tasks through IPC', async () => {
		const revise = vi.fn().mockResolvedValue(undefined);
		const skip = vi.fn().mockResolvedValue(undefined);
		Object.assign(window.maestro.pianola, { revisePlanTask: revise, skipPlanTask: skip });
		mockHook(emptyData(), {
			...emptyPortfolio(),
			failed: [
				{
					key: 'failed:plan-1:task-1',
					kind: 'failed',
					title: 'Broken deploy',
					planId: 'plan-1',
					taskId: 'task-1',
					since: now,
				},
			],
		});
		render(<PianolaDashboard theme={theme} onJumpToAgent={vi.fn()} />);

		fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
		await waitFor(() => expect(revise).toHaveBeenCalledWith('plan-1', 'task-1'));
		expect(refresh).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole('button', { name: 'Revise' }));
		fireEvent.change(screen.getByPlaceholderText('Revision instructions'), {
			target: { value: 'Deploy to staging first' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Revise & restart' }));
		await waitFor(() =>
			expect(revise).toHaveBeenCalledWith('plan-1', 'task-1', 'Deploy to staging first')
		);
		expect(refresh).toHaveBeenCalledTimes(2);
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		fireEvent.click(screen.getByRole('button', { name: 'Skip task' }));
		fireEvent.click(screen.getByRole('button', { name: 'Confirm skip' }));
		await waitFor(() => expect(skip).toHaveBeenCalledWith('plan-1', 'task-1'));
		expect(refresh).toHaveBeenCalledTimes(3);
	});
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
		selectWorkspaceTab('Programs');

		const strip = screen.getByTestId('pianola-program-strip');
		expect(strip).toHaveTextContent('Plan: One-page checkout');
		expect(strip).toHaveTextContent('1 open ask · 2 running · 3 verified (7d)');
		expect(screen.getByText('Pick Stripe or keep Adyen')).toBeInTheDocument();
		selectWorkspaceTab('Outcomes');
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
		selectWorkspaceTab('Programs');

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
		selectWorkspaceTab('Programs');

		fireEvent.click(within(screen.getByTestId('pianola-program-p2')).getByText('Supervise'));

		await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
		expect(window.maestro.pianola.superviseProgram).toHaveBeenCalledWith('p2');
	});

	it('pauses an active program and resumes a paused one, refreshing after each', async () => {
		mockHook(emptyData(), programsPortfolio());
		render(<PianolaDashboard theme={theme} onJumpToAgent={vi.fn()} />);
		selectWorkspaceTab('Programs');

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
		selectWorkspaceTab('Programs');

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
		selectWorkspaceTab('Activity');

		const loopRow = screen.getByTestId('pianola-loop-row-loop1:intent');
		expect(loopRow).toHaveTextContent('Checkout');
		expect(loopRow).toHaveTextContent('woke lead (idle)');
		expect(screen.queryByText('Ignored')).not.toBeInTheDocument();
		expect(screen.queryByText('Lead')).not.toBeInTheDocument();
		expect(screen.getByText('Auto-answered')).toBeInTheDocument();
		expect(screen.getByText('use tabs')).toBeInTheDocument();
	});
});

// Compose the existing native evidence factory with the production lifecycle
// initializer rather than introducing another decision mock factory.
const pair = createMockNativeDecisionPair('dashboard');
const pendingRecord = startPianolaDecision(
	{
		id: 'dashboard-decision',
		timestamp: pair.askedAt,
		agentId: pair.evidence!.agentId,
		tabId: pair.sessionId,
		classification: pair.classification,
		decision: {
			action: 'escalate',
			matchedRuleId: null,
			reason: 'Chris must choose the local inspection.',
		},
		dispatched: false,
		dryRun: false,
	},
	{
		scopeId: '11111111-1111-4111-8111-111111111111',
		configurationFingerprint: 'a'.repeat(64),
		bindingFingerprint: 'b'.repeat(64),
		agentId: pair.evidence!.agentId,
		tabId: pair.sessionId,
		messageId: pair.classification.evidence.messageId!,
		decisionId: 'dashboard-decision',
		cursor: { id: pair.classification.evidence.messageId!, count: 1, textLength: pair.ask.length },
	},
	'fixture-manager',
	'fixture-group'
);

describe('scope decision rendered lifecycle and guarded human controls', () => {
	let originalResolve: typeof window.maestro.pianola.resolveDecision;
	afterEach(() => {
		window.maestro.pianola.resolveDecision = originalResolve;
	});
	beforeEach(() => {
		hookMock.usePianolaDashboardData.mockReturnValue({
			data: emptyData(),
			portfolio: emptyPortfolio(),
			decisions: [structuredClone(pendingRecord)],
			refresh,
		});
		originalResolve = window.maestro.pianola.resolveDecision;
		window.maestro.pianola.resolveDecision = vi.fn();
	});

	it.each([
		[
			'mira_processing',
			'manager',
			'Manager processing',
			'Manager',
			'Review the bounded naming question',
		],
		['waiting_human', 'human', 'Waiting for human', 'Human', 'Choose count or total'],
		['agent_running', 'recipient', 'Agent continuing', 'Agent', 'Continue the acknowledged task'],
		['blocked', 'operator', 'Blocked', 'Operator', 'Restore native transcript access'],
		['paused', 'none', 'Paused', 'None', 'Explicitly resume the scope'],
		['done', 'none', 'Done', 'None', 'Completion confirmed in transcript'],
	] as const)(
		'renders %s with its responsible actor and concrete next action',
		(status, nextActor, label, actor, nextAction) => {
			const record = structuredClone(pendingRecord);
			record.lifecycle = { ...record.lifecycle!, status, nextActor, nextAction };
			hookMock.usePianolaDashboardData.mockReturnValue({
				data: emptyData(),
				portfolio: emptyPortfolio(),
				decisions: [record],
				refresh,
			});
			render(<PianolaDashboard theme={theme} onJumpToAgent={vi.fn()} />);
			expect(screen.getByText(new RegExp(label))).toBeInTheDocument();
			expect(screen.getByText(`${actor}: ${nextAction}`)).toBeInTheDocument();
			expect(screen.queryByRole('button', { name: 'Send human answer' }) !== null).toBe(
				status === 'waiting_human'
			);
		}
	);

	it.each(['dry-run', 'acknowledged', 'admitted', 'unknown', 'accepted', 'wrong-actor'] as const)(
		'withholds the answer form for %s evidence',
		(kind) => {
			const record = structuredClone(pendingRecord);
			if (kind === 'dry-run') record.dryRun = true;
			if (kind === 'acknowledged') record.lifecycle!.acknowledgedAt = record.timestamp;
			if (kind === 'wrong-actor') record.lifecycle!.nextActor = 'manager';
			if (['admitted', 'unknown', 'accepted'].includes(kind)) {
				record.lifecycle!.phase = 'answer';
				record.lifecycle!.delivery =
					kind === 'admitted' ? 'intent' : (kind as PianolaDecisionLifecycle['delivery']);
				if (kind === 'admitted') record.deliveryStatus = 'admitted';
			}
			hookMock.usePianolaDashboardData.mockReturnValue({
				data: emptyData(),
				portfolio: emptyPortfolio(),
				decisions: [record],
				refresh,
			});
			render(<PianolaDashboard theme={theme} onJumpToAgent={vi.fn()} />);
			expect(screen.queryByRole('textbox', { name: 'Human answer' })).not.toBeInTheDocument();
		}
	);

	it('sends one trimmed explicit answer without actor spoofing and distinguishes acceptance from acknowledgment', async () => {
		let finish!: (value: { status: 'accepted' }) => void;
		vi.mocked(window.maestro.pianola.resolveDecision).mockReturnValue(
			new Promise((resolve) => {
				finish = resolve;
			})
		);
		render(<PianolaDashboard theme={theme} onJumpToAgent={vi.fn()} />);
		const send = screen.getByRole('button', { name: 'Send human answer' });
		expect(send).toBeDisabled();
		fireEvent.change(screen.getByRole('textbox', { name: 'Human answer' }), {
			target: { value: '  Use count.  ' },
		});
		fireEvent.click(send);
		expect(send).toBeDisabled();
		fireEvent.click(send);
		expect(window.maestro.pianola.resolveDecision).toHaveBeenCalledExactlyOnceWith({
			decisionId: pendingRecord.id,
			answer: 'Use count.',
		});
		await act(async () => {
			finish({ status: 'accepted' });
		});
		expect(screen.getByRole('status')).toHaveTextContent(
			'Answer accepted for delivery; awaiting agent acknowledgment.'
		);
		expect(screen.queryByText(/Agent continuing/)).not.toBeInTheDocument();
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it.each(['rejected', 'error'] as const)(
		'keeps the answer and exposes %s without claiming delivery',
		async (kind) => {
			if (kind === 'error')
				vi.mocked(window.maestro.pianola.resolveDecision).mockRejectedValueOnce(
					new Error('native transport unavailable')
				);
			else
				vi.mocked(window.maestro.pianola.resolveDecision).mockResolvedValueOnce({
					status: 'rejected',
					error: 'pending ask changed',
				});
			render(<PianolaDashboard theme={theme} onJumpToAgent={vi.fn()} />);
			fireEvent.change(screen.getByRole('textbox', { name: 'Human answer' }), {
				target: { value: 'Use count.' },
			});
			fireEvent.click(screen.getByRole('button', { name: 'Send human answer' }));
			await waitFor(() =>
				expect(screen.getByRole('status')).toHaveTextContent(
					kind === 'error' ? 'native transport unavailable' : 'pending ask changed'
				)
			);
			expect(screen.getByRole('textbox', { name: 'Human answer' })).toHaveValue('Use count.');
			expect(screen.getByRole('button', { name: 'Send human answer' })).toBeEnabled();
			expect(refresh).toHaveBeenCalledTimes(1);
		}
	);
	it('allows a human to retry a persisted definitive rejection after refresh', async () => {
		const rejected = structuredClone(pendingRecord);
		rejected.lifecycle = { ...rejected.lifecycle!, phase: 'answer', delivery: 'rejected' };
		rejected.deliveryStatus = 'admitted';
		vi.mocked(window.maestro.pianola.resolveDecision).mockResolvedValueOnce({ status: 'accepted' });
		const view = render(<PianolaDashboard theme={theme} onJumpToAgent={vi.fn()} />);
		hookMock.usePianolaDashboardData.mockReturnValue({
			data: emptyData(),
			portfolio: emptyPortfolio(),
			decisions: [rejected],
			refresh,
		});
		view.rerender(<PianolaDashboard theme={theme} onJumpToAgent={vi.fn()} />);
		fireEvent.change(screen.getByRole('textbox', { name: 'Human answer' }), {
			target: { value: 'Try again' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Send human answer' }));
		await waitFor(() =>
			expect(window.maestro.pianola.resolveDecision).toHaveBeenCalledWith({
				decisionId: rejected.id,
				answer: 'Try again',
			})
		);
		expect(await screen.findByRole('status')).toHaveTextContent('Answer accepted for delivery');
	});

	it('shows the handler message without the Electron IPC wrapper', async () => {
		vi.mocked(window.maestro.pianola.resolveDecision).mockRejectedValueOnce(
			new Error(
				"Error invoking remote method 'pianola:resolveDecision': Error: Pending question changed"
			)
		);
		render(<PianolaDashboard theme={theme} onJumpToAgent={vi.fn()} />);
		fireEvent.change(screen.getByRole('textbox', { name: 'Human answer' }), {
			target: { value: 'Use count' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Send human answer' }));
		await waitFor(() =>
			expect(screen.getByRole('status')).toHaveTextContent('Pending question changed')
		);
		expect(screen.getByRole('status')).not.toHaveTextContent('Error invoking remote method');
		expect(screen.getByRole('textbox', { name: 'Human answer' })).toHaveValue('Use count');
	});
});
