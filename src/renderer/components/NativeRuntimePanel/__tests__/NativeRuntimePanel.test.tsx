import '@testing-library/jest-dom';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AgentRuntimeFeatureState } from '../../../../shared/agent-runtime-features';
import { THEMES } from '../../../constants/themes';
import { NativeRuntimePanel } from '../NativeRuntimePanel';

const theme = THEMES.dracula;

function features(overrides: Partial<AgentRuntimeFeatureState> = {}): AgentRuntimeFeatureState {
	return {
		controls: [],
		tree: null,
		todos: null,
		subagents: null,
		stats: null,
		loginProviders: null,
		...overrides,
	};
}

function liveFeatures(overrides: Partial<AgentRuntimeFeatureState> = {}): AgentRuntimeFeatureState {
	return features({
		controls: [
			{
				id: 'model',
				label: 'Model',
				kind: 'select',
				value: 'anthropic:claude',
				options: [{ id: 'anthropic:claude', label: 'Claude Fable' }],
			},
		],
		todos: [
			{
				name: 'Native fixture',
				items: [
					{ content: 'Render ordinary session', state: 'in_progress' },
					{ content: 'Ship it', state: 'done' },
				],
			},
		],
		subagents: [{ id: 'helper-1', label: 'Native helper', status: 'running' }],
		tree: [
			{ id: 'entry-1', label: 'native expanded transcript' },
			{ id: 'entry-2', label: '<system-notice>compaction</system-notice>' },
			{ id: 'entry-3', label: 'native expanded transcript' },
		],
		stats: {
			inputTokens: 21,
			outputTokens: 1400,
			totalCostUsd: 0.0042,
			totalTokens: 50_000,
			contextWindow: 200_000,
			turnCount: 3,
		},
		...overrides,
	});
}

