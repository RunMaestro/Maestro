/**
 * Tests for the Cue modal's Scheduled Tasks tab: listing, pause/resume,
 * cancel-with-confirmation, and the create form's write path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Theme } from '../../../../renderer/types';
import type { ScheduledTask } from '../../../../shared/cue/scheduled-tasks';

const listScheduledTasks = vi.fn();
const createScheduledTask = vi.fn();
const updateScheduledTask = vi.fn();
const cancelScheduledTask = vi.fn();

vi.mock('../../../../renderer/services/cue', () => ({
	cueService: {
		listScheduledTasks: () => listScheduledTasks(),
		createScheduledTask: (input: unknown) => createScheduledTask(input),
		updateScheduledTask: (root: string, name: string, patch: unknown) =>
			updateScheduledTask(root, name, patch),
		cancelScheduledTask: (root: string, name: string) => cancelScheduledTask(root, name),
	},
}));

const showConfirmation = vi.fn();
vi.mock('../../../../renderer/stores/modalStore', () => ({
	getModalActions: () => ({ showConfirmation }),
}));

vi.mock('../../../../renderer/stores/notificationStore', () => ({
	notifyToast: vi.fn(),
}));

import { ScheduledTasksTab } from '../../../../renderer/components/CueModal/ScheduledTasksTab';

const theme = {
	colors: {
		border: '#333',
		textMain: '#fff',
		textDim: '#888',
		bgActivity: '#111',
		bgMain: '#222',
		accent: '#06b6d4',
		error: '#ff0000',
		warning: '#ffaa00',
	},
} as unknown as Theme;

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
	return {
		name: 'nightly-summary',
		kind: 'daily',
		event: 'time.scheduled',
		enabled: true,
		agentId: 'agent-alpha',
		agentName: 'Alpha',
		projectRoot: '/p/alpha',
		action: 'prompt',
		label: 'Nightly summary',
		prompt: 'summarize',
		pipelineName: 'Tasks',
		scheduleTimes: ['21:00'],
		nextFireAtMs: Date.now() + 3_600_000,
		...overrides,
	};
}

const agents = [{ id: 'agent-alpha', name: 'Alpha' }];

describe('ScheduledTasksTab', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		listScheduledTasks.mockResolvedValue({ tasks: [task()], warnings: [] });
		updateScheduledTask.mockResolvedValue({ updated: true });
		cancelScheduledTask.mockResolvedValue({ removed: true });
		createScheduledTask.mockResolvedValue({ names: ['task-x'] });
	});

	it('lists tasks with their schedule, owning agent, and countdown', async () => {
		render(<ScheduledTasksTab theme={theme} active agents={agents} />);

		expect(await screen.findByText('Nightly summary')).toBeInTheDocument();
		// The pipeline is shown beside the name: this list mixes standalone
		// reminders with pipeline schedule triggers, and cancelling one of those
		// breaks the pipeline.
		expect(screen.getByText(/nightly-summary · Tasks/)).toBeInTheDocument();
		expect(screen.getByText('21:00 (every day)')).toBeInTheDocument();
		expect(screen.getByText('Alpha')).toBeInTheDocument();
		expect(screen.getByText(/^in /)).toBeInTheDocument();
	});

	it('shows the empty state when nothing is scheduled', async () => {
		listScheduledTasks.mockResolvedValue({ tasks: [], warnings: [] });
		render(<ScheduledTasksTab theme={theme} active agents={agents} />);

		expect(await screen.findByText('No scheduled tasks')).toBeInTheDocument();
	});

	it('surfaces a config warning without hiding the rest of the list', async () => {
		listScheduledTasks.mockResolvedValue({ tasks: [task()], warnings: ['bad yaml for Beta'] });
		render(<ScheduledTasksTab theme={theme} active agents={agents} />);

		expect(await screen.findByText('bad yaml for Beta')).toBeInTheDocument();
		expect(screen.getByText('Nightly summary')).toBeInTheDocument();
	});

	it('pause writes enabled:false through the update path', async () => {
		render(<ScheduledTasksTab theme={theme} active agents={agents} />);
		fireEvent.click(await screen.findByLabelText('Pause this task'));

		await waitFor(() =>
			expect(updateScheduledTask).toHaveBeenCalledWith('/p/alpha', 'nightly-summary', {
				enabled: false,
			})
		);
	});

	it('resume is offered for a paused task', async () => {
		listScheduledTasks.mockResolvedValue({ tasks: [task({ enabled: false })], warnings: [] });
		render(<ScheduledTasksTab theme={theme} active agents={agents} />);

		fireEvent.click(await screen.findByLabelText('Resume this task'));
		await waitFor(() =>
			expect(updateScheduledTask).toHaveBeenCalledWith('/p/alpha', 'nightly-summary', {
				enabled: true,
			})
		);
	});

	it('cancel asks for confirmation first and only deletes when confirmed', async () => {
		render(<ScheduledTasksTab theme={theme} active agents={agents} />);
		fireEvent.click(await screen.findByLabelText('Cancel this task'));

		expect(cancelScheduledTask).not.toHaveBeenCalled();
		expect(showConfirmation).toHaveBeenCalledWith(
			expect.stringContaining('nightly-summary'),
			expect.any(Function)
		);

		// Run the confirm callback the modal would have run.
		showConfirmation.mock.calls[0][1]();
		await waitFor(() =>
			expect(cancelScheduledTask).toHaveBeenCalledWith('/p/alpha', 'nightly-summary')
		);
	});

	it('the New Task form creates a one-shot task for the selected agent', async () => {
		render(<ScheduledTasksTab theme={theme} active agents={agents} defaultAgentId="agent-alpha" />);
		fireEvent.click(await screen.findByText('New Task'));

		fireEvent.change(screen.getByPlaceholderText(/Summarize what landed/), {
			target: { value: 'ship the release' },
		});
		fireEvent.click(screen.getByText('Schedule task'));

		await waitFor(() => expect(createScheduledTask).toHaveBeenCalledTimes(1));
		const input = createScheduledTask.mock.calls[0][0];
		expect(input.agentId).toBe('agent-alpha');
		expect(input.kind).toBe('once');
		expect(input.prompt).toBe('ship the release');
		expect(input.fireAt).toMatch(/Z$/);
	});

	it('the form refuses to submit a task with no prompt and no notification', async () => {
		render(<ScheduledTasksTab theme={theme} active agents={agents} />);
		fireEvent.click(await screen.findByText('New Task'));

		expect(screen.getByText('Add a prompt, a notification, or both.')).toBeInTheDocument();
		expect(screen.getByText('Schedule task').closest('button')).toBeDisabled();
	});

	it('does not fetch while the tab is inactive', () => {
		render(<ScheduledTasksTab theme={theme} active={false} agents={agents} />);
		expect(listScheduledTasks).not.toHaveBeenCalled();
	});
});
