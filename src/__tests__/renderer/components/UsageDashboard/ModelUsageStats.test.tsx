/**
 * Tests for ModelUsageStats, the body of the Usage Dashboard's Models tab.
 *
 * Verifies:
 * - the skeleton shows until the record arrives
 * - a seeded record draws every block: the cards, the sources table, the
 *   latency bars, the tasks, the Run on agents, System One and the token proxy
 * - the sources and tasks tables sort from their headers
 * - a range with nothing on another model shows the empty state, which says
 *   what fills the tab and opens Settings > Models
 * - a block with nothing still renders, and names what would fill it
 * - a failed read shows the reason and a Retry that reads again
 * - the range the user left cannot overwrite the range they are on
 * - the footer line is published, and cleared when the range is empty
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ModelUsageStats } from '../../../../renderer/components/UsageDashboard/ModelUsage';
import { useFooterSummaryStore } from '../../../../renderer/components/UsageDashboard/useFooterSummary';
import { useModalStore } from '../../../../renderer/stores/modalStore';
import type { ModelUsage } from '../../../../shared/local-models/model-usage';
import { TOKEN_PROXY_ESTIMATE_NOTE } from '../../../../shared/local-models/token-proxy';
import { BUSY_MODEL_USAGE, EMPTY_MODEL_USAGE } from '../../../helpers/modelUsageFixtures';
import { mockTheme } from '../../../helpers/mockTheme';

vi.mock('../../../../renderer/utils/sentry', () => ({ captureException: vi.fn() }));

const mockGetModelUsage = vi.fn();
let statsUpdate: (() => void) | null = null;
const unsubscribe = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	statsUpdate = null;
	useFooterSummaryStore.setState({ summaries: {} });
	useModalStore.getState().closeAll();
	(window as unknown as { maestro: Record<string, unknown> }).maestro = {
		stats: {
			getModelUsage: mockGetModelUsage,
			onStatsUpdate: vi.fn((callback: () => void) => {
				statsUpdate = callback;
				return unsubscribe;
			}),
		},
	};
});

afterEach(() => {
	vi.useRealTimers();
});

async function renderLoaded(usage: ModelUsage, props: { colorBlindMode?: boolean } = {}) {
	mockGetModelUsage.mockResolvedValue(usage);
	const view = render(<ModelUsageStats timeRange="week" theme={mockTheme} {...props} />);
	await waitFor(() => {
		expect(screen.queryByTestId('model-usage-skeleton')).not.toBeInTheDocument();
	});
	return view;
}

/** The name in the first cell of every body row of a table, top to bottom. */
function firstColumn(table: HTMLElement): string[] {
	return within(table)
		.getAllByRole('row')
		.slice(1)
		.map((row) => row.querySelector('td span')?.textContent ?? '');
}

