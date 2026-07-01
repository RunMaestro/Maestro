/**
 * @file AgentRunDashboardModal.test.tsx
 * @description Behavioral tests for the Agent Run dashboard modal. The real
 * AgentRun hook/service stack is exercised against the global preload mock so
 * these tests defend the user-visible modal contract rather than component
 * internals.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { AgentRun, AgentRunEvent } from '../../../../shared/agent-run';
import type { Campaign } from '../../../../shared/campaign';
import type { Theme } from '../../../../renderer/types';
import { AgentRunDashboardModal } from '../../../../renderer/components/AgentRunDashboard/AgentRunDashboardModal';

vi.mock('../../../../renderer/hooks/ui/useModalLayer', () => ({
	useModalLayer: vi.fn(),
}));

const theme = {
	colors: {
		bgMain: '#1a1a2e',
		bgSidebar: '#16213e',
		bgActivity: '#0f3460',
		textMain: '#e8e8e8',
		textDim: '#888888',
		accent: '#7b2cbf',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
		border: '#333355',
	},
} as unknown as Theme;

const baseRun: AgentRun = {
	id: 'run-alpha',
	createdAt: 1_704_067_200_000,
	updatedAt: 1_704_067_260_000,
	provider: 'claude-code',
	agentName: 'Alpha Engineer',
	cwd: '/repo/maestro',
	branch: 'agent-run-dashboard',
	prompt: 'Implement parser dashboard',
	status: 'completed',
	artifacts: [{ name: 'summary.md', path: '/repo/maestro/summary.md', kind: 'markdown' }],
	touchedFiles: ['src/parser.ts', 'src/parser.test.ts'],
	checks: [{ name: 'focused vitest', status: 'passed', summary: '12 tests passed' }],
	reviews: [
		{
			severity: 'medium',
			category: 'correctness',
			message: 'Review parser error mapping',
			status: 'open',
		},
	],
};

const secondRun: AgentRun = {
	id: 'run-beta',
	createdAt: 1_704_067_300_000,
	updatedAt: 1_704_067_360_000,
	provider: 'codex',
	agentName: 'Beta Reviewer',
	prompt: 'Review telemetry migration',
	status: 'running',
	artifacts: [],
	touchedFiles: ['src/telemetry.ts'],
	checks: [],
	reviews: [],
};

const taskRun: AgentRun = {
	id: 'pianola:launch-plan:task-collect',
	createdAt: 1_704_067_400_000,
	updatedAt: 1_704_067_460_000,
	provider: 'claude-code',
	agentName: 'Collector Agent',
	prompt: 'Collect launch telemetry schema',
	status: 'waiting',
	source: 'pianola:launch-plan',
	metadata: { pianola: { planId: 'launch-plan', taskId: 'task-collect' } },
	artifacts: [],
	touchedFiles: ['docs/telemetry.md'],
	checks: [],
	reviews: [],
};

const runEvents: AgentRunEvent[] = [
	{
		id: 'evt-run-alpha-started',
		runId: 'run-alpha',
		timestamp: 1_704_067_205_000,
		type: 'status',
		status: 'running',
		message: 'Run started',
	},
	{
		id: 'evt-run-alpha-checks',
		runId: 'run-alpha',
		timestamp: 1_704_067_250_000,
		type: 'check',
		message: 'Focused vitest passed',
	},
];

const taskRunEvents: AgentRunEvent[] = [
	{
		id: 'evt-task-collect-waiting',
		runId: 'pianola:launch-plan:task-collect',
		timestamp: 1_704_067_430_000,
		type: 'status',
		status: 'waiting',
		message: 'Waiting for schema approval',
	},
];

const manualCampaign: Campaign = {
	id: 'campaign-manual',
	title: 'Manual reliability sweep',
	createdAt: 1_704_067_000_000,
	updatedAt: 1_704_067_100_000,
	status: 'running',
	objective: 'Harden renderer flows before release',
	runIds: ['run-alpha', 'run-beta'],
	tasks: [],
};

const pianolaCampaign: Campaign = {
	id: 'pianola:launch-plan',
	title: 'Launch telemetry migration',
	createdAt: 1_704_066_000_000,
	updatedAt: 1_704_066_000_000,
	status: 'running',
	objective: 'Pianola coordinates the launch telemetry migration',
	runIds: ['pianola:launch-plan:task-collect', 'pianola:launch-plan:task-review'],
	tasks: [
		{
			id: 'task-collect',
			title: 'Collect launch telemetry schema',
			status: 'waiting',
			runId: 'pianola:launch-plan:task-collect',
			dependsOn: [],
			agentType: 'engineer',
			metadata: { pianola: { status: 'waiting_input', agentId: 'collector-agent' } },
		},
		{
			id: 'task-review',
			title: 'Review launch dashboard copy',
			status: 'queued',
			runId: 'pianola:launch-plan:task-review',
			dependsOn: ['task-collect'],
			agentType: 'reviewer',
			metadata: { pianola: { status: 'idle' } },
		},
	],
	source: {
		adapter: 'pianola',
		planId: 'launch-plan',
		filename: 'maestro-pianola-plans.json',
	},
	metadata: { pianola: { planId: 'launch-plan' } },
};

type AgentRunApiMock = {
	list: Mock;
	show: Mock;
	events: Mock;
	campaigns: {
		list: Mock;
		show: Mock;
	};
};

function agentRunApi(): AgentRunApiMock {
	return window.maestro.agentRun as unknown as AgentRunApiMock;
}

function renderModal(): void {
	render(<AgentRunDashboardModal isOpen={true} onClose={vi.fn()} theme={theme} />);
}

function mockDefaultAgentRunApi(): void {
	const api = agentRunApi();
	api.list.mockResolvedValue({ success: true, runs: [baseRun, secondRun] });
	api.show.mockImplementation((runId: string) => {
		const run = [baseRun, secondRun, taskRun].find((candidate) => candidate.id === runId) ?? null;
		return Promise.resolve({ success: true, run });
	});
	api.events.mockImplementation((runId: string) => {
		const events = runId === taskRun.id ? taskRunEvents : runId === baseRun.id ? runEvents : [];
		return Promise.resolve({ success: true, events });
	});
	api.campaigns.list.mockResolvedValue({
		success: true,
		campaigns: [manualCampaign, pianolaCampaign],
	});
	api.campaigns.show.mockImplementation((campaignId: string) => {
		const campaign =
			[manualCampaign, pianolaCampaign].find((candidate) => candidate.id === campaignId) ?? null;
		return Promise.resolve({ success: true, campaign });
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mockDefaultAgentRunApi();
});

describe('AgentRunDashboardModal', () => {
	it('shows empty run and campaign states when the service has no records', async () => {
		agentRunApi().list.mockResolvedValue({ success: true, runs: [] });
		agentRunApi().campaigns.list.mockResolvedValue({ success: true, campaigns: [] });

		renderModal();

		expect(await screen.findByText('No agent runs yet.')).toBeInTheDocument();
		expect(screen.getByText('No campaigns yet.')).toBeInTheDocument();
	});

	it('renders agent runs with their user-facing identity and status', async () => {
		renderModal();
		await screen.findByText('Implement parser dashboard');

		const completedRunButton = screen.getByRole('button', { name: /Implement parser dashboard/i });
		const runningRunButton = screen.getByRole('button', { name: /Review telemetry migration/i });
		expect(within(completedRunButton).getByText('Alpha Engineer')).toBeInTheDocument();
		expect(within(completedRunButton).getByText('completed')).toBeInTheDocument();
		expect(within(runningRunButton).getByText('Beta Reviewer')).toBeInTheDocument();
		expect(within(runningRunButton).getByText('running')).toBeInTheDocument();
	});

	it('renders campaigns and marks Pianola-managed campaigns with a Pianola badge', async () => {
		renderModal();

		expect(await screen.findByText('Manual reliability sweep')).toBeInTheDocument();
		const pianolaCampaignButton = screen.getByRole('button', {
			name: /Launch telemetry migration/i,
		});
		expect(within(pianolaCampaignButton).getByText('Pianola')).toBeInTheDocument();
		expect(within(pianolaCampaignButton).getByText('running')).toBeInTheDocument();
	});

	it('selects a run and shows its detail summary with the event timeline', async () => {
		renderModal();
		fireEvent.click(await screen.findByText('Implement parser dashboard'));

		await waitFor(() => {
			expect(agentRunApi().show).toHaveBeenCalledWith('run-alpha');
			expect(agentRunApi().events).toHaveBeenCalledWith('run-alpha');
		});
		expect(await screen.findByText('src/parser.ts')).toBeInTheDocument();
		expect(screen.getByText('src/parser.test.ts')).toBeInTheDocument();
		expect(screen.getByText('Focused vitest passed')).toBeInTheDocument();
		expect(screen.getByText('Review parser error mapping')).toBeInTheDocument();
		expect(screen.getByText('Run started')).toBeInTheDocument();
	});

	it('selects a campaign, renders its task list, and opens a task run from that task', async () => {
		renderModal();
		fireEvent.click(await screen.findByText('Launch telemetry migration'));

		await waitFor(() => {
			expect(agentRunApi().campaigns.show).toHaveBeenCalledWith('pianola:launch-plan');
		});
		expect(await screen.findByText('Collect launch telemetry schema')).toBeInTheDocument();
		expect(screen.getByText('Review launch dashboard copy')).toBeInTheDocument();
		expect(screen.getByText('waiting')).toBeInTheDocument();
		expect(screen.getByText('queued')).toBeInTheDocument();

		fireEvent.click(screen.getByText('Collect launch telemetry schema'));

		await waitFor(() => {
			expect(agentRunApi().show).toHaveBeenCalledWith('pianola:launch-plan:task-collect');
			expect(agentRunApi().events).toHaveBeenCalledWith('pianola:launch-plan:task-collect');
		});
		expect(await screen.findByText('Collector Agent')).toBeInTheDocument();
		expect(screen.getByText('Waiting for schema approval')).toBeInTheDocument();
	});

	it('reloads both runs and campaigns from the manual refresh control', async () => {
		renderModal();
		await waitFor(() => {
			expect(agentRunApi().list).toHaveBeenCalledTimes(1);
			expect(agentRunApi().campaigns.list).toHaveBeenCalledTimes(1);
		});

		vi.clearAllMocks();
		mockDefaultAgentRunApi();
		fireEvent.click(screen.getByRole('button', { name: /refresh/i }));

		await waitFor(() => {
			expect(agentRunApi().list).toHaveBeenCalledTimes(1);
			expect(agentRunApi().campaigns.list).toHaveBeenCalledTimes(1);
		});
	});

	it('surfaces service errors from the hook instead of hiding failed loads', async () => {
		agentRunApi().list.mockResolvedValue({ success: false, error: 'Agent run store offline' });
		agentRunApi().campaigns.list.mockResolvedValue({
			success: false,
			error: 'Agent run store offline',
		});

		renderModal();

		expect(await screen.findByText('Agent run store offline')).toBeInTheDocument();
	});
});
