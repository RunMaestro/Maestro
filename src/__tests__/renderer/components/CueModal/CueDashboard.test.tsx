import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CueDashboard } from '../../../../renderer/components/CueModal/CueDashboard';
import type { Theme } from '../../../../renderer/types';

// Stub child components to isolate CueDashboard behavior
vi.mock('../../../../renderer/components/CueModal/SessionsTable', () => ({
	SessionsTable: () => <div data-testid="sessions-table" />,
}));
vi.mock('../../../../renderer/components/CueModal/ActiveRunsList', () => ({
	ActiveRunsList: () => <div data-testid="active-runs" />,
}));
vi.mock('../../../../renderer/components/CueModal/ActivityLog', () => ({
	ActivityLog: () => <div data-testid="activity-log" />,
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
		activeRunsExpanded: true,
		setActiveRunsExpanded: vi.fn(),
		onViewInPipeline: vi.fn(),
		onEditYaml: vi.fn(),
		onRemoveCue: vi.fn(),
		onTriggerSubscription: vi.fn(),
		onStopRun: vi.fn().mockResolvedValue(true),
		onStopAll: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

describe('CueDashboard', () => {
	it('loading=true renders loading indicator', () => {
		render(<CueDashboard {...makeProps({ loading: true })} />);
		expect(screen.getByText(/Loading Cue status/)).toBeInTheDocument();
		expect(screen.queryByTestId('sessions-table')).not.toBeInTheDocument();
	});

	it('renders all three sections when loaded', () => {
		render(<CueDashboard {...makeProps()} />);
		expect(screen.getByTestId('sessions-table')).toBeInTheDocument();
		expect(screen.getByTestId('active-runs')).toBeInTheDocument();
		expect(screen.getByTestId('activity-log')).toBeInTheDocument();
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
});