describe('ModelUsageStats', () => {
	describe('loading', () => {
		it('shows the skeleton until the record arrives, and asks for the range once', async () => {
			let resolve: (usage: ModelUsage) => void = () => {};
			mockGetModelUsage.mockReturnValue(new Promise<ModelUsage>((r) => (resolve = r)));

			render(<ModelUsageStats timeRange="month" theme={mockTheme} />);

			expect(screen.getByTestId('model-usage-skeleton')).toBeInTheDocument();
			expect(mockGetModelUsage).toHaveBeenCalledTimes(1);
			expect(mockGetModelUsage).toHaveBeenCalledWith('month');

			await act(async () => resolve(BUSY_MODEL_USAGE));

			expect(screen.queryByTestId('model-usage-skeleton')).not.toBeInTheDocument();
			expect(screen.getByTestId('model-usage-stats')).toBeInTheDocument();
		});
	});

	describe('with a seeded record', () => {
		it('states the four headline numbers', async () => {
			await renderLoaded(BUSY_MODEL_USAGE);

			// Work on other models only: the provider's 40 turns are not in it.
			const requests = screen.getByTestId('model-usage-card-requests');
			expect(requests).toHaveTextContent('124');
			expect(requests).toHaveTextContent('2 sources · 3 failed');

			const tokens = screen.getByTestId('model-usage-card-tokens');
			expect(tokens).toHaveTextContent('54.1K');
			expect(tokens).toHaveTextContent('50.0K in · 4.1K out');

			// The share is of ALL the work, the providers' own cloud included.
			const onDevice = screen.getByTestId('model-usage-card-on-device');
			expect(onDevice).toHaveTextContent('25%');
			expect(onDevice).toHaveTextContent('41 of 164 requests');

			const decisions = screen.getByTestId('model-usage-card-decisions');
			expect(decisions).toHaveTextContent('90');
			expect(decisions).toHaveTextContent('86 answered · $0.001900');
		});

		it('lists every source with its kind, where it ran, its split and its latency', async () => {
			await renderLoaded(BUSY_MODEL_USAGE);

			const rows = screen.getAllByTestId('model-usage-source');
			expect(rows).toHaveLength(3);

			const server = rows.find((row) => row.dataset.source === 'server')!;
			expect(server).toHaveTextContent('Maestro model server');
			expect(server).toHaveTextContent('Model server');
			expect(server).toHaveTextContent('This machine');
			// A two-word location must never wrap onto two lines in a narrow cell.
			expect(screen.getAllByText('This machine')[0]).toHaveClass('whitespace-nowrap');
			expect(server).toHaveTextContent('36 runs, 4 turns, 1 routed');
			expect(server).toHaveTextContent('qwen3-coder, qwen3.5-4b');
			expect(server).toHaveTextContent('240ms');
			expect(server).toHaveTextContent('1.2s');
			// It answered requests, so its latency is a request's, not a turn's.
			expect(server).not.toHaveTextContent('240ms turn');

			const jev = rows.find((row) => row.dataset.source === 'system-one:jev-cloud')!;
			expect(jev).toHaveTextContent('Remote');
			expect(jev).toHaveTextContent('System One');

			// A provider's own cloud has no request latency: its turns were timed,
			// and the row says so.
			const provider = rows.find((row) => row.dataset.source === 'provider:claude-code')!;
			expect(provider).toHaveTextContent('Provider cloud');
			expect(provider).toHaveTextContent('40 turns');
			expect(provider).toHaveTextContent('1.5m turn');
			expect(provider).toHaveTextContent('10.0m turn');
			expect(screen.getByTestId('model-usage-turn-note')).toHaveTextContent('whole agent turn');
			expect(screen.getByTestId('model-usage-provider-note')).toHaveTextContent('for comparison');
		});

		it('sorts the sources from a header, and flips on a second click', async () => {
			await renderLoaded(BUSY_MODEL_USAGE);
			const table = screen.getByTestId('model-usage-sources');

			// Most requests first by default.
			expect(firstColumn(table)).toEqual([
				'Jev (TypeSafe cloud)',
				'Maestro model server',
				'Claude Code',
			]);

			fireEvent.click(within(table).getByRole('button', { name: 'Source' }));
			expect(firstColumn(table)).toEqual([
				'Claude Code',
				'Jev (TypeSafe cloud)',
				'Maestro model server',
			]);
			expect(within(table).getByRole('columnheader', { name: 'Source' })).toHaveAttribute(
				'aria-sort',
				'ascending'
			);

			fireEvent.click(within(table).getByRole('button', { name: 'Source' }));
			expect(firstColumn(table)).toEqual([
				'Maestro model server',
				'Jev (TypeSafe cloud)',
				'Claude Code',
			]);

			fireEvent.click(within(table).getByRole('button', { name: 'Tokens in' }));
			expect(firstColumn(table)[0]).toBe('Claude Code');
		});

		it('draws a latency bar per source for requests, and for turns', async () => {
			await renderLoaded(BUSY_MODEL_USAGE);

			const requests = within(screen.getByTestId('model-usage-latency-requests'));
			expect(
				requests.getAllByTestId('latency-bar').map((bar) => bar.getAttribute('aria-label'))
			).toEqual([
				'Jev (TypeSafe cloud): p50 123ms, p95 410ms, over 81 requests',
				'Maestro model server: p50 240ms, p95 1.2s, over 10 requests',
			]);

			const turns = within(screen.getByTestId('model-usage-latency-turns'));
			expect(
				turns.getAllByTestId('latency-bar').map((bar) => bar.getAttribute('data-source'))
			).toEqual(['server', 'provider:claude-code']);
		});

		it('breaks the runs down by task, with where each ran', async () => {
			await renderLoaded(BUSY_MODEL_USAGE);
			const table = screen.getByTestId('model-usage-tasks');

			const rows = within(table).getAllByTestId('model-usage-task');
			expect(rows.map((row) => row.dataset.task)).toEqual(['cue-gate', 'tab-naming']);
			expect(rows[0]).toHaveTextContent('Cue gate');
			expect(rows[0]).toHaveTextContent('83');
			expect(rows[0]).toHaveTextContent('123ms');
			expect(rows[0]).toHaveTextContent('Jev (TypeSafe cloud) 83');
			expect(rows[1]).toHaveTextContent('Maestro model server 36');

			fireEvent.click(within(table).getByRole('button', { name: 'Task' }));
			expect(
				within(table)
					.getAllByTestId('model-usage-task')
					.map((row) => row.dataset.task)
			).toEqual(['cue-gate', 'tab-naming']);
			fireEvent.click(within(table).getByRole('button', { name: 'p95' }));
			expect(
				within(table)
					.getAllByTestId('model-usage-task')
					.map((row) => row.dataset.task)
			).toEqual(['tab-naming', 'cue-gate']);
		});

		it('shows a tile for each agent that ran turns on another model, and no other', async () => {
			await renderLoaded(BUSY_MODEL_USAGE);

			const tile = screen.getByTestId('model-usage-agent-agent-alpha-0001');
			expect(tile).toHaveTextContent('Alpha');
			expect(tile).toHaveTextContent('qwen3-coder on Maestro model server');
			expect(tile).toHaveTextContent('Claude Code');
			expect(tile).toHaveAttribute(
				'aria-label',
				'Alpha: 4 Run on turns on qwen3-coder on Maestro model server'
			);
			// Beta had runs filed for it and launched nothing on another model.
			expect(screen.queryByTestId('model-usage-agent-agent-beta-0002')).not.toBeInTheDocument();
		});

		it('splits the System One decisions by outcome, by task and by tier', async () => {
			await renderLoaded(BUSY_MODEL_USAGE);

			const outcomes = screen.getByTestId('model-usage-outcomes');
			expect(outcomes).toHaveTextContent('Answered');
			expect(outcomes).toHaveTextContent('86');
			expect(outcomes).toHaveTextContent('Failed open');
			expect(outcomes).toHaveTextContent('Failed closed');
			expect(screen.getByTestId('model-usage-outcome-facts')).toHaveTextContent(
				'7 answered from the cache · 2 timed out · $0.001900 spent'
			);

			const tiers = screen.getByTestId('model-usage-tiers');
			expect(tiers).toHaveTextContent('Low');
			expect(tiers).toHaveTextContent('10');
			expect(tiers).toHaveTextContent('17');

			const task = screen.getByTestId('model-usage-decision-task');
			expect(task).toHaveTextContent('Cue gate');
			expect(task).toHaveTextContent('90');
			expect(screen.getByTestId('model-usage-engines')).toHaveTextContent(
				'Jev (TypeSafe cloud): 90 decisions, 86 answered'
			);
			// The quarter reaches back further than the ledger keeps.
			expect(screen.getByTestId('model-usage-retention-note')).toHaveTextContent(
				'Decisions are kept 30 days'
			);
		});

		it('labels the token proxy saving as an estimate', async () => {
			await renderLoaded(BUSY_MODEL_USAGE);

			const table = screen.getByTestId('model-usage-proxy');
			expect(within(table).getByText('Tokens saved (est.)')).toHaveAttribute(
				'title',
				TOKEN_PROXY_ESTIMATE_NOTE
			);
			expect(screen.getByTestId('model-usage-proxy-total')).toHaveTextContent('10,000 (25%)');
			expect(screen.getByTestId('model-usage-proxy-total')).toHaveTextContent('14 ms');

			const agents = screen.getAllByTestId('model-usage-proxy-agent');
			expect(agents[0]).toHaveTextContent('Alpha');
			// A passthrough request is counted, and nothing about it is estimated.
			expect(agents[1]).toHaveTextContent('No agent (started outside the app)');
			expect(agents[1]).toHaveTextContent('-');

			expect(screen.getByTestId('model-usage-proxy-routed')).toHaveTextContent(
				'1 background request sent to a Local Models target'
			);
			expect(screen.getByTestId('model-usage-proxy-estimate')).toHaveTextContent(
				TOKEN_PROXY_ESTIMATE_NOTE
			);
			expect(screen.getByText('Estimate')).toBeInTheDocument();
		});

		it('publishes the footer line', async () => {
			await renderLoaded(BUSY_MODEL_USAGE);

			expect(useFooterSummaryStore.getState().summaries.models).toBe(
				'124 requests · 25% on this machine · 90 decisions · 3 failed'
			);
		});

		it('passes the colorblind palette to the outcome split', async () => {
			await renderLoaded(BUSY_MODEL_USAGE, { colorBlindMode: true });

			const arcs = screen.getByTestId('model-usage-outcomes').querySelectorAll('circle[stroke]');
			expect(Array.from(arcs).map((arc) => arc.getAttribute('stroke'))).toContain('#009988');
		});
	});

	describe('with a block that has nothing', () => {
		it('keeps the block and names what would fill it', async () => {
			// One housekeeping run on a local model, and nothing else.
			const [server] = BUSY_MODEL_USAGE.sources;
			await renderLoaded({
				...EMPTY_MODEL_USAGE,
				totals: { ...EMPTY_MODEL_USAGE.totals, requests: 1, otherModelRequests: 1 },
				sources: [{ ...server, requests: 1, runs: 1, turns: 0, routed: 0 }],
			});

			expect(screen.getByTestId('model-usage-sources')).toBeInTheDocument();
			expect(screen.getByTestId('model-usage-tasks-empty')).toHaveTextContent(
				'Settings > Models > System Two'
			);
			expect(screen.getByTestId('model-usage-agents-empty')).toHaveTextContent('Run on target');
			expect(screen.getByTestId('model-usage-system-one-empty')).toHaveTextContent(
				'Settings > Models > System One'
			);
			expect(screen.getByTestId('model-usage-proxy-empty')).toHaveTextContent(
				'Settings > Models > Gateway'
			);
			// No provider and no turn-only source, so neither footnote applies.
			expect(screen.queryByTestId('model-usage-provider-note')).not.toBeInTheDocument();
		});

		it('says nothing about retention when the ledger covers the range', async () => {
			await renderLoaded({
				...BUSY_MODEL_USAGE,
				systemOne: { ...BUSY_MODEL_USAGE.systemOne, coversRange: true },
			});

			expect(screen.queryByTestId('model-usage-retention-note')).not.toBeInTheDocument();
		});
	});

	describe('with no data', () => {
		it('says what fills the tab and opens Settings > Models', async () => {
			// The dashboard is the open destination, as it is when the tab is on screen.
			useModalStore.getState().openModal('usageDashboard');
			await renderLoaded(EMPTY_MODEL_USAGE);

			expect(screen.getByTestId('usage-dashboard-empty')).toBeInTheDocument();
			expect(screen.getByText('No model usage in this range')).toBeInTheDocument();
			expect(screen.getByText(/a model other than a provider's own/)).toBeInTheDocument();
			expect(screen.queryByTestId('model-usage-stats')).not.toBeInTheDocument();
			expect(useFooterSummaryStore.getState().summaries.models).toBeUndefined();

			fireEvent.click(screen.getByRole('button', { name: 'Open Settings > Models' }));

			const modals = useModalStore.getState();
			expect(modals.isOpen('settings')).toBe(true);
			expect(modals.getData('settings')).toMatchObject({ tab: 'models' });
			// Settings takes the window over: the dashboard does not stay up behind it.
			expect(modals.isOpen('usageDashboard')).toBe(false);
		});

		it('treats a range with only the providers own cloud as empty', async () => {
			const provider = BUSY_MODEL_USAGE.sources[1];
			await renderLoaded({
				...EMPTY_MODEL_USAGE,
				totals: { ...EMPTY_MODEL_USAGE.totals, requests: 40 },
				sources: [provider],
			});

			expect(screen.getByText('No model usage in this range')).toBeInTheDocument();
		});
	});

	describe('when the read fails', () => {
		it('shows the reason, unwrapped, and reads again on Retry', async () => {
			mockGetModelUsage.mockRejectedValueOnce(
				new Error("Error invoking remote method 'stats:get-model-usage': Error: database is locked")
			);
			render(<ModelUsageStats timeRange="week" theme={mockTheme} />);

			const note = await screen.findByTestId('model-usage-error');
			expect(note).toHaveTextContent('Failed to load model usage');
			expect(note).toHaveTextContent('database is locked');
			expect(note).not.toHaveTextContent('Error invoking remote method');

			mockGetModelUsage.mockResolvedValue(BUSY_MODEL_USAGE);
			fireEvent.click(within(note).getByRole('button', { name: 'Retry' }));

			await waitFor(() => {
				expect(screen.getByTestId('model-usage-stats')).toBeInTheDocument();
			});
			expect(mockGetModelUsage).toHaveBeenCalledTimes(2);
		});
	});

	describe('when the range or the data changes', () => {
		it('drops an answer for a range the user has already left', async () => {
			let resolveWeek: (usage: ModelUsage) => void = () => {};
			mockGetModelUsage.mockImplementation((range: string) =>
				range === 'week'
					? new Promise<ModelUsage>((r) => (resolveWeek = r))
					: Promise.resolve(EMPTY_MODEL_USAGE)
			);

			const { rerender } = render(<ModelUsageStats timeRange="week" theme={mockTheme} />);
			rerender(<ModelUsageStats timeRange="day" theme={mockTheme} />);

			await screen.findByText('No model usage in this range');

			// The slow "week" read lands after "day" has been drawn.
			await act(async () => resolveWeek(BUSY_MODEL_USAGE));

			expect(screen.getByText('No model usage in this range')).toBeInTheDocument();
			expect(screen.queryByTestId('model-usage-stats')).not.toBeInTheDocument();
		});

		it('reads again, once, after a burst of stats updates, without the skeleton', async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			await renderLoaded(BUSY_MODEL_USAGE);
			expect(mockGetModelUsage).toHaveBeenCalledTimes(1);

			mockGetModelUsage.mockResolvedValue({
				...BUSY_MODEL_USAGE,
				totals: { ...BUSY_MODEL_USAGE.totals, otherModelRequests: 130 },
			});
			act(() => {
				statsUpdate?.();
				statsUpdate?.();
				statsUpdate?.();
			});
			expect(mockGetModelUsage).toHaveBeenCalledTimes(1);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(1000);
			});

			expect(mockGetModelUsage).toHaveBeenCalledTimes(2);
			expect(screen.queryByTestId('model-usage-skeleton')).not.toBeInTheDocument();
			await waitFor(() => {
				expect(screen.getByTestId('model-usage-card-requests')).toHaveTextContent('130');
			});
		});

		it('keeps the record on screen when a background refresh fails', async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			await renderLoaded(BUSY_MODEL_USAGE);

			mockGetModelUsage.mockRejectedValue(new Error('database is locked'));
			act(() => statsUpdate?.());
			await act(async () => {
				await vi.advanceTimersByTimeAsync(1000);
			});

			expect(mockGetModelUsage).toHaveBeenCalledTimes(2);
			expect(screen.getByTestId('model-usage-stats')).toBeInTheDocument();
			expect(screen.queryByTestId('model-usage-error')).not.toBeInTheDocument();
		});

		it('stops listening when it unmounts', async () => {
			const { unmount } = await renderLoaded(BUSY_MODEL_USAGE);

			unmount();

			expect(unsubscribe).toHaveBeenCalledTimes(1);
		});
	});
});
