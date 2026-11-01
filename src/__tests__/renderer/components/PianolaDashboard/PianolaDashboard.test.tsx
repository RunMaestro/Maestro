/**
 * @file PianolaDashboard.test.tsx
 * @description Tests the dashboard component's data mapping: how a DashboardData
 * shape (produced elsewhere by the pure deriveDashboard, tested separately) is
 * rendered into the four status sections, the activity feed's action labels, the
 * click-to-jump wiring, and the empty states. The hook is mocked so the test
 * exercises only the view layer.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { createMockNativeDecisionPair } from '../../../helpers/pianola';
import { startPianolaDecision } from '../../../../shared/pianola/pianola-decision-lifecycle';
import type { PianolaDecisionLifecycle } from '../../../../shared/pianola/storage';
import type { Theme } from '../../../../renderer/types';
import type { DashboardData } from '../../../../renderer/components/PianolaDashboard/usePianolaDashboardData';

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
	hookMock.usePianolaDashboardData.mockReturnValue({
		data: populatedData(),
		decisions: [],
		refresh,
	});
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
		expect(screen.getByText('Watched by Pianola')).toBeInTheDocument();
		expect(screen.queryByText('Agent 0')).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: '+ Add selection' })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Show agents' }));
		expect(screen.getByText('Agent 0')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Hide agents' }));
		expect(screen.queryByText('Agent 0')).not.toBeInTheDocument();
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
		expect(screen.getByRole('status')).toHaveTextContent('2 failing');
	});

	it('offers the automatic watch setting in the dashboard', () => {
		const setAutoWatchNewAgents = vi.fn();
		supervisorMock.usePianolaSupervisor.mockReturnValue({
			...supervisorMock.usePianolaSupervisor(),
			setAutoWatchNewAgents,
		});
		render(<PianolaDashboard theme={theme} onJumpToAgent={vi.fn()} />);
		fireEvent.click(screen.getByRole('checkbox', { name: 'Automatically watch new agents' }));
		expect(setAutoWatchNewAgents).toHaveBeenCalledWith(true);
	});
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
			hookMock.usePianolaDashboardData.mockReturnValue({ data, decisions: [], refresh });
			const onJump = vi.fn();
			render(<PianolaDashboard theme={theme} onJumpToAgent={onJump} />);

			fireEvent.click(screen.getByText('Working task'));

			expect(onJump).toHaveBeenCalledWith('busy-agent', 'busy-tab');
		}
	);

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
		hookMock.usePianolaDashboardData.mockReturnValue({ data: emptyData(), decisions: [], refresh });
		render(<PianolaDashboard theme={theme} onJumpToAgent={vi.fn()} />);

		expect(screen.getByText('No agents are waiting on you.')).toBeInTheDocument();
		expect(screen.getByText('No agents are working right now.')).toBeInTheDocument();
		expect(screen.getByText('Nothing finished recently.')).toBeInTheDocument();
		expect(screen.getByText('No decisions recorded yet.')).toBeInTheDocument();
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
