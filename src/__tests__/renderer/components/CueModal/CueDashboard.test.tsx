import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CueDashboard } from '../../../../renderer/components/CueModal/CueDashboard';
import type { Theme } from '../../../../renderer/types';

// Stub child components to isolate CueDashboard behavior
const sessionsTableSpy = vi.fn();
vi.mock('../../../../renderer/components/CueModal/SessionsTable', () => ({
	SessionsTable: (props: Record<string, unknown>) => {
		sessionsTableSpy(props);
		return <div data-testid="sessions-table" />;
	},
}));
vi.mock('../../../../renderer/components/CueModal/ActiveRunsList', () => ({
	ActiveRunsList: () => <div data-testid="active-runs" />,
}));
const statsSpy = vi.fn();
vi.mock('../../../../renderer/components/CueModal/CueDashboardStats', () => ({
	CueDashboardStats: (props: Record<string, unknown>) => {
		statsSpy(props);
		return <div data-testid="cue-dashboard-stats" />;
	},
}));

const theme = {
	colors: {
		border: '#333',
		textMain: '#fff',
		textDim: '#888',
		bgActivity: '#111',
		bgMain: '#222',
		accent: '#06b6d4',
		error: '#ff0000',
	},
} as unknown as Theme;

function makeProps(
	overrides: Partial<React.ComponentProps<typeof CueDashboard>> = {}
): React.ComponentProps<typeof CueDashboard> {
	return {
		theme,
		loading: false,
		error: null,
		graphError: null,
		onRetry: vi.fn(),
		sessions: [],
		activeRuns: [],
		activityLog: [],
		queueStatus: {},
		graphSessions: [],
		dashboardPipelines: [],
		subscriptionPipelineMap: new Map(),
		executionCount: 0,
		activeRunsExpanded: true,
		setActiveRunsExpanded: vi.fn(),
		onViewInGraph: vi.fn(),
		onEditYaml: vi.fn(),
		onRemoveCue: vi.fn(),
		onTriggerSubscription: vi.fn(),
		onStopRun: vi.fn().mockResolvedValue(true),
		onStopAll: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

describe('CueDashboard', () => {
	beforeEach(() => {
		statsSpy.mockClear();
		sessionsTableSpy.mockClear();
	});

	// Right-clicking one agent opens a table of every Cue-enabled agent, so the
	// id has to reach the table for the asked-for row to be marked.
	describe('focused agent', () => {
		function warned(id: string, name: string) {
			return {
				sessionId: id,
				sessionName: name,
				toolType: 'claude-code',
				projectRoot: '/shared',
				enabled: true,
				subscriptionCount: 0,
				activeRuns: 0,
				ownershipWarning: 'A sibling agent owns this cue.yaml',
			};
		}
		function plain(id: string, name: string) {
			return {
				sessionId: id,
				sessionName: name,
				toolType: 'claude-code',
				projectRoot: '/shared',
				enabled: true,
				subscriptionCount: 2,
				activeRuns: 0,
			};
		}

		it('passes the focused agent down to the table', () => {
			render(
				<CueDashboard
					{...makeProps({ sessions: [plain('s1', 'A'), plain('s2', 'B')], focusSessionId: 's2' })}
				/>
			);

			expect(sessionsTableSpy).toHaveBeenLastCalledWith(
				expect.objectContaining({ focusSessionId: 's2' })
			);
		});

		// Ownership-warning rows are hidden behind the "Show N flagged" toggle by
		// default. Highlighting one without revealing it scrolls to a row that was
		// never rendered.
		it('reveals flagged rows when the focused agent is one of them', () => {
			render(
				<CueDashboard
					{...makeProps({
						sessions: [plain('s1', 'Owner'), warned('s2', 'Sibling')],
						focusSessionId: 's2',
					})}
				/>
			);

			const passed = sessionsTableSpy.mock.calls.at(-1)?.[0] as {
				sessions: Array<{ sessionId: string }>;
			};
			expect(passed.sessions.map((s) => s.sessionId)).toContain('s2');
		});

		it('leaves flagged rows hidden when the focused agent is not flagged', () => {
			render(
				<CueDashboard
					{...makeProps({
						sessions: [plain('s1', 'Owner'), warned('s2', 'Sibling')],
						focusSessionId: 's1',
					})}
				/>
			);

			const passed = sessionsTableSpy.mock.calls.at(-1)?.[0] as {
				sessions: Array<{ sessionId: string }>;
			};
			expect(passed.sessions.map((s) => s.sessionId)).toEqual(['s1']);
		});

		// Hotkey / command palette / Settings open with no agent in hand.
		it('is unchanged for the global entry points', () => {
			render(
				<CueDashboard
					{...makeProps({ sessions: [plain('s1', 'Owner'), warned('s2', 'Sibling')] })}
				/>
			);

			const passed = sessionsTableSpy.mock.calls.at(-1)?.[0] as {
				sessions: Array<{ sessionId: string }>;
				focusSessionId?: string;
			};
			expect(passed.focusSessionId).toBeUndefined();
			expect(passed.sessions.map((s) => s.sessionId)).toEqual(['s1']);
		});
	});

	it('loading=true renders loading indicator', () => {
		render(<CueDashboard {...makeProps({ loading: true })} />);
		expect(screen.getByText(/Loading Cue status/)).toBeInTheDocument();
		expect(screen.queryByTestId('sessions-table')).not.toBeInTheDocument();
	});

	it('renders all three sections when loaded', () => {
		render(<CueDashboard {...makeProps()} />);
		expect(screen.getByTestId('cue-dashboard-stats')).toBeInTheDocument();
		expect(screen.getByTestId('sessions-table')).toBeInTheDocument();
		expect(screen.getByTestId('active-runs')).toBeInTheDocument();
	});

	it('error prop → error banner rendered with message', () => {
		render(<CueDashboard {...makeProps({ error: 'Cue engine unreachable' })} />);
		expect(screen.getByText('Cue engine unreachable')).toBeInTheDocument();
	});

	it('graphError rendered when error is null', () => {
		render(<CueDashboard {...makeProps({ graphError: 'graph fetch failed' })} />);
		expect(screen.getByText('graph fetch failed')).toBeInTheDocument();
	});

	it('retry button fires onRetry', () => {
		const props = makeProps({ error: 'oh no' });
		render(<CueDashboard {...props} />);
		fireEvent.click(screen.getByText('Retry'));
		expect(props.onRetry).toHaveBeenCalled();
	});

	it('activeRunsExpanded=false hides ActiveRunsList', () => {
		render(<CueDashboard {...makeProps({ activeRunsExpanded: false })} />);
		expect(screen.queryByTestId('active-runs')).not.toBeInTheDocument();
	});

	it('clicking Active Runs header toggles expansion', () => {
		const props = makeProps({ activeRunsExpanded: true });
		render(<CueDashboard {...props} />);
		fireEvent.click(screen.getByText('Active Runs'));
		expect(props.setActiveRunsExpanded).toHaveBeenCalledWith(false);
	});

	it('shows active runs count badge when runs present', () => {
		const runs = [{ runId: 'r1' } as any, { runId: 'r2' } as any];
		render(<CueDashboard {...makeProps({ activeRuns: runs })} />);
		expect(screen.getByText('2')).toBeInTheDocument();
	});

	it('passes null averageRuntimeMs when activity log is empty', () => {
		render(<CueDashboard {...makeProps()} />);
		expect(statsSpy).toHaveBeenCalled();
		expect(statsSpy.mock.calls[0]![0].averageRuntimeMs).toBeNull();
	});

	it('averages durationMs across finished runs, ignoring still-running entries', () => {
		const log = [
			{ status: 'completed', durationMs: 1000 },
			{ status: 'failed', durationMs: 2000 },
			{ status: 'timeout', durationMs: 3000 },
			{ status: 'running', durationMs: 0 },
		] as any[];
		render(<CueDashboard {...makeProps({ activityLog: log })} />);
		expect(statsSpy.mock.calls[0]![0].averageRuntimeMs).toBe(2000);
	});

	it('returns null when every activity log entry is still running', () => {
		const log = [
			{ status: 'running', durationMs: 0 },
			{ status: 'running', durationMs: 0 },
		] as any[];
		render(<CueDashboard {...makeProps({ activityLog: log })} />);
		expect(statsSpy.mock.calls[0]![0].averageRuntimeMs).toBeNull();
	});
});
