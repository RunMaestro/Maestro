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

// The filter registers a modal layer so Escape clears it before closing the Cue
// modal; the layer stack needs a provider this test doesn't mount.
vi.mock('../../../../renderer/hooks/ui/useModalLayer', () => ({
	useModalLayer: vi.fn(),
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

/** Read the Task column of every rendered row, in render order. */
function renderedTaskOrder(): string[] {
	return Array.from(document.querySelectorAll('tbody tr')).map(
		(row) => row.querySelector('td')?.querySelector('span')?.textContent ?? ''
	);
}

describe('ScheduledTasksTab sorting', () => {
	const now = Date.now();
	const alpha = task({
		name: 'alpha-sub',
		label: 'Alpha task',
		agentName: 'Zeta',
		kind: 'daily',
		event: 'time.scheduled',
		scheduleTimes: ['21:00'],
		nextFireAtMs: now + 3_600_000,
	});
	const beta = task({
		name: 'beta-sub',
		label: 'Beta task',
		agentName: 'Alpha',
		kind: 'once',
		event: 'time.once',
		scheduleTimes: undefined,
		fireAt: new Date(now + 60_000).toISOString(),
		nextFireAtMs: now + 60_000,
	});
	// An interval task has no projected next fire: its phase lives in engine run
	// state, not in the YAML.
	const gamma = task({
		name: 'gamma-sub',
		label: 'Gamma task',
		agentName: 'Mid',
		kind: 'interval',
		event: 'time.heartbeat',
		scheduleTimes: undefined,
		intervalMinutes: 30,
		nextFireAtMs: null,
	});

	beforeEach(() => {
		vi.clearAllMocks();
		listScheduledTasks.mockResolvedValue({ tasks: [alpha, beta, gamma], warnings: [] });
	});

	it('defaults to soonest-next-fire, with unprojectable tasks last', async () => {
		render(<ScheduledTasksTab theme={theme} active agents={agents} />);
		await screen.findByText('Beta task');

		expect(renderedTaskOrder()).toEqual(['Beta task', 'Alpha task', 'Gamma task']);
	});

	it('keeps unprojectable tasks last when the Next sort is reversed', async () => {
		render(<ScheduledTasksTab theme={theme} active agents={agents} />);
		await screen.findByText('Beta task');

		// Next is already the active column, so this click flips it to descending.
		fireEvent.click(screen.getByTitle('Sort by time until the next fire'));

		// Farthest-out first, but "no projection" is not "the largest countdown".
		expect(renderedTaskOrder()).toEqual(['Alpha task', 'Beta task', 'Gamma task']);
	});

	it('sorts by agent, and flips direction on a second click of the same column', async () => {
		render(<ScheduledTasksTab theme={theme} active agents={agents} />);
		await screen.findByText('Beta task');

		fireEvent.click(screen.getByTitle('Sort by owning agent'));
		expect(renderedTaskOrder()).toEqual(['Beta task', 'Gamma task', 'Alpha task']);

		fireEvent.click(screen.getByTitle('Sort by owning agent'));
		expect(renderedTaskOrder()).toEqual(['Alpha task', 'Gamma task', 'Beta task']);
	});

	it('sorts Repeats by recurrence, not by the alphabetical label', async () => {
		render(<ScheduledTasksTab theme={theme} active agents={agents} />);
		await screen.findByText('Beta task');

		fireEvent.click(screen.getByTitle('Sort by how the task repeats'));

		// once → daily → interval. Alphabetically the labels would be
		// "At set times", "Interval", "Once", which reads as arbitrary.
		expect(renderedTaskOrder()).toEqual(['Beta task', 'Alpha task', 'Gamma task']);
	});

	it('marks the active column with aria-sort and leaves the rest none', async () => {
		render(<ScheduledTasksTab theme={theme} active agents={agents} />);
		await screen.findByText('Beta task');

		expect(screen.getByTestId('scheduled-tasks-sort-next')).toHaveAttribute(
			'aria-sort',
			'ascending'
		);
		expect(screen.getByTestId('scheduled-tasks-sort-agent')).toHaveAttribute('aria-sort', 'none');

		fireEvent.click(screen.getByTitle('Sort by owning agent'));

		expect(screen.getByTestId('scheduled-tasks-sort-agent')).toHaveAttribute(
			'aria-sort',
			'ascending'
		);
		expect(screen.getByTestId('scheduled-tasks-sort-next')).toHaveAttribute('aria-sort', 'none');
	});
});

describe('ScheduledTasksTab filtering', () => {
	const digest = task({
		name: 'Daily-Digest',
		label: 'Mon-Fri vault digest',
		agentName: 'SANS AI Pentesting',
		pipelineName: 'Daily Digest',
		scheduleTimes: ['18:00'],
		nextFireAtMs: Date.now() + 60_000,
	});
	const sync = task({
		name: 'Pedsidian-Wispr-Sync',
		label: 'Wispr Sync',
		agentName: 'Pedsidian',
		pipelineName: 'Pedsidian',
		action: 'command',
		scheduleTimes: ['09:00'],
		nextFireAtMs: Date.now() + 120_000,
	});

	beforeEach(() => {
		vi.clearAllMocks();
		listScheduledTasks.mockResolvedValue({ tasks: [digest, sync], warnings: [] });
	});

	async function typeFilter(value: string) {
		render(<ScheduledTasksTab theme={theme} active agents={agents} />);
		await screen.findByText('Wispr Sync');
		fireEvent.change(screen.getByTestId('scheduled-tasks-filter-input'), {
			target: { value },
		});
	}

	it('matches on the task label as a fuzzy subsequence', async () => {
		await typeFilter('wspr');

		expect(screen.getByText('Wispr Sync')).toBeInTheDocument();
		expect(screen.queryByText('Mon-Fri vault digest')).not.toBeInTheDocument();
	});

	it('matches on the owning agent', async () => {
		await typeFilter('pentesting');

		expect(screen.getByText('Mon-Fri vault digest')).toBeInTheDocument();
		expect(screen.queryByText('Wispr Sync')).not.toBeInTheDocument();
	});

	it('matches the schedule text as a substring, not as a fuzzy subsequence', async () => {
		await typeFilter('18:00');

		expect(screen.getByText('Mon-Fri vault digest')).toBeInTheDocument();
		expect(screen.queryByText('Wispr Sync')).not.toBeInTheDocument();
	});

	it('does not fuzzy-match the schedule column', async () => {
		// '00d' is a subsequence of "09:00 (every day)" but not a substring.
		// Fuzzy there would match nearly any query built from those characters.
		await typeFilter('00d');

		expect(screen.getByTestId('scheduled-tasks-no-matches')).toBeInTheDocument();
	});

	it('matches on the action so "command" tasks can be isolated', async () => {
		await typeFilter('command');

		expect(screen.getByText('Wispr Sync')).toBeInTheDocument();
		expect(screen.queryByText('Mon-Fri vault digest')).not.toBeInTheDocument();
	});

	it('shows a live count of matches against the full set', async () => {
		await typeFilter('wispr');

		expect(screen.getByTestId('scheduled-tasks-filter-count')).toHaveTextContent('1 of 2');
	});

	it('shows a no-matches message rather than the empty state', async () => {
		await typeFilter('zzzzzz');

		expect(screen.getByTestId('scheduled-tasks-no-matches')).toBeInTheDocument();
		// The empty state means "you have nothing scheduled", which would be a lie.
		expect(screen.queryByText('No scheduled tasks')).not.toBeInTheDocument();
	});

	it('the clear button restores the full list', async () => {
		await typeFilter('wispr');
		expect(screen.queryByText('Mon-Fri vault digest')).not.toBeInTheDocument();

		fireEvent.click(screen.getByTestId('scheduled-tasks-filter-clear'));

		expect(screen.getByText('Mon-Fri vault digest')).toBeInTheDocument();
		expect(screen.queryByTestId('scheduled-tasks-filter-count')).not.toBeInTheDocument();
	});
});
