import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LongestAutoRunsTable } from '../../../../renderer/components/UsageDashboard/LongestAutoRunsTable';
import { DEFAULT_AUTORUN_ANALYTICS_FILTERS } from '../../../../renderer/components/UsageDashboard/autoRunFilters';
import { THEMES } from '../../../../shared/themes';

const theme = THEMES.dracula;

const mockStatsApi = {
	getAutoRunSessions: vi.fn(),
	onStatsUpdate: vi.fn(() => () => {}),
};

const mockSessions = [
	{
		id: 'run-1',
		sessionId: 'session-1',
		agentType: 'codex',
		documentPath: '/repo/Auto Run Docs/phase-1.md',
		startTime: Date.now() - 100000,
		duration: 40000,
		tasksTotal: 4,
		tasksCompleted: 4,
		projectPath: '/repo',
		playbookName: 'Regression Sweep',
		promptProfile: 'compact-code',
		agentStrategy: 'plan-execute-verify',
		worktreeMode: 'create-new',
		schedulerMode: 'dag',
	},
	{
		id: 'run-2',
		sessionId: 'session-2',
		agentType: 'claude-code',
		documentPath: '/repo/Auto Run Docs/phase-2.md',
		startTime: Date.now() - 200000,
		duration: 30000,
		tasksTotal: 2,
		tasksCompleted: 2,
		projectPath: '/repo',
		playbookName: 'Docs Sweep',
		promptProfile: 'compact-doc',
		agentStrategy: 'single',
		worktreeMode: 'disabled',
		schedulerMode: 'sequential',
	},
];

describe('LongestAutoRunsTable', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(window as any).maestro = {
			stats: mockStatsApi,
		};
		mockStatsApi.getAutoRunSessions.mockResolvedValue(mockSessions);
	});

	it('renders filter controls and table rows', async () => {
		render(<LongestAutoRunsTable timeRange="week" theme={theme} />);

		await waitFor(() => {
			expect(screen.getByText('Top 2 Longest Auto Runs')).toBeInTheDocument();
			expect(screen.getByLabelText('Playbook')).toBeInTheDocument();
		});

		const table = within(screen.getByRole('table'));
		expect(table.getByText('Regression Sweep')).toBeInTheDocument();
		expect(table.getByText('Docs Sweep')).toBeInTheDocument();
	});

	it('filters rows by playbook', async () => {
		render(<LongestAutoRunsTable timeRange="week" theme={theme} />);

		await waitFor(() => {
			expect(screen.getByLabelText('Playbook')).toBeInTheDocument();
		});

		fireEvent.change(screen.getByLabelText('Playbook'), {
			target: { value: 'Regression Sweep' },
		});

		const table = within(screen.getByRole('table'));
		expect(table.getByText('Regression Sweep')).toBeInTheDocument();
		expect(table.queryByText('Docs Sweep')).not.toBeInTheDocument();
	});

	it('shows empty filtered state when filters exclude all sessions', async () => {
		render(<LongestAutoRunsTable timeRange="week" theme={theme} />);

		await waitFor(() => {
			expect(screen.getByLabelText('Playbook')).toBeInTheDocument();
			expect(screen.getByLabelText('Scheduler')).toBeInTheDocument();
		});

		fireEvent.change(screen.getByLabelText('Playbook'), {
			target: { value: 'Regression Sweep' },
		});
		fireEvent.change(screen.getByLabelText('Scheduler'), {
			target: { value: 'sequential' },
		});

		expect(screen.getByText('No Auto Run sessions match the current filters.')).toBeInTheDocument();
	});

	it('applies controlled filters from the parent dashboard state', async () => {
		const onFiltersChange = vi.fn();
		render(
			<LongestAutoRunsTable
				timeRange="week"
				theme={theme}
				filters={{
					...DEFAULT_AUTORUN_ANALYTICS_FILTERS,
					playbookName: 'Regression Sweep',
				}}
				onFiltersChange={onFiltersChange}
			/>
		);

		await waitFor(() => {
			expect(screen.getByDisplayValue('Regression Sweep')).toBeInTheDocument();
		});

		const table = within(screen.getByRole('table'));
		expect(table.getByText('Regression Sweep')).toBeInTheDocument();
		expect(table.queryByText('Docs Sweep')).not.toBeInTheDocument();
	});
});