function renderPanel(
	featureState: AgentRuntimeFeatureState,
	seams: {
		onSetControl?: Mock;
		onBranch?: Mock;
		onLoadDetail?: Mock;
	} = {}
) {
	const onSetControl = seams.onSetControl ?? vi.fn().mockResolvedValue(true);
	const onBranch = seams.onBranch ?? vi.fn().mockResolvedValue(true);
	const onLoadDetail = seams.onLoadDetail ?? vi.fn().mockResolvedValue([]);
	render(
		<NativeRuntimePanel
			features={featureState}
			theme={theme}
			sessionId="session-1-ai-tab-1"
			onSetControl={onSetControl}
			onBranch={onBranch}
			onLoadDetail={onLoadDetail}
		/>
	);
	return { onSetControl, onBranch, onLoadDetail };
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe('NativeRuntimePanel dormant state', () => {
	it('shows only a quiet readiness note — no controls, stats, or sections', () => {
		renderPanel(
			features({
				readiness: { state: 'dormant', message: 'OMP Native ready — starts on first message.' },
			})
		);

		expect(screen.getByTestId('native-runtime-dormant')).toHaveTextContent(
			'OMP Native ready — starts on first message.'
		);
		expect(screen.getByText('Ready')).toBeInTheDocument();
		expect(screen.queryByText('Live')).not.toBeInTheDocument();
		expect(screen.queryByTestId('native-runtime-stats')).not.toBeInTheDocument();
		expect(screen.queryByTestId('native-runtime-advanced')).not.toBeInTheDocument();
		expect(screen.queryByPlaceholderText('OMP session file path')).not.toBeInTheDocument();
	});
});

describe('NativeRuntimePanel live state', () => {
	it('renders the status header with live indicator and model chip', () => {
		renderPanel(liveFeatures());

		expect(screen.getByText('OMP Native')).toBeInTheDocument();
		expect(screen.getByText('Live')).toBeInTheDocument();
		expect(screen.getByText('Claude Fable')).toBeInTheDocument();
		expect(screen.queryByTestId('native-runtime-dormant')).not.toBeInTheDocument();
	});

	it('presents stats as labelled cards and a context gauge, never raw key dumps', () => {
		renderPanel(liveFeatures());

		const stats = screen.getByTestId('native-runtime-stats');
		expect(stats).toHaveTextContent('Input');
		expect(stats).toHaveTextContent('21');
		expect(stats).toHaveTextContent('Output');
		expect(stats).toHaveTextContent('1.4k');
		expect(stats).toHaveTextContent('Cost');
		expect(stats).toHaveTextContent('$0.0042');
		// Leftover keys are humanized rows.
		expect(stats).toHaveTextContent('Turn count');
		expect(stats).not.toHaveTextContent('inputTokens: 21');
		expect(stats).not.toHaveTextContent('turnCount');

		const gauge = screen.getByRole('progressbar', { name: 'Context window usage' });
		expect(gauge).toHaveAttribute('aria-valuenow', '25');

		// Narrow-layout semantics: two-column tile grid inside a shrinkable panel.
		expect(stats.querySelector('.grid-cols-2')).not.toBeNull();
		expect(screen.getByTestId('native-runtime-panel')).toHaveClass('min-w-0');
	});

	it('renders tasks with progress badge and state styling', () => {
		renderPanel(liveFeatures());

		const todos = screen.getByTestId('native-runtime-todos');
		expect(todos).toHaveTextContent('Tasks');
		expect(todos).toHaveTextContent('1/2');
		expect(todos).toHaveTextContent('Render ordinary session');
		expect(screen.getByText('Ship it')).toHaveClass('line-through');
	});

	it('renders subagents with status and loads their messages into a detail card', async () => {
		const onLoadDetail = vi.fn().mockResolvedValue(['Native helper detail']);
		renderPanel(liveFeatures(), { onLoadDetail });

		const subagents = screen.getByTestId('native-runtime-subagents');
		expect(subagents).toHaveTextContent('Native helper');
		expect(subagents).toHaveTextContent('Running');

		fireEvent.click(screen.getByRole('button', { name: 'View messages for Native helper' }));
		expect(onLoadDetail).toHaveBeenCalledWith('session-1-ai-tab-1', 'subagent', 'helper-1');

		await waitFor(() => {
			expect(screen.getByText('Native helper detail')).toBeInTheDocument();
		});
		expect(screen.getByText('Native helper messages')).toBeInTheDocument();

		// Detail card can be dismissed.
		fireEvent.click(screen.getByRole('button', { name: 'Close detail' }));
		expect(screen.queryByText('Native helper detail')).not.toBeInTheDocument();
	});

	it('ignores a stale detail response that resolves after a newer request', async () => {
		const pending: Record<
			string,
			{ resolve: (lines: string[]) => void; reject: (error: Error) => void }
		> = {};
		const onLoadDetail = vi.fn(
			(_sessionId: string, _kind: string, entryId: string) =>
				new Promise<string[]>((resolve, reject) => {
					pending[entryId] = { resolve, reject };
				})
		);
		renderPanel(liveFeatures(), { onLoadDetail });

		// Request A (subagent), then request B (branch) while A is still in flight.
		fireEvent.click(screen.getByRole('button', { name: 'View messages for Native helper' }));
		fireEvent.click(
			screen.getByRole('button', { name: 'View branch messages for native expanded transcript' })
		);

		// Newer request B resolves first.
		pending['entry-1'].resolve(['branch line']);
		await waitFor(() => {
			expect(screen.getByText('branch line')).toBeInTheDocument();
		});

		// Older request A resolves late: it must not overwrite B or re-show loading.
		pending['helper-1'].resolve(['stale helper line']);
		await waitFor(() => {
			expect(onLoadDetail).toHaveBeenCalledTimes(2);
		});
		expect(screen.queryByText('stale helper line')).not.toBeInTheDocument();
		expect(screen.getByText('branch line')).toBeInTheDocument();
		expect(screen.getByText('native expanded transcript messages')).toBeInTheDocument();
		expect(screen.queryByText('Loading messages…')).not.toBeInTheDocument();
	});

	it('ignores a stale detail rejection after a newer request resolved', async () => {
		const pending: Record<
			string,
			{ resolve: (lines: string[]) => void; reject: (error: Error) => void }
		> = {};
		const onLoadDetail = vi.fn(
			(_sessionId: string, _kind: string, entryId: string) =>
				new Promise<string[]>((resolve, reject) => {
					pending[entryId] = { resolve, reject };
				})
		);
		renderPanel(liveFeatures(), { onLoadDetail });

		fireEvent.click(screen.getByRole('button', { name: 'View messages for Native helper' }));
		fireEvent.click(
			screen.getByRole('button', { name: 'View branch messages for native expanded transcript' })
		);

		pending['entry-1'].resolve(['branch line']);
		await waitFor(() => {
			expect(screen.getByText('branch line')).toBeInTheDocument();
		});

		// The stale request failing must not surface an error over B's content.
		pending['helper-1'].reject(new Error('stale failure'));
		await waitFor(() => {
			expect(onLoadDetail).toHaveBeenCalledTimes(2);
		});
		expect(screen.queryByText('Unable to load native runtime detail.')).not.toBeInTheDocument();
		expect(screen.getByText('branch line')).toBeInTheDocument();
	});

	it('does not resurrect a closed detail card when its response arrives late', async () => {
		const pending: Record<
			string,
			{ resolve: (lines: string[]) => void; reject: (error: Error) => void }
		> = {};
		const onLoadDetail = vi.fn(
			(_sessionId: string, _kind: string, entryId: string) =>
				new Promise<string[]>((resolve, reject) => {
					pending[entryId] = { resolve, reject };
				})
		);
		renderPanel(liveFeatures(), { onLoadDetail });

		fireEvent.click(screen.getByRole('button', { name: 'View messages for Native helper' }));
		fireEvent.click(screen.getByRole('button', { name: 'Close detail' }));
		expect(screen.queryByText('Native helper messages')).not.toBeInTheDocument();

		pending['helper-1'].resolve(['late helper line']);
		await waitFor(() => {
			expect(onLoadDetail).toHaveBeenCalledTimes(1);
		});
		expect(screen.queryByText('late helper line')).not.toBeInTheDocument();
		expect(screen.queryByTestId('native-runtime-detail')).not.toBeInTheDocument();
	});

	it('filters markup payloads and duplicates from session activity but keeps branch actions', () => {
		const { onBranch } = renderPanel(liveFeatures());

		const activity = screen.getByTestId('native-runtime-activity');
		expect(activity).toHaveTextContent('native expanded transcript');
		expect(activity).not.toHaveTextContent('system-notice');
		// Duplicate entry-3 label deduplicated: one Branch button only.
		const branchButtons = screen.getAllByRole('button', {
			name: 'Branch from native expanded transcript',
		});
		expect(branchButtons).toHaveLength(1);

		fireEvent.click(branchButtons[0]);
		expect(onBranch).toHaveBeenCalledWith('session-1-ai-tab-1', 'entry-1');
	});

	it('loads branch messages and surfaces load failures as an error state', async () => {
		const onLoadDetail = vi.fn().mockRejectedValue(new Error('gone'));
		renderPanel(liveFeatures(), { onLoadDetail });

		fireEvent.click(
			screen.getByRole('button', { name: 'View branch messages for native expanded transcript' })
		);
		expect(onLoadDetail).toHaveBeenCalledWith('session-1-ai-tab-1', 'branch', 'entry-1');

		await waitFor(() => {
			expect(screen.getByText('Unable to load native runtime detail.')).toBeInTheDocument();
		});
	});

	it('shows a guiding empty state when live with no runtime data', () => {
		renderPanel(features());
		expect(screen.getByText(/No runtime details yet/)).toBeInTheDocument();
	});
});

describe('NativeRuntimePanel advanced controls', () => {
	it('keeps resume, shell, and login behind a collapsed disclosure', () => {
		renderPanel(liveFeatures());

		const toggle = screen.getByRole('button', { name: /Advanced/ });
		expect(toggle).toHaveAttribute('aria-expanded', 'false');
		expect(screen.queryByPlaceholderText('OMP session file path')).not.toBeInTheDocument();

		fireEvent.click(toggle);
		expect(toggle).toHaveAttribute('aria-expanded', 'true');
		expect(screen.getByPlaceholderText('OMP session file path')).toBeInTheDocument();
	});

	it('dispatches resume and shell commands through agent controls', () => {
		const { onSetControl } = renderPanel(liveFeatures());
		fireEvent.click(screen.getByRole('button', { name: /Advanced/ }));

		const resumeButton = screen.getByRole('button', { name: 'Resume' });
		expect(resumeButton).toBeDisabled();
		fireEvent.change(screen.getByPlaceholderText('OMP session file path'), {
			target: { value: ' /fixture/resumed-native.jsonl ' },
		});
		expect(resumeButton).toBeEnabled();
		fireEvent.click(resumeButton);
		expect(onSetControl).toHaveBeenCalledWith(
			'session-1-ai-tab-1',
			'switch-session',
			'/fixture/resumed-native.jsonl'
		);

		fireEvent.change(screen.getByPlaceholderText('Run OMP shell command'), {
			target: { value: 'echo native shell' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Run' }));
		expect(onSetControl).toHaveBeenCalledWith('session-1-ai-tab-1', 'bash', 'echo native shell');
	});

	it('uses discovered login providers as a select and dispatches login', () => {
		const { onSetControl } = renderPanel(
			liveFeatures({
				loginProviders: [{ id: 'fixture-login', label: 'Fixture Login' }],
			})
		);
		fireEvent.click(screen.getByRole('button', { name: /Advanced/ }));

		const select = screen.getByLabelText('OMP login provider');
		expect(select.tagName).toBe('SELECT');
		fireEvent.change(select, { target: { value: 'fixture-login' } });
		fireEvent.click(screen.getByRole('button', { name: 'Login' }));
		expect(onSetControl).toHaveBeenCalledWith('session-1-ai-tab-1', 'login', 'fixture-login');
	});

	it('falls back to a free-form login input when no providers are discovered', () => {
		renderPanel(liveFeatures());
		fireEvent.click(screen.getByRole('button', { name: /Advanced/ }));

		const input = screen.getByLabelText('OMP login provider');
		expect(input.tagName).toBe('INPUT');
		expect(screen.getByRole('button', { name: 'Login' })).toBeDisabled();
	});
});
