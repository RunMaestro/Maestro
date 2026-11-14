/**
 * Tests for ModelUsageStats, the body of the Usage Dashboard's Models tab.
 *
 * Verifies:
 * - the skeleton shows until the record arrives
 * - a seeded record draws every block: the cards, the sources table, the
 *   latency bars, the tasks, the model source agents, System One and the token proxy
 * - the sources and tasks tables sort from their headers
 * - a range with nothing on another model shows the empty state, which says
 *   what fills the tab and opens Settings > Models
 * - a block with nothing still renders, and names what would fill it
 * - a failed read shows the reason and a Retry that reads again
 * - the range the user left cannot overwrite the range they are on
 * - the footer line is published, and cleared when the range is empty
 * - the token proxy section: the three headline figures with their denominators,
 *   the read time of the record and a refresh through the one fetch owner, the
 *   daily trend with a gap for every day nothing was read, the mode, route and
 *   algorithm splits with their scopes, the provider's own usage with its
 *   coverage, the handling lines, an older desktop that sends only totals, and
 *   no polling while it sits open
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ModelUsageStats } from '../../../../renderer/components/UsageDashboard/ModelUsage';
import { useFooterSummaryStore } from '../../../../renderer/components/UsageDashboard/useFooterSummary';
import { useModalStore } from '../../../../renderer/stores/modalStore';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import type { ModelUsage } from '../../../../shared/local-models/model-usage';
import { formatCalendarDay, formatTimestamp } from '../../../../shared/formatters';
import {
	TOKEN_PROXY_ESTIMATE_NOTE,
	TOKEN_PROXY_EVIDENCE_SEPARATION_NOTE,
	TOKEN_PROXY_UNKNOWN_LABELS,
} from '../../../../shared/local-models/token-proxy';
import {
	TOKEN_PROXY_PROVIDER_STORED_SUMS_NOTE,
	TOKEN_PROXY_PROVIDER_USAGE_NOTE,
	TOKEN_PROXY_RESULTS_NOT_EVALUATED_NOTE,
	TOKEN_PROXY_TREND_NOTE,
	describeProxyHandling,
} from '../../../../shared/local-models/token-proxy-report';
import { COLORBLIND_LINE_COLORS } from '../../../../renderer/constants/colorblindPalettes';
import {
	BUSY_MODEL_USAGE,
	EMPTY_MODEL_USAGE,
	PROXY_LOADED_AT,
	PROXY_RANGE_SINCE,
	currentProxyModelUsage,
	currentProxyUsage,
} from '../../../helpers/modelUsageFixtures';
import { mockTheme } from '../../../helpers/mockTheme';
import { createMockSession } from '../../../helpers/mockSession';

vi.mock('../../../../renderer/utils/sentry', () => ({ captureException: vi.fn() }));

const mockGetModelUsage = vi.fn();
let statsUpdate: (() => void) | null = null;
const unsubscribe = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	statsUpdate = null;
	useFooterSummaryStore.setState({ summaries: {} });
	useModalStore.getState().closeAll();
	useSessionStore.setState({ sessions: [], activeSessionId: '' });
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
				'Alpha: 4 model source turns on qwen3-coder on Maestro model server'
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
			// No dollar or quality result exists for the saving, and the section says so.
			expect(screen.getByTestId('model-usage-proxy-not-evaluated')).toHaveTextContent(
				TOKEN_PROXY_RESULTS_NOT_EVALUATED_NOTE
			);
			expect(screen.getByText('Estimate')).toBeInTheDocument();
		});

		it('says unknown, not 0 ms, for a group whose read requests carry no time', async () => {
			const proxy = BUSY_MODEL_USAGE.proxy;
			await renderLoaded({
				...BUSY_MODEL_USAGE,
				proxy: {
					...proxy,
					totals: { ...proxy.totals, avgAddedLatencyMs: 0, timedRequests: 1 },
					byAgent: [
						{ ...proxy.byAgent[0], avgAddedLatencyMs: 0, timedRequests: 0 },
						proxy.byAgent[1],
					],
				},
			});

			// A measured zero is a measurement and a group with no sample is not.
			expect(screen.getByTestId('model-usage-proxy-total')).toHaveTextContent('0 ms');
			const [alpha] = screen.getAllByTestId('model-usage-proxy-agent');
			expect(alpha).toHaveTextContent('unknown');
			expect(alpha).not.toHaveTextContent('0 ms');
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

	describe('token proxy effectiveness', () => {
		/** Render the Models tab with the clock at the moment the record is read. */
		async function renderProxy(
			usage: ModelUsage = currentProxyModelUsage(),
			colorBlindMode = false
		) {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			vi.setSystemTime(PROXY_LOADED_AT);
			return renderLoaded(usage, { colorBlindMode });
		}

		const headline = () => within(screen.getByTestId('model-usage-proxy-headline'));

		it('reads the reduction against what arrived, the coverage against what was carried, and the time against its sample', async () => {
			await renderProxy();

			// 18,000 of the 100,000 estimated tokens in the 100 requests the proxy read.
			expect(headline().getByText('Payload reduction (est.)')).toBeInTheDocument();
			expect(headline().getByText('18,000 (18%)')).toBeInTheDocument();
			expect(
				headline().getByText('of 100.0K estimated tokens in 100 read requests')
			).toBeInTheDocument();

			// 100 of the 120 requests carried were read; 20 passed through unread.
			expect(headline().getByText('100 / 120')).toBeInTheDocument();
			expect(
				headline().getByText('requests the proxy read, of those it carried')
			).toBeInTheDocument();

			// The mean, with the distribution and the sample it is read from.
			expect(headline().getByText('Processing time (mean)')).toBeInTheDocument();
			expect(headline().getByText('14 ms')).toBeInTheDocument();
			expect(
				headline().getByText(
					'p50 12ms, p95 80ms, p99 1.2s over 98 timed requests; 2 read requests without a time'
				)
			).toBeInTheDocument();
		});

		it('says not read, and unknown, rather than 0 when the proxy read nothing or timed nothing', async () => {
			const proxy = currentProxyUsage();
			await renderProxy(
				currentProxyModelUsage({
					...proxy,
					totals: {
						...proxy.totals,
						compressRequests: 0,
						originalTokens: 0,
						sentTokens: 0,
						tokensSaved: 0,
						avgAddedLatencyMs: 0,
						timedRequests: 0,
					},
					effectiveness: {
						...proxy.effectiveness!,
						latency: { timed: 0, untimed: 0, distribution: null, unknown: 'not-read' },
						trend: [],
					},
				})
			);

			// A dash and the reason, for the reduction and for the time: nothing was
			// read, so nothing was reduced and nothing was timed.
			expect(headline().getAllByText('-', { selector: 'span' })).toHaveLength(2);
			expect(headline().getAllByText(TOKEN_PROXY_UNKNOWN_LABELS['not-read'])).toHaveLength(2);
			expect(headline().getByText('0 / 120')).toBeInTheDocument();
			expect(headline().queryByText('0 (0%)')).not.toBeInTheDocument();
			expect(headline().queryByText('0 ms')).not.toBeInTheDocument();
		});

		it('says unknown, and why there is no distribution, for requests read with no time or too few', async () => {
			const proxy = currentProxyUsage();
			await renderProxy(
				currentProxyModelUsage({
					...proxy,
					totals: { ...proxy.totals, avgAddedLatencyMs: 0, timedRequests: 0 },
					effectiveness: {
						...proxy.effectiveness!,
						latency: { timed: 0, untimed: 100, distribution: null, unknown: 'not-recorded' },
					},
				})
			);
			expect(headline().getByText('unknown')).toBeInTheDocument();
			expect(
				headline().getByText(
					`${TOKEN_PROXY_UNKNOWN_LABELS['not-recorded']}; 100 read requests without a time`
				)
			).toBeInTheDocument();
		});

		it('withholds the distribution below the sample minimum and keeps the sample count', async () => {
			const proxy = currentProxyUsage();
			await renderProxy(
				currentProxyModelUsage({
					...proxy,
					totals: { ...proxy.totals, timedRequests: 12 },
					effectiveness: {
						...proxy.effectiveness!,
						latency: {
							timed: 12,
							untimed: 0,
							distribution: null,
							unknown: 'insufficient-samples',
						},
					},
				})
			);
			expect(
				headline().getByText('too few samples to report (12 timed requests, 30 needed)')
			).toBeInTheDocument();
			expect(headline().queryByText(/p95/)).not.toBeInTheDocument();
		});

		describe('freshness and refresh', () => {
			it('says when the record was read, from the fetch owner, and not when the range starts', async () => {
				await renderProxy();

				const loaded = screen.getByTestId('model-usage-proxy-loaded');
				expect(loaded).toHaveTextContent(`Loaded ${formatTimestamp(PROXY_LOADED_AT)}`);
				// `usage.since` is the start of the range. It is not a time of reading.
				expect(loaded).not.toHaveTextContent(formatTimestamp(PROXY_RANGE_SINCE, 'datetime'));
				expect(loaded).not.toHaveTextContent(formatTimestamp(PROXY_RANGE_SINCE, 'time'));
			});

			it('reads the range again through the one fetch owner, and shows the new time', async () => {
				await renderProxy();
				expect(mockGetModelUsage).toHaveBeenCalledTimes(1);

				let resolve: (usage: ModelUsage) => void = () => {};
				mockGetModelUsage.mockReturnValue(new Promise<ModelUsage>((r) => (resolve = r)));
				const later = new Date(2026, 10, 12, 10, 15).getTime();
				vi.setSystemTime(later);
				fireEvent.click(screen.getByTestId('model-usage-proxy-refresh'));

				// One more read of the same range. The record stays on screen while it is
				// in flight, the button says so and cannot be pressed twice, and the time
				// is still the last read that succeeded.
				expect(mockGetModelUsage).toHaveBeenCalledTimes(2);
				expect(mockGetModelUsage).toHaveBeenLastCalledWith('week');
				const button = screen.getByTestId('model-usage-proxy-refresh');
				expect(button).toBeDisabled();
				expect(button).toHaveTextContent('Refreshing');
				expect(screen.queryByTestId('model-usage-skeleton')).not.toBeInTheDocument();
				expect(screen.getByTestId('model-usage-proxy-loaded')).toHaveTextContent(
					`Loaded ${formatTimestamp(PROXY_LOADED_AT)}`
				);

				await act(async () => resolve(currentProxyModelUsage()));

				expect(screen.getByTestId('model-usage-proxy-refresh')).toBeEnabled();
				expect(screen.getByTestId('model-usage-proxy-refresh')).toHaveTextContent('Refresh');
				expect(screen.getByTestId('model-usage-proxy-loaded')).toHaveTextContent(
					`Loaded ${formatTimestamp(later)}`
				);
			});

			it('shows the failure, and a Retry that reads again, when a refresh fails', async () => {
				await renderProxy();

				mockGetModelUsage.mockRejectedValueOnce(new Error('database is locked'));
				fireEvent.click(screen.getByTestId('model-usage-proxy-refresh'));

				const note = await screen.findByTestId('model-usage-error');
				expect(note).toHaveTextContent('database is locked');
				// A record that failed to refresh is no longer claimed as read at a time.
				expect(screen.queryByTestId('model-usage-proxy-loaded')).not.toBeInTheDocument();

				mockGetModelUsage.mockResolvedValue(currentProxyModelUsage());
				fireEvent.click(within(note).getByRole('button', { name: 'Retry' }));
				await waitFor(() => {
					expect(screen.getByTestId('model-usage-proxy-loaded')).toBeInTheDocument();
				});
			});

			it('does not read again or change the time on its own while it sits open', async () => {
				await renderProxy();

				await act(async () => {
					await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
				});

				// No timer polls and no clock re-renders the label: an hour later it is
				// still the time of the one read.
				expect(mockGetModelUsage).toHaveBeenCalledTimes(1);
				expect(screen.getByTestId('model-usage-proxy-loaded')).toHaveTextContent(
					`Loaded ${formatTimestamp(PROXY_LOADED_AT, 'time')}`
				);
			});

			it('takes the new record after a stats update, without the skeleton, and moves the time', async () => {
				await renderProxy();

				const later = new Date(2026, 10, 12, 9, 50).getTime();
				vi.setSystemTime(later);
				mockGetModelUsage.mockResolvedValue(currentProxyModelUsage());
				act(() => statsUpdate?.());
				await act(async () => {
					await vi.advanceTimersByTimeAsync(1000);
				});

				expect(screen.queryByTestId('model-usage-skeleton')).not.toBeInTheDocument();
				expect(screen.getByTestId('model-usage-proxy-loaded')).toHaveTextContent(
					`Loaded ${formatTimestamp(later, 'time')}`
				);
			});
		});

		describe('the daily trend', () => {
			const chart = () => screen.getByTestId('model-usage-proxy-trend');

			it('draws what arrived and what was sent on one axis, from the range start to the day it was read', async () => {
				await renderProxy();

				const image = within(chart()).getByRole('img');
				expect(image).toHaveAccessibleName(
					'Estimated tokens in the requests the proxy read, by day, as they arrived and as they were sent'
				);
				// The axis names the first and last day of the range, and only two between:
				// whole dates are about 70px, so more than four collide in a narrow window.
				for (const day of ['2026-11-05', '2026-11-07', '2026-11-10', '2026-11-12']) {
					expect(within(chart()).getByText(formatCalendarDay(day))).toBeInTheDocument();
				}
				for (const day of ['2026-11-06', '2026-11-08', '2026-11-09', '2026-11-11']) {
					expect(within(chart()).queryByText(formatCalendarDay(day))).not.toBeInTheDocument();
				}
				// Two overlapping estimates are two labelled series and nothing else.
				expect(
					within(chart())
						.getAllByRole('button')
						.map((button) => button.textContent)
				).toEqual(['Original (est.)', 'Sent (est.)']);
			});

			it('breaks each line at a day nothing was read, and does not draw it as 0', async () => {
				await renderProxy();

				const lines = Array.from(chart().querySelectorAll('polyline'));
				// 11-06 and 11-07 are joined. 11-08 (unread), 11-09 (no request) and 11-11
				// (no request) are gaps, so 11-10 and 11-12 stand alone as marks and are not
				// joined to a zero. Two lines in all: one run per series.
				expect(lines).toHaveLength(2);
				for (const line of lines) {
					expect(line.getAttribute('points')!.split(' ')).toHaveLength(2);
				}
				// The single days stand alone as marks: two per series.
				expect(chart().querySelectorAll('line[stroke-width="6"]')).toHaveLength(4);
				// The sent line is the dashed one, so the two differ by more than a color.
				const [original, sent] = lines;
				expect(original.getAttribute('stroke-dasharray')).toBeNull();
				expect(sent.getAttribute('stroke-dasharray')).toBeTruthy();
				expect(original.getAttribute('stroke')).toBe(mockTheme.colors.textDim);
				expect(sent.getAttribute('stroke')).toBe(mockTheme.colors.accent);
			});

			it('uses high-contrast line colors in colorblind mode, still dashed apart', async () => {
				await renderProxy(currentProxyModelUsage(), true);

				const [original, sent] = Array.from(chart().querySelectorAll('polyline'));
				expect(original.getAttribute('stroke')).toBe(COLORBLIND_LINE_COLORS.secondary);
				expect(sent.getAttribute('stroke')).toBe(COLORBLIND_LINE_COLORS.primary);
				expect(sent.getAttribute('stroke-dasharray')).toBeTruthy();
			});

			it('says what a gap is, that the first day is partial, and that these are estimates', async () => {
				await renderProxy();

				const note = screen.getByTestId('model-usage-proxy-trend-note');
				// The legend cannot show a dash, so the note says which line is which.
				expect(note).toHaveTextContent(
					'The solid line is what arrived and the dashed line is what was sent'
				);
				expect(note).toHaveTextContent(TOKEN_PROXY_TREND_NOTE);
				expect(note).toHaveTextContent('A gap is a day with no request the proxy read');
				expect(note).toHaveTextContent('unknown, not zero');
				expect(screen.getByText('Original (est.)')).toBeInTheDocument();
			});

			it.each([
				['no day at all', []],
				[
					'only days whose requests were never read',
					[
						{
							date: '2026-11-08',
							requests: 10,
							compressRequests: 0,
							originalTokens: 0,
							sentTokens: 0,
							blocksShortened: 0,
						},
					],
				],
			])('says there is nothing to draw for %s, and draws no chart', async (_name, trend) => {
				const proxy = currentProxyUsage();
				await renderProxy(
					currentProxyModelUsage({ ...proxy, effectiveness: { ...proxy.effectiveness!, trend } })
				);

				expect(screen.getByTestId('model-usage-proxy-trend-empty')).toHaveTextContent(
					'No day in this range has a request the proxy read'
				);
				expect(screen.queryByTestId('model-usage-proxy-trend')).not.toBeInTheDocument();
			});

			it('keeps a legend hidden through a refresh of the same range', async () => {
				await renderProxy();
				fireEvent.click(within(chart()).getByRole('button', { name: /Original \(est\.\)/ }));
				expect(chart().querySelectorAll('polyline')).toHaveLength(1);

				await act(async () => {
					fireEvent.click(screen.getByTestId('model-usage-proxy-refresh'));
				});
				await waitFor(() => expect(mockGetModelUsage).toHaveBeenCalledTimes(2));

				expect(chart().querySelectorAll('polyline')).toHaveLength(1);
			});
		});

		describe('the splits', () => {
			it('splits the requests by mode as a partition, with the group that predates the measure unknown', async () => {
				await renderProxy();

				const modes = screen.getByTestId('model-usage-proxy-modes');
				expect(modes).toHaveTextContent('Request mode');
				expect(modes).toHaveTextContent(/Compress early\s*70\s*58%/);
				expect(modes).toHaveTextContent(/Compress tool results\s*30\s*25%/);
				expect(modes).toHaveTextContent(/Passthrough \(count only\)\s*12\s*10%/);
				expect(modes).toHaveTextContent(
					new RegExp(
						`${TOKEN_PROXY_UNKNOWN_LABELS['not-recorded'].replace(/[()]/g, '\\$&')}\\s*8\\s*7%`
					)
				);
				// The center says how many requests the split covers.
				expect(modes).toHaveTextContent('120Total');
				expect(modes).toHaveTextContent(
					'Requests carried in this range, by the mode each was carried as'
				);
				expect(modes).toHaveTextContent(
					'none is inferred from the stored mode or from an agent setting'
				);
			});

			it('splits the requests by provider route, keeping a stored route this build does not know', async () => {
				const proxy = currentProxyUsage();
				await renderProxy(
					currentProxyModelUsage({
						...proxy,
						byRoute: [
							...proxy.byRoute!,
							{ ...proxy.byRoute![0], route: 'a-newer-route', requests: 2 },
						],
					})
				);

				const routes = screen.getByTestId('model-usage-proxy-routes');
				expect(routes).toHaveTextContent(/Claude Code\s*80/);
				expect(routes).toHaveTextContent(/Codex with an OpenAI API key\s*30/);
				expect(routes).toHaveTextContent(/Codex with a ChatGPT login\s*10/);
				expect(routes).toHaveTextContent(/a-newer-route\s*2/);
				expect(routes).toHaveTextContent(
					'Requests carried in this range, by the provider route each used'
				);
			});

			it('draws the algorithms as overlapping counts with their cohort, never as shares of a whole', async () => {
				await renderProxy();

				const algorithms = screen.getByTestId('model-usage-proxy-algorithms');
				expect(algorithms).toHaveTextContent(/json\s*150/);
				expect(algorithms).toHaveTextContent(/logs\s*100/);
				expect(algorithms).toHaveTextContent(/model\s*20/);
				expect(algorithms).toHaveTextContent('blocks shortened, per algorithm');
				// 270 algorithm-blocks over 200 unique blocks: the cohort is said against the
				// range's 210 blocks shortened, and the lists are said not to add up.
				expect(screen.getByTestId('model-usage-proxy-algorithm-cohort')).toHaveTextContent(
					'200 unique blocks in the requests that recorded their algorithms, out of 210 shortened in the range; a block that two algorithms shortened is listed under each, so the lists do not add up'
				);
				// No percentage and no "+N more" row that would add overlapping counts.
				expect(algorithms).not.toHaveTextContent('%');
				expect(algorithms).not.toHaveTextContent('more');
			});

			it('draws every algorithm as its own bar however many there are', async () => {
				const proxy = currentProxyUsage();
				const many = Array.from({ length: 11 }, (_, index) => ({
					algorithm: `algo-${index}`,
					blocks: 20 - index,
					requests: 5,
				}));
				await renderProxy(
					currentProxyModelUsage({
						...proxy,
						effectiveness: {
							...proxy.effectiveness!,
							algorithms: { uniqueBlocks: 100, algorithms: many },
						},
					})
				);

				const algorithms = screen.getByTestId('model-usage-proxy-algorithms');
				for (const { algorithm } of many) expect(algorithms).toHaveTextContent(algorithm);
				expect(algorithms).not.toHaveTextContent('more');
			});

			it('passes the colorblind palette to the splits', async () => {
				await renderProxy(currentProxyModelUsage(), true);

				const arcs = screen
					.getByTestId('model-usage-proxy-modes')
					.querySelectorAll('circle[stroke]:not([opacity])');
				expect(Array.from(arcs).map((arc) => arc.getAttribute('stroke'))).toContain('#0077BB');
			});
		});

		describe('the provider usage and how the proxy handled the requests', () => {
			it('says each class the provider counted with its coverage, under the note that fits it', async () => {
				await renderProxy();

				const provider = screen.getByTestId('model-usage-proxy-provider');
				expect(provider).toHaveTextContent('Provider usage');
				const lines = within(screen.getByTestId('model-usage-proxy-provider-lines'));
				expect(lines.getByText('Input').nextElementSibling).toHaveTextContent(
					'1.2M tokens on 100 of 120 requests. Other requests: 12 not reported in the answer (unknown, not zero); 8 recorded before reporting was tracked (unknown)'
				);
				// A measured zero keeps its coverage and is not an unknown.
				expect(lines.getByText('Cache write').nextElementSibling).toHaveTextContent(
					'0 tokens on 50 of 120 requests'
				);
				expect(screen.getByTestId('model-usage-proxy-provider-note')).toHaveTextContent(
					TOKEN_PROXY_PROVIDER_USAGE_NOTE
				);
			});

			it('says the sums of an older desktop as stored sums of unknown provenance, never as classes', async () => {
				const proxy = currentProxyUsage();
				await renderProxy(
					currentProxyModelUsage({
						...proxy,
						effectiveness: undefined,
						byMode: undefined,
						byRoute: undefined,
						totals: {
							...proxy.totals,
							provider: {
								requests: 90,
								inputTokens: 4_000,
								cacheReadTokens: 120_000,
								cacheWriteTokens: 0,
								outputTokens: 600,
							},
						},
					})
				);

				const lines = within(screen.getByTestId('model-usage-proxy-provider-lines'));
				expect(lines.getByText('Stored sums').nextElementSibling).toHaveTextContent(
					'unknown provenance and coverage for each class'
				);
				expect(screen.getByTestId('model-usage-proxy-provider-note')).toHaveTextContent(
					TOKEN_PROXY_PROVIDER_STORED_SUMS_NOTE
				);
				expect(screen.getByTestId('model-usage-proxy-provider')).not.toHaveTextContent(
					TOKEN_PROXY_PROVIDER_USAGE_NOTE
				);
			});

			it('keeps Maestro verdict reuse, the provider cache and the estimates on separate lines', async () => {
				await renderProxy();

				const handling = screen.getByTestId('model-usage-proxy-handling');
				// Maestro's own cache, said not to be the provider's.
				expect(handling).toHaveTextContent(
					"40 verdicts reused from Maestro's compression cache (not the provider's prompt cache)"
				);
				// The provider's cache read is a class of its own, elsewhere.
				expect(screen.getByTestId('model-usage-proxy-provider')).toHaveTextContent('Cache read');
				expect(handling).not.toHaveTextContent('Cache read');
				expect(screen.getByTestId('model-usage-proxy-separation')).toHaveTextContent(
					TOKEN_PROXY_EVIDENCE_SEPARATION_NOTE
				);
			});

			it('says the handling lines as the shared report does, and none of the lines drawn elsewhere', async () => {
				await renderProxy();

				const lines = within(screen.getByTestId('model-usage-proxy-handling-lines'));
				const expected = describeProxyHandling(currentProxyUsage().effectiveness!);
				expect(expected.map((line) => line.label)).toEqual([
					'Requests',
					'Blocks',
					'Set aside',
					'Skipped',
				]);
				for (const line of expected) {
					expect(lines.getByText(line.label).nextElementSibling).toHaveTextContent(line.text);
				}
				// Counts are said with their coverage: 90 of the 100 read requests carry them.
				expect(screen.getByTestId('model-usage-proxy-handling')).toHaveTextContent(
					'90 of 100 read requests counted'
				);
				expect(lines.queryByText('Processing time')).not.toBeInTheDocument();
				expect(lines.queryByText('Algorithms')).not.toBeInTheDocument();
			});

			it('says the block counts are unknown, not 0, for requests read before counts were recorded', async () => {
				const proxy = currentProxyUsage();
				await renderProxy(
					currentProxyModelUsage({
						...proxy,
						effectiveness: {
							...proxy.effectiveness!,
							blocks: { coverage: { scope: 'range', counted: 0, of: 100 }, counts: null },
						},
					})
				);

				expect(screen.getByTestId('model-usage-proxy-handling')).toHaveTextContent(
					`${TOKEN_PROXY_UNKNOWN_LABELS['not-recorded']}; none of 100 read requests carries counts`
				);
			});
		});

		describe('the per-agent table and the notes', () => {
			it('keeps the table, the estimate and the not-evaluated notes, and gives no dollar figure or grade', async () => {
				await renderProxy();

				expect(screen.getByTestId('model-usage-proxy-total')).toHaveTextContent('18,000 (18%)');
				const [alpha, beta] = screen.getAllByTestId('model-usage-proxy-agent');
				expect(alpha).toHaveTextContent('Alpha');
				expect(alpha).toHaveTextContent('90');
				expect(alpha).toHaveTextContent('12,000 (17%)');
				expect(beta).toHaveTextContent('Beta');
				expect(screen.getByTestId('model-usage-proxy-estimate')).toHaveTextContent(
					TOKEN_PROXY_ESTIMATE_NOTE
				);
				expect(screen.getByTestId('model-usage-proxy-not-evaluated')).toHaveTextContent(
					TOKEN_PROXY_RESULTS_NOT_EVALUATED_NOTE
				);

				const section = screen.getByTestId('model-usage-proxy-headline').closest('section')!;
				expect(section).not.toHaveTextContent(/\$\d/);
				expect(section).not.toHaveTextContent(/\b(grade|rating|score)\b/i);
			});

			it('opens Gateway on its own panel from the section and closes the dashboard', async () => {
				useModalStore.getState().openModal('usageDashboard');
				await renderProxy();

				fireEvent.click(screen.getByRole('button', { name: 'Settings > Models > Gateway' }));

				const modals = useModalStore.getState();
				expect(modals.isOpen('settings')).toBe(true);
				expect(modals.getData('settings')).toMatchObject({ tab: 'models', subTab: 'gateway' });
				expect(modals.isOpen('usageDashboard')).toBe(false);
			});

			it('draws the three figures and says what is missing for a desktop that sent only the totals', async () => {
				await renderProxy(BUSY_MODEL_USAGE);

				// The totals alone give the reduction, the coverage and the mean.
				expect(headline().getByText('10,000 (25%)')).toBeInTheDocument();
				expect(headline().getByText('5 / 12')).toBeInTheDocument();
				expect(headline().getByText('14 ms')).toBeInTheDocument();
				// Nothing that needs the newer record is drawn, or invented.
				expect(screen.queryByTestId('model-usage-proxy-trend-block')).not.toBeInTheDocument();
				expect(screen.queryByTestId('model-usage-proxy-modes')).not.toBeInTheDocument();
				expect(screen.queryByTestId('model-usage-proxy-routes')).not.toBeInTheDocument();
				expect(screen.queryByTestId('model-usage-proxy-algorithms')).not.toBeInTheDocument();
				expect(screen.queryByTestId('model-usage-proxy-handling')).not.toBeInTheDocument();
				expect(screen.getByTestId('model-usage-proxy-older')).toHaveTextContent(
					'This desktop sent only the totals'
				);
			});

			it('leaves out a split the desktop did not send, and keeps the rest', async () => {
				const proxy = currentProxyUsage();
				await renderProxy(currentProxyModelUsage({ ...proxy, byRoute: undefined }));

				expect(screen.queryByTestId('model-usage-proxy-routes')).not.toBeInTheDocument();
				expect(screen.getByTestId('model-usage-proxy-modes')).toBeInTheDocument();
				expect(screen.getByTestId('model-usage-proxy-algorithms')).toBeInTheDocument();
				expect(screen.queryByTestId('model-usage-proxy-older')).not.toBeInTheDocument();
			});

			it('says only the empty line, with no toolbar, when no request went through the proxy', async () => {
				await renderProxy({
					...currentProxyModelUsage(),
					proxy: { ...EMPTY_MODEL_USAGE.proxy, totals: { ...EMPTY_MODEL_USAGE.proxy.totals } },
				});

				expect(screen.getByTestId('model-usage-proxy-empty')).toBeInTheDocument();
				expect(screen.queryByTestId('model-usage-proxy-refresh')).not.toBeInTheDocument();
				expect(screen.queryByTestId('model-usage-proxy-headline')).not.toBeInTheDocument();
			});
		});
	});

	describe('with a block that has nothing', () => {
		const [server] = BUSY_MODEL_USAGE.sources;
		const partialUsage: ModelUsage = {
			...EMPTY_MODEL_USAGE,
			totals: { ...EMPTY_MODEL_USAGE.totals, requests: 1, otherModelRequests: 1 },
			sources: [{ ...server, requests: 1, runs: 1, turns: 0, routed: 0 }],
		};

		it('keeps the block and names what would fill it', async () => {
			// One housekeeping run on a local model, and nothing else.
			await renderLoaded(partialUsage);

			expect(screen.getByTestId('model-usage-sources')).toBeInTheDocument();
			expect(screen.getByTestId('model-usage-tasks-empty')).toHaveTextContent(
				'Settings > Models > System Two'
			);
			expect(screen.getByTestId('model-usage-agents-empty')).toHaveTextContent('model source');
			expect(screen.getByTestId('model-usage-system-one-empty')).toHaveTextContent(
				'Settings > Models > System One'
			);
			expect(screen.getByTestId('model-usage-proxy-empty')).toHaveTextContent(
				'Settings > Models > Gateway'
			);
			// No provider and no turn-only source, so neither footnote applies.
			expect(screen.queryByTestId('model-usage-provider-note')).not.toBeInTheDocument();
		});

		it.each([
			['tasks', 'System One', 'system-one'],
			['tasks', 'System Two', 'system-two'],
			['system-one', 'System One', 'system-one'],
			['proxy', 'Gateway', 'gateway'],
		] as const)(
			'opens the %s setup link for %s on its exact panel',
			async (section, label, panel) => {
				useModalStore.getState().openModal('usageDashboard');
				await renderLoaded(partialUsage);
				fireEvent.click(
					within(screen.getByTestId(`model-usage-${section}-empty`)).getByRole('button', {
						name: `Settings > Models > ${label}`,
					})
				);

				const modals = useModalStore.getState();
				expect(modals.isOpen('settings')).toBe(true);
				expect(modals.getData('settings')).toMatchObject({ tab: 'models', subTab: panel });
				expect(modals.isOpen('usageDashboard')).toBe(false);
			}
		);

		it('opens the named active agent on its Models tab for Run on setup', async () => {
			const session = createMockSession({ id: 'alpha', name: 'Alpha' });
			useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
			useModalStore.getState().openModal('usageDashboard');
			await renderLoaded(partialUsage);

			// Settings must receive the live record, even when the link label stays the same.
			act(() => useSessionStore.setState({ sessions: [{ ...session, cwd: '/updated/project' }] }));
			fireEvent.click(screen.getByRole('button', { name: "Open Alpha's Models settings" }));

			const modals = useModalStore.getState();
			expect(modals.isOpen('editAgent')).toBe(true);
			expect(modals.getData('editAgent')).toMatchObject({
				session: { id: 'alpha', cwd: '/updated/project' },
				initialTab: 'models',
			});
			// Per-agent settings stack, so closing them returns to these stats.
			expect(modals.isOpen('usageDashboard')).toBe(true);
			act(() => modals.closeModal('editAgent'));
			expect(useModalStore.getState().isOpen('usageDashboard')).toBe(true);
		});

		it('updates the Run on shortcut when the active agent changes', async () => {
			const alpha = createMockSession({ id: 'alpha', name: 'Alpha' });
			const beta = createMockSession({ id: 'beta', name: 'Beta' });
			useSessionStore.setState({ sessions: [alpha, beta], activeSessionId: alpha.id });
			await renderLoaded(partialUsage);

			act(() => useSessionStore.setState({ activeSessionId: beta.id }));
			expect(
				screen.queryByRole('button', { name: "Open Alpha's Models settings" })
			).not.toBeInTheDocument();
			fireEvent.click(screen.getByRole('button', { name: "Open Beta's Models settings" }));
			expect(useModalStore.getState().getData('editAgent')).toMatchObject({
				session: { id: 'beta' },
				initialTab: 'models',
			});
		});

		it('removes the Run on shortcut when the active agent is removed', async () => {
			const session = createMockSession({ id: 'alpha', name: 'Alpha' });
			useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
			await renderLoaded(partialUsage);
			expect(
				screen.getByRole('button', { name: "Open Alpha's Models settings" })
			).toBeInTheDocument();

			act(() => useSessionStore.setState({ sessions: [] }));
			expect(
				within(screen.getByTestId('model-usage-agents-empty')).queryByRole('button')
			).not.toBeInTheDocument();
		});

		it.each(['none', 'terminal'] as const)('offers no Run on shortcut for %s', async (kind) => {
			if (kind === 'terminal') {
				const session = createMockSession({ toolType: 'terminal' });
				useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
			}
			await renderLoaded(partialUsage);
			expect(
				within(screen.getByTestId('model-usage-agents-empty')).queryByRole('button')
			).not.toBeInTheDocument();
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
