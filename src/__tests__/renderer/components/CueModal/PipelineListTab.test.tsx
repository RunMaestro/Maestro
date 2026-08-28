/**
 * Tests for PipelineListTab - the Cue Pipeline List tab.
 *
 * Covers what the list promises the user: a prose description of each
 * pipeline, a health badge, search + filter + sort, and the two row actions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { PipelineListTab } from '../../../../renderer/components/CueModal/PipelineListTab';

const mockRenamePipeline = vi.hoisted(() => vi.fn());
vi.mock('../../../../renderer/services/cue', () => ({
	cueService: { renamePipeline: mockRenamePipeline },
}));
const mockNotifyToast = vi.hoisted(() => vi.fn());
vi.mock('../../../../renderer/stores/notificationStore', () => ({
	notifyToast: mockNotifyToast,
}));
import type { Theme } from '../../../../renderer/types';
import type { CuePipeline, PipelineNode } from '../../../../shared/cue-pipeline-types';
import type { CueRunResult } from '../../../../shared/cue/contracts';

const theme = {
	colors: {
		border: '#333',
		textMain: '#fff',
		textDim: '#888',
		bgActivity: '#111',
		bgMain: '#222',
		accent: '#06b6d4',
		error: '#ff0000',
		warning: '#eab308',
		success: '#22c55e',
	},
} as unknown as Theme;

function trigger(id: string, subscriptionName: string, extras: Record<string, unknown> = {}) {
	return {
		id,
		type: 'trigger',
		position: { x: 0, y: 0 },
		data: {
			eventType: 'time.scheduled',
			label: 'Scheduled',
			config: { schedule_times: ['09:00'] },
			subscriptionName,
			...extras,
		},
	} as PipelineNode;
}

function agent(id: string, sessionName: string) {
	return {
		id,
		type: 'agent',
		position: { x: 0, y: 0 },
		// inputPrompt is what keeps the fixture VALID - validatePipelines flags a
		// trigger-fed agent with no prompt, which would mask every other status.
		data: {
			sessionId: `${sessionName}-id`,
			sessionName,
			toolType: 'claude-code',
			inputPrompt: 'go',
		},
	} as PipelineNode;
}

function makePipeline(name: string, id = name, color = '#06b6d4'): CuePipeline {
	return {
		id,
		name,
		color,
		nodes: [trigger(`${id}-t`, name), agent(`${id}-a`, 'rc')],
		edges: [{ id: `${id}-e`, source: `${id}-t`, target: `${id}-a`, mode: 'pass' }],
	};
}

function makeRun(overrides: Partial<CueRunResult> = {}): CueRunResult {
	return {
		runId: 'r1',
		sessionId: 's1',
		sessionName: 'rc',
		subscriptionName: 'Daily Digest',
		event: { type: 'time.scheduled', payload: {} },
		status: 'completed',
		stdout: '',
		stderr: '',
		exitCode: 0,
		durationMs: 12_000,
		startedAt: '2026-08-20T09:00:00.000Z',
		endedAt: '2026-08-20T09:00:12.000Z',
		...overrides,
	} as CueRunResult;
}

function makeMultiTrigger(): CuePipeline {
	return {
		id: 'multi',
		name: 'Multi',
		color: '#06b6d4',
		nodes: [
			trigger('t1', 'Multi'),
			trigger('t2', 'Multi-chain-2', { eventType: 'app.startup', config: {} }),
			agent('a1', 'rc'),
		],
		edges: [
			{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' },
			{ id: 'e2', source: 't2', target: 'a1', mode: 'pass' },
		],
	};
}

const onViewInGraph = vi.fn();
const onTriggerSubscription = vi.fn();
const onRetry = vi.fn();
const onRenamed = vi.fn();

function renderList(overrides: Partial<React.ComponentProps<typeof PipelineListTab>> = {}) {
	return render(
		<PipelineListTab
			theme={theme}
			pipelines={[makePipeline('Daily Digest')]}
			graphSessions={[]}
			activeRuns={[]}
			activityLog={[]}
			loading={false}
			error={null}
			onRetry={onRetry}
			onViewInGraph={onViewInGraph}
			onTriggerSubscription={onTriggerSubscription}
			onRenamed={onRenamed}
			{...overrides}
		/>
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mockRenamePipeline.mockResolvedValue({
		renamed: true,
		subscriptionsUpdated: 2,
		filesWritten: ['/p/.maestro/cue.yaml'],
		warnings: [],
	});
});

describe('PipelineListTab', () => {
	it('describes each pipeline in prose, not just by name', () => {
		renderList();
		expect(screen.getByText('Daily Digest')).toBeInTheDocument();
		expect(screen.getByText('Scheduled (09:00) → rc')).toBeInTheDocument();
	});

	// A pipeline that groups dozens of independent chains must not print all of
	// their names inline - that is what drowned the other rows on screen.
	it('summarizes a wide pipeline with counts instead of every node name', () => {
		const nodes = [trigger('t1', 'Wide')];
		const edges = [];
		for (let i = 0; i < 8; i++) {
			nodes.push(agent(`a${i}`, `Agent${i}`));
			edges.push({ id: `e${i}`, source: 't1', target: `a${i}`, mode: 'pass' as const });
		}
		renderList({ pipelines: [{ id: 'wide', name: 'Wide', color: '#06b6d4', nodes, edges }] });
		expect(screen.getByText('Scheduled (09:00) → 8 agents')).toBeInTheDocument();
		expect(screen.queryByText(/Agent7/)).not.toBeInTheDocument();
	});

	it('shows a health badge derived from the run history', () => {
		renderList({ activityLog: [makeRun({ status: 'failed', exitCode: 1 })] });
		expect(screen.getByText('Failing')).toBeInTheDocument();
	});

	it('shows Running while a run is in flight', () => {
		renderList({ activeRuns: [makeRun({ status: 'running' })] });
		// Scoped to the row - the filter bar also has a "Running" segment.
		const row = screen.getByTestId('pipeline-list-row-Daily Digest');
		expect(within(row).getByText('Running')).toBeInTheDocument();
		expect(within(row).getByText('1 run in flight')).toBeInTheDocument();
	});

	it('reports a pipeline whose subscriptions are all switched off as disabled', () => {
		renderList({
			graphSessions: [
				{
					sessionId: 's1',
					sessionName: 'rc',
					toolType: 'claude-code',
					subscriptions: [
						{
							name: 'Daily Digest',
							event: 'time.scheduled',
							enabled: false,
							prompt: 'go',
							schedule_times: ['09:00'],
						},
					],
				},
			] as never,
		});
		expect(screen.getByText('Disabled')).toBeInTheDocument();
	});

	it('surfaces config validation errors on the row', () => {
		// A pipeline with a trigger but no agent fails validatePipelines.
		const broken: CuePipeline = {
			id: 'broken',
			name: 'Broken',
			color: '#ef4444',
			nodes: [trigger('bt', 'Broken')],
			edges: [],
		};
		renderList({ pipelines: [broken] });
		expect(screen.getByText('Needs attention')).toBeInTheDocument();
		expect(screen.getByText(/needs at least one agent or command/)).toBeInTheDocument();
	});

	it('filters by search text', () => {
		renderList({ pipelines: [makePipeline('Daily Digest'), makePipeline('Cyber Stocks')] });
		fireEvent.change(screen.getByPlaceholderText('Search pipelines...'), {
			target: { value: 'cyber' },
		});
		expect(screen.getByText('Cyber Stocks')).toBeInTheDocument();
		expect(screen.queryByText('Daily Digest')).not.toBeInTheDocument();
	});

	it('filters by health status', () => {
		const broken: CuePipeline = {
			id: 'broken',
			name: 'Broken',
			color: '#ef4444',
			nodes: [trigger('bt', 'Broken')],
			edges: [],
		};
		renderList({ pipelines: [makePipeline('Daily Digest'), broken] });
		fireEvent.click(
			within(screen.getByTestId('pipeline-list-filter')).getByTestId(
				'pipeline-list-filter-attention'
			)
		);
		expect(screen.getByText('Broken')).toBeInTheDocument();
		expect(screen.queryByText('Daily Digest')).not.toBeInTheDocument();
	});

	// The default sort exists so the rows a human must act on are not buried
	// under a couple dozen healthy ones.
	it('sorts problems above healthy pipelines by default', () => {
		const broken: CuePipeline = {
			id: 'broken',
			name: 'Zebra Broken',
			color: '#ef4444',
			nodes: [trigger('bt', 'Zebra Broken')],
			edges: [],
		};
		renderList({
			pipelines: [makePipeline('Alpha Healthy'), broken],
			activityLog: [makeRun({ subscriptionName: 'Alpha Healthy' })],
		});
		const rows = screen.getAllByTestId(/^pipeline-list-row-/);
		expect(rows[0]).toHaveAttribute('data-testid', 'pipeline-list-row-broken');
	});

	it('Run now fires the pipeline when it has exactly one trigger', () => {
		renderList();
		fireEvent.click(screen.getByText('Run now'));
		expect(onTriggerSubscription).toHaveBeenCalledOnce();
		expect(onTriggerSubscription).toHaveBeenCalledWith('Daily Digest');
	});

	// A row-level Run on a multi-trigger pipeline is both ambiguous (which
	// event is being simulated? the triggers carry different prompts) and
	// dangerous - the real 39-trigger pipeline would fire 39 agent runs.
	it('replaces row-level Run now with a per-trigger Run when there are several triggers', () => {
		renderList({ pipelines: [makeMultiTrigger()] });
		expect(screen.queryByText('Run now')).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Multi details' }));
		const detail = screen.getByTestId('pipeline-list-detail-multi');
		const runButtons = within(detail).getAllByText('Run');
		expect(runButtons).toHaveLength(2);

		fireEvent.click(runButtons[1]);
		expect(onTriggerSubscription).toHaveBeenCalledOnce();
		expect(onTriggerSubscription).toHaveBeenCalledWith('Multi-chain-2');
	});

	// Never-saved pipelines have no subscription on disk, so there is nothing
	// the engine could fire - the button must not offer a no-op.
	it('hides Run now when no trigger has a subscription name', () => {
		const unsaved: CuePipeline = {
			id: 'unsaved',
			name: 'Unsaved',
			color: '#06b6d4',
			nodes: [
				{
					id: 't1',
					type: 'trigger',
					position: { x: 0, y: 0 },
					data: { eventType: 'app.startup', label: 'Startup', config: {} },
				} as PipelineNode,
				agent('a1', 'rc'),
			],
			edges: [{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' }],
		};
		renderList({ pipelines: [unsaved] });
		expect(screen.queryByText('Run now')).not.toBeInTheDocument();
	});

	it('Graph jumps to the graph tab with this pipeline selected', () => {
		renderList();
		fireEvent.click(screen.getByText('Graph'));
		expect(onViewInGraph).toHaveBeenCalledWith('Daily Digest');
	});

	// Row actions live inside the expand target, so their clicks must not also
	// toggle the row open underneath the user.
	it('row action clicks do not toggle the row open', () => {
		renderList();
		fireEvent.click(screen.getByText('Graph'));
		expect(screen.queryByTestId('pipeline-list-detail-Daily Digest')).not.toBeInTheDocument();
		fireEvent.click(screen.getByText('Run now'));
		expect(screen.queryByTestId('pipeline-list-detail-Daily Digest')).not.toBeInTheDocument();
	});

	describe('expansion', () => {
		it('hides the trigger and step detail until the row is expanded', () => {
			renderList();
			expect(screen.queryByTestId('pipeline-list-detail-Daily Digest')).not.toBeInTheDocument();

			fireEvent.click(screen.getByRole('button', { name: 'Daily Digest details' }));
			const detail = screen.getByTestId('pipeline-list-detail-Daily Digest');
			expect(within(detail).getByText('Triggers (1)')).toBeInTheDocument();
			expect(within(detail).getByText('Steps (1)')).toBeInTheDocument();
			// The subscription name is the thing you actually need when debugging.
			expect(within(detail).getByText('Daily Digest')).toBeInTheDocument();
		});

		it('collapses again on a second click', () => {
			renderList();
			const toggle = screen.getByRole('button', { name: 'Daily Digest details' });
			fireEvent.click(toggle);
			expect(screen.getByTestId('pipeline-list-detail-Daily Digest')).toBeInTheDocument();
			fireEvent.click(toggle);
			expect(screen.queryByTestId('pipeline-list-detail-Daily Digest')).not.toBeInTheDocument();
		});

		it('expands from the keyboard', () => {
			renderList();
			const toggle = screen.getByRole('button', { name: 'Daily Digest details' });
			expect(toggle).toHaveAttribute('aria-expanded', 'false');
			fireEvent.keyDown(toggle, { key: 'Enter' });
			expect(toggle).toHaveAttribute('aria-expanded', 'true');
		});

		// Expanding one row to compare it against another is the whole point.
		it('keeps several rows open at once', () => {
			renderList({ pipelines: [makePipeline('Daily Digest'), makePipeline('Cyber Stocks')] });
			fireEvent.click(screen.getByRole('button', { name: 'Daily Digest details' }));
			fireEvent.click(screen.getByRole('button', { name: 'Cyber Stocks details' }));
			expect(screen.getByTestId('pipeline-list-detail-Daily Digest')).toBeInTheDocument();
			expect(screen.getByTestId('pipeline-list-detail-Cyber Stocks')).toBeInTheDocument();
		});

		it('lists every node of a wide pipeline once expanded', () => {
			const nodes = [trigger('t1', 'Wide')];
			const edges = [];
			for (let i = 0; i < 8; i++) {
				nodes.push(agent(`a${i}`, `Agent${i}`));
				edges.push({ id: `e${i}`, source: 't1', target: `a${i}`, mode: 'pass' as const });
			}
			renderList({ pipelines: [{ id: 'wide', name: 'Wide', color: '#06b6d4', nodes, edges }] });
			fireEvent.click(screen.getByRole('button', { name: 'Wide details' }));
			const detail = screen.getByTestId('pipeline-list-detail-wide');
			expect(within(detail).getByText('Steps (8)')).toBeInTheDocument();
			expect(within(detail).getByText('Agent7')).toBeInTheDocument();
		});
	});

	// The real complaint this answers: a fan-out pipeline renders "ODIN Market"
	// six times and nothing on screen says which is which. The prompt does.
	describe('prompt introspection', () => {
		function makeFanOut(): CuePipeline {
			return {
				id: 'fanout',
				name: 'ODIN Weekly',
				color: '#06b6d4',
				nodes: [
					trigger('t1', 'ODIN Weekly'),
					agent('a1', 'ODIN Market'),
					agent('a2', 'ODIN Market'),
				],
				edges: [
					{
						id: 'e1',
						source: 't1',
						target: 'a1',
						mode: 'pass',
						prompt: 'Review the options flow for unusual volume.',
					},
					{
						id: 'e2',
						source: 't1',
						target: 'a2',
						mode: 'pass',
						prompt: 'Summarize this week ticker sentiment.',
					},
				],
			};
		}

		it('shows each step prompt so identically-named agents can be told apart', () => {
			renderList({ pipelines: [makeFanOut()] });
			fireEvent.click(screen.getByRole('button', { name: 'ODIN Weekly details' }));
			const detail = screen.getByTestId('pipeline-list-detail-fanout');

			// Both steps carry the same agent name...
			expect(within(detail).getAllByText('ODIN Market')).toHaveLength(2);
			// ...and the prompts are what distinguish them.
			expect(
				within(detail).getByText('Review the options flow for unusual volume.')
			).toBeInTheDocument();
			expect(within(detail).getByText('Summarize this week ticker sentiment.')).toBeInTheDocument();
		});

		it('renders the prompt as a single collapsed line', () => {
			renderList({
				pipelines: [
					{
						...makeFanOut(),
						edges: [
							{
								id: 'e1',
								source: 't1',
								target: 'a1',
								mode: 'pass',
								prompt: 'First line.\n\n   Second line.',
							},
						],
					},
				],
			});
			fireEvent.click(screen.getByRole('button', { name: 'ODIN Weekly details' }));
			const detail = screen.getByTestId('pipeline-list-detail-fanout');
			expect(within(detail).getByText('First line. Second line.')).toBeInTheDocument();
		});

		it('marks a step fed by several distinct prompts', () => {
			renderList({
				pipelines: [
					{
						id: 'multi',
						name: 'Multi',
						color: '#06b6d4',
						nodes: [
							trigger('t1', 'Multi'),
							trigger('t2', 'Multi-chain-2', { eventType: 'app.startup', config: {} }),
							agent('a1', 'rc'),
						],
						edges: [
							{ id: 'e1', source: 't1', target: 'a1', mode: 'pass', prompt: 'morning run' },
							{ id: 'e2', source: 't2', target: 'a1', mode: 'pass', prompt: 'boot run' },
						],
					},
				],
			});
			fireEvent.click(screen.getByRole('button', { name: 'Multi details' }));
			const detail = screen.getByTestId('pipeline-list-detail-multi');
			// The badge is what says "this preview is one of several".
			expect(within(detail).getByText('×2')).toBeInTheDocument();
		});

		it('renders nothing extra when a step has no prompt', () => {
			renderList();
			fireEvent.click(screen.getByRole('button', { name: 'Daily Digest details' }));
			const detail = screen.getByTestId('pipeline-list-detail-Daily Digest');
			expect(within(detail).queryByText('×2')).not.toBeInTheDocument();
		});

		// Agent names repeat in a fan-out, so the prompt is the only text that can
		// narrow the list to the pipeline you actually mean.
		it('search matches prompt text', () => {
			renderList({ pipelines: [makeFanOut(), makePipeline('Daily Digest')] });
			fireEvent.change(screen.getByPlaceholderText('Search pipelines...'), {
				target: { value: 'unusual volume' },
			});
			expect(screen.getByText('ODIN Weekly')).toBeInTheDocument();
			expect(screen.queryByText('Daily Digest')).not.toBeInTheDocument();
		});
	});

	describe('rename', () => {
		function startRename(name = 'Daily Digest') {
			fireEvent.click(screen.getByRole('button', { name: `Rename ${name}` }));
			return screen.getByTestId('pipeline-rename-input');
		}

		it('opens an editor seeded with the current name', () => {
			renderList();
			expect(startRename()).toHaveValue('Daily Digest');
		});

		it('commits on Enter and refetches once the write lands', async () => {
			renderList();
			const input = startRename();
			fireEvent.change(input, { target: { value: 'Morning Digest' } });
			fireEvent.keyDown(input, { key: 'Enter' });

			await waitFor(() =>
				expect(mockRenamePipeline).toHaveBeenCalledWith('Daily Digest', 'Morning Digest')
			);
			await waitFor(() => expect(onRenamed).toHaveBeenCalledOnce());
		});

		it('commits on blur, because clicking away from typed text means keep it', async () => {
			renderList();
			const input = startRename();
			fireEvent.change(input, { target: { value: 'Renamed' } });
			fireEvent.blur(input);

			await waitFor(() =>
				expect(mockRenamePipeline).toHaveBeenCalledWith('Daily Digest', 'Renamed')
			);
		});

		it('cancels on Escape without writing', () => {
			renderList();
			const input = startRename();
			fireEvent.change(input, { target: { value: 'Discarded' } });
			fireEvent.keyDown(input, { key: 'Escape' });

			expect(mockRenamePipeline).not.toHaveBeenCalled();
			expect(screen.queryByTestId('pipeline-rename-input')).not.toBeInTheDocument();
			expect(screen.getByText('Daily Digest')).toBeInTheDocument();
		});

		it('treats an unchanged name as a cancel, not a write', () => {
			renderList();
			const input = startRename();
			fireEvent.keyDown(input, { key: 'Enter' });

			expect(mockRenamePipeline).not.toHaveBeenCalled();
			expect(screen.queryByTestId('pipeline-rename-input')).not.toBeInTheDocument();
		});

		// Rejected in the field rather than after a round-trip, so the bad text
		// stays put and the user can see what they typed.
		it('refuses an empty name and keeps the editor open', () => {
			renderList();
			const input = startRename();
			fireEvent.change(input, { target: { value: '   ' } });
			fireEvent.keyDown(input, { key: 'Enter' });

			expect(mockRenamePipeline).not.toHaveBeenCalled();
			expect(screen.getByText('A pipeline needs a name')).toBeInTheDocument();
			expect(screen.getByTestId('pipeline-rename-input')).toBeInTheDocument();
		});

		it('refuses a name another pipeline already has', () => {
			renderList({ pipelines: [makePipeline('Daily Digest'), makePipeline('Cyber Stocks')] });
			const input = startRename();
			fireEvent.change(input, { target: { value: 'cyber stocks' } });
			fireEvent.keyDown(input, { key: 'Enter' });

			expect(mockRenamePipeline).not.toHaveBeenCalled();
			expect(screen.getByText('Another pipeline already has that name')).toBeInTheDocument();
		});

		// The row's own name is excluded from the clash set, so re-casing works.
		it('allows changing only the casing of the existing name', async () => {
			renderList();
			const input = startRename();
			fireEvent.change(input, { target: { value: 'DAILY DIGEST' } });
			fireEvent.keyDown(input, { key: 'Enter' });

			await waitFor(() =>
				expect(mockRenamePipeline).toHaveBeenCalledWith('Daily Digest', 'DAILY DIGEST')
			);
		});

		// The row is a button that Space/Enter toggles - typing must not drive it.
		it('does not toggle the row while typing in the editor', () => {
			renderList();
			const input = startRename();
			fireEvent.keyDown(input, { key: ' ' });
			expect(screen.queryByTestId('pipeline-list-detail-Daily Digest')).not.toBeInTheDocument();
		});

		it('does not expand the row when the rename button is clicked', () => {
			renderList();
			startRename();
			expect(screen.queryByTestId('pipeline-list-detail-Daily Digest')).not.toBeInTheDocument();
		});

		it('reports a backend refusal instead of pretending it worked', async () => {
			mockRenamePipeline.mockResolvedValue({
				renamed: false,
				subscriptionsUpdated: 0,
				filesWritten: [],
				reason: 'no subscriptions found for pipeline "Daily Digest"',
				warnings: [],
			});
			renderList();
			const input = startRename();
			fireEvent.change(input, { target: { value: 'Nope' } });
			fireEvent.keyDown(input, { key: 'Enter' });

			await waitFor(() =>
				expect(mockNotifyToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }))
			);
			expect(onRenamed).not.toHaveBeenCalled();
		});

		// A warning means the YAML rename DID land - reporting it as a failure
		// would send the user looking for a change that is already on disk.
		it('still refreshes when the write succeeded with warnings', async () => {
			mockRenamePipeline.mockResolvedValue({
				renamed: true,
				subscriptionsUpdated: 1,
				filesWritten: ['/p/.maestro/cue.yaml'],
				warnings: ['pipeline renamed, but saved node positions could not be moved: disk full'],
			});
			renderList();
			const input = startRename();
			fireEvent.change(input, { target: { value: 'Renamed' } });
			fireEvent.keyDown(input, { key: 'Enter' });

			await waitFor(() => expect(onRenamed).toHaveBeenCalledOnce());
			expect(mockNotifyToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }));
		});

		it('surfaces a thrown IPC failure as an error toast', async () => {
			mockRenamePipeline.mockRejectedValue(new Error('IPC exploded'));
			renderList();
			const input = startRename();
			fireEvent.change(input, { target: { value: 'Renamed' } });
			fireEvent.keyDown(input, { key: 'Enter' });

			await waitFor(() =>
				expect(mockNotifyToast).toHaveBeenCalledWith(
					expect.objectContaining({ type: 'error', message: 'IPC exploded' })
				)
			);
			expect(onRenamed).not.toHaveBeenCalled();
		});
	});

	it('renders an empty state that points at the graph tab', () => {
		renderList({ pipelines: [] });
		expect(screen.getByText(/No pipelines yet/)).toBeInTheDocument();
	});

	it('offers a retry when the fetch failed', () => {
		renderList({ error: 'boom' });
		fireEvent.click(screen.getByText('Retry'));
		expect(onRetry).toHaveBeenCalledOnce();
	});
});
