/**
 * Tests for the inspection half of the Gateway usage card (task 07.3): the
 * diagnostics of the last 30 days, the evidence behind a recent compression, and
 * the recovery counts and read opportunities since the app started. The card
 * explains an observed reduction or a skip and points at the paths that recover
 * the evidence, using the one report and the words `maestro-cli models proxy
 * status` prints. It reads nothing on its own: a closed disclosure draws nothing,
 * and only Refresh reads the report again.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../../../../../renderer/utils/clipboard', () => ({
	safeClipboardWrite: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../../../../renderer/utils/flashCopiedToClipboard', () => ({
	flashCopiedToClipboard: vi.fn(),
}));

import { LocalModelsProxyUsage } from '../../../../../renderer/components/Settings/tabs/LocalModelsTab/LocalModelsProxyUsage';
import { useTokenProxyReport } from '../../../../../renderer/hooks/localModels/useTokenProxyReport';
import { safeClipboardWrite } from '../../../../../renderer/utils/clipboard';
import {
	TOKEN_PROXY_EVIDENCE_SEPARATION_NOTE,
	TOKEN_PROXY_OPPORTUNITY_NOTE,
	TOKEN_PROXY_UNKNOWN_LABELS,
	type TokenProxyReport,
} from '../../../../../shared/local-models/token-proxy';
import {
	TOKEN_PROXY_RECOVERY_HEADING,
	TOKEN_PROXY_TOTALS_ONLY_NOTE,
	TOKEN_PROXY_TREND_NOTE,
} from '../../../../../shared/local-models/token-proxy-report';
import type { ProxyRequestUsage, ProxyTrendDay } from '../../../../../shared/stats-types';
import { mockTheme } from '../../../../helpers/mockTheme';
import {
	busyProxyEffectiveness,
	emptyProxyEffectiveness,
	proxyReport,
	readOpportunities,
	recoveryObservations,
} from '../../../../helpers/proxyTelemetryFixtures';

const PORT = 48123;
const HASH = 'a'.repeat(64);
const AGENT = 'agent-1';

const TOTALS = {
	requests: 120,
	compressRequests: 100,
	originalTokens: 40_000,
	sentTokens: 30_000,
	tokensSaved: 10_000,
	avgAddedLatencyMs: 14,
	timedRequests: 98,
	provider: {
		requests: 0,
		inputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		outputTokens: 0,
	},
};

function usage(overrides: Partial<ProxyRequestUsage> = {}): ProxyRequestUsage {
	return {
		range: 'month',
		totals: TOTALS,
		byAgent: [{ agentId: AGENT, ...TOTALS, requests: 120 }],
		effectiveness: busyProxyEffectiveness(),
		...overrides,
	};
}

function running(extra: Partial<TokenProxyReport> = {}): TokenProxyReport {
	return proxyReport({
		status: { port: PORT, running: true, agentIds: [AGENT], lastError: null, gatewayUrls: null },
		agents: [
			{
				id: AGENT,
				name: 'Alpha',
				toolType: 'claude-code',
				mode: 'compress',
				gatewayUrl: `http://127.0.0.1:${PORT}/anthropic`,
			},
		],
		usage: usage(),
		...extra,
	});
}

function card(report: TokenProxyReport | null, onRefresh = vi.fn()) {
	return render(
		<LocalModelsProxyUsage
			theme={mockTheme}
			report={report}
			loading={false}
			error={null}
			onRefresh={onRefresh}
			agentNames={{}}
		/>
	);
}

/** The card wired the way the Gateway section wires it: one hook, one Refresh. */
function Harness() {
	const proxy = useTokenProxyReport();
	return (
		<LocalModelsProxyUsage
			theme={mockTheme}
			report={proxy.report}
			loading={proxy.loading}
			error={proxy.error}
			onRefresh={() => void proxy.refresh()}
			agentNames={{}}
		/>
	);
}

function open(testId: string) {
	fireEvent.click(screen.getByTestId(`${testId}-toggle`));
}

const proxyApi = () => window.maestro.localModels.proxy;

beforeEach(() => {
	vi.mocked(proxyApi().report).mockReset();
	vi.mocked(proxyApi().report).mockResolvedValue(running());
	vi.mocked(proxyApi().block).mockReset();
	vi.mocked(proxyApi().block).mockResolvedValue(null);
	vi.mocked(safeClipboardWrite).mockClear();
});

afterEach(() => vi.useRealTimers());

describe('diagnostics of the last 30 days', () => {
	it('draws nothing while closed, and makes no read of its own when opened', () => {
		card(running());

		expect(screen.getByTestId('token-proxy-diagnostics-toggle')).toHaveAttribute(
			'aria-expanded',
			'false'
		);
		expect(screen.queryByTestId('token-proxy-diagnostics-lines')).not.toBeInTheDocument();

		open('token-proxy-diagnostics');

		expect(screen.getByTestId('token-proxy-diagnostics-toggle')).toHaveAttribute(
			'aria-expanded',
			'true'
		);
		expect(screen.getByTestId('token-proxy-diagnostics-lines')).toBeInTheDocument();
		expect(proxyApi().report).not.toHaveBeenCalled();
		expect(proxyApi().block).not.toHaveBeenCalled();
	});

	it('explains how the requests were handled, each count with the share of requests it covers', () => {
		card(running());
		open('token-proxy-diagnostics');

		const lines = screen.getByTestId('token-proxy-diagnostics-lines');
		expect(lines).toHaveTextContent(
			"Requests120 requests carried. Of those: 100 read, 8 forwarded without the compressor's result, 60 with a block shortened (210 blocks)"
		);
		// A partial range: 90 of the 100 read requests carry block counts.
		expect(lines).toHaveTextContent('Blocks90 of 100 read requests counted');
		expect(lines).toHaveTextContent('300 candidate blocks');
		expect(lines).toHaveTextContent("40 verdicts reused from Maestro's compression cache");
		// Why a request went through unread, and what went out whole.
		expect(lines).toHaveTextContent(
			'Skipped5 a body that is not UTF-8 text; 3 decoding or compressing failed'
		);
		expect(lines).toHaveTextContent(
			'Set aside120 recent or at a cache breakpoint, 3 failed results'
		);
		expect(lines).toHaveTextContent('each went out whole');
		expect(lines).toHaveTextContent('Processing timep50 12ms');
		expect(lines).toHaveTextContent('json 150 blocks in 40 requests');
		// Counts, estimates and observations stay apart, and the card says so.
		expect(screen.getByTestId('token-proxy-diagnostics')).toHaveTextContent(
			TOKEN_PROXY_EVIDENCE_SEPARATION_NOTE
		);
	});

	it('says unknown, not zero, when no read request carries counts (zero coverage)', () => {
		const none = busyProxyEffectiveness();
		none.blocks = { coverage: { scope: 'range', counted: 0, of: 100 }, counts: null };
		card(running({ usage: usage({ effectiveness: none }) }));
		open('token-proxy-diagnostics');

		const lines = screen.getByTestId('token-proxy-diagnostics-lines');
		expect(lines).toHaveTextContent(
			`Blocks${TOKEN_PROXY_UNKNOWN_LABELS['not-recorded']}; none of 100 read requests carries counts`
		);
		expect(lines).not.toHaveTextContent(/\b0 shortened\b/);
		expect(lines).not.toHaveTextContent('candidate blocks');
	});

	it('says the body was not read, rather than a count of 0, for a range of passthrough requests', () => {
		const unread = emptyProxyEffectiveness();
		unread.traffic = { carried: 12, read: 0, skipped: 0, shortened: 0, blocksShortened: 0 };
		card(
			running({
				usage: usage({
					totals: { ...TOTALS, compressRequests: 0, requests: 12, tokensSaved: 0 },
					byAgent: [],
					effectiveness: unread,
				}),
			})
		);
		open('token-proxy-diagnostics');

		const lines = screen.getByTestId('token-proxy-diagnostics-lines');
		expect(lines).toHaveTextContent(`Blocks${TOKEN_PROXY_UNKNOWN_LABELS['not-read']}`);
		expect(lines).toHaveTextContent('12 requests carried. Of those: 0 read');
	});

	it('lists the latest days that hold data, says the first day is partial, and counts the rest', () => {
		const day = (n: number): ProxyTrendDay => ({
			date: `2026-11-${String(n).padStart(2, '0')}`,
			requests: 10,
			compressRequests: 8,
			originalTokens: 4_000,
			sentTokens: 3_000,
			blocksShortened: 5,
		});
		const effectiveness = busyProxyEffectiveness();
		effectiveness.trend = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(day);
		card(running({ usage: usage({ effectiveness }) }));
		open('token-proxy-diagnostics');

		const days = screen.getByTestId('token-proxy-diagnostics-days');
		expect(days).toHaveTextContent('2026-11-09');
		expect(days).toHaveTextContent('2026-11-03');
		expect(days).not.toHaveTextContent('2026-11-02');
		expect(days).toHaveTextContent(
			'10 requests, 8 read, est. tokens saved 1,000 (25%), 5 blocks shortened'
		);
		expect(days).toHaveTextContent(TOKEN_PROXY_TREND_NOTE);
		expect(days).toHaveTextContent('2 earlier days in the range are not listed here.');
	});

	it('says what an older desktop did not send, and keeps the totals', () => {
		card(running({ usage: usage({ effectiveness: undefined }) }));
		open('token-proxy-diagnostics');

		expect(screen.getByTestId('token-proxy-diagnostics-older')).toHaveTextContent(
			TOKEN_PROXY_TOTALS_ONLY_NOTE
		);
		expect(screen.queryByTestId('token-proxy-diagnostics-lines')).not.toBeInTheDocument();
		expect(screen.getByTestId('token-proxy-usage-total')).toHaveTextContent('10,000 (25%)');
	});

	it('offers no diagnostics for a range with no request', () => {
		card(running({ usage: usage({ totals: { ...TOTALS, requests: 0 }, byAgent: [] }) }));

		expect(screen.getByTestId('token-proxy-usage-empty')).toBeInTheDocument();
		expect(screen.queryByTestId('token-proxy-diagnostics')).not.toBeInTheDocument();
	});
});

describe('requests by mode and by provider route', () => {
	const group = (requests: number, tokensSaved: number) => ({
		...TOTALS,
		requests,
		compressRequests: tokensSaved > 0 ? requests : 0,
		tokensSaved,
		originalTokens: tokensSaved > 0 ? tokensSaved * 4 : 0,
	});

	it('shows each cut apart from the agents, with the same figures as the totals', () => {
		card(
			running({
				usage: usage({
					byMode: [
						{ effectiveMode: 'compress', ...group(80, 9_000) },
						{ effectiveMode: 'passthrough', ...group(30, 0) },
					],
					byRoute: [{ route: 'anthropic', ...group(110, 9_000) }],
				}),
			})
		);

		const [compress, passthrough] = screen.getAllByTestId('token-proxy-usage-mode');
		expect(compress).toHaveTextContent('Compress tool results');
		expect(compress).toHaveTextContent('80');
		expect(compress).toHaveTextContent('9,000 (25%)');
		// A group the proxy never read shows a dash, not a saving of 0.
		expect(passthrough).toHaveTextContent('Passthrough (count only)');
		expect(within(passthrough).getAllByText('-')).toHaveLength(2);
		expect(screen.getByTestId('token-proxy-usage-route')).toHaveTextContent('Claude Code');
		expect(screen.getAllByTestId('token-proxy-usage-agent')).toHaveLength(1);
		expect(screen.getByText(/By request mode/)).toBeInTheDocument();
		expect(screen.getByText('By provider route')).toBeInTheDocument();
	});

	it('keeps a route this build does not know as it was stored, and a mode it cannot state as unknown', () => {
		card(
			running({
				usage: usage({
					byMode: [{ effectiveMode: null, ...group(40, 0) }],
					byRoute: [
						{ route: 'zeta', ...group(5, 0) },
						{ route: '', ...group(3, 0) },
						{ route: 'constructor', ...group(2, 0) },
						{ route: 'chatgpt', ...group(1, 0) },
					],
				}),
			})
		);

		expect(screen.getByTestId('token-proxy-usage-mode')).toHaveTextContent(
			TOKEN_PROXY_UNKNOWN_LABELS['not-recorded']
		);
		const routes = screen.getAllByTestId('token-proxy-usage-route');
		expect(routes.map((row) => row.getAttribute('data-route'))).toEqual([
			'zeta',
			'',
			'constructor',
			'chatgpt',
		]);
		expect(routes[0]).toHaveTextContent('zeta');
		expect(routes[1]).toHaveTextContent(TOKEN_PROXY_UNKNOWN_LABELS['not-recorded']);
		expect(routes[2]).toHaveTextContent('constructor');
		expect(routes[3]).toHaveTextContent('Codex with a ChatGPT login');
	});

	it('draws no cut an older desktop did not send', () => {
		card(running());

		expect(screen.queryByTestId('token-proxy-usage-mode')).not.toBeInTheDocument();
		expect(screen.queryByTestId('token-proxy-usage-route')).not.toBeInTheDocument();
	});
});

describe('evidence behind a recent compression', () => {
	const entry = {
		hash: HASH,
		originalTokens: 2_400,
		compressedTokens: 300,
		compressors: ['logs'],
		agentId: AGENT,
		at: Date.now() - 60_000,
	};
	const block = {
		hash: HASH,
		original: 'line one\nline two\nline two\nline two\n',
		compressed: 'line one\nline two\n[maestro: 2 more identical lines]\n',
		originalTokens: 2_400,
		compressedTokens: 300,
		compressors: ['logs'],
		createdAt: entry.at,
	};

	async function openRow() {
		await act(async () => {
			fireEvent.click(screen.getByTestId(`token-proxy-compression-toggle-${HASH}`));
		});
	}

	it('names the cache key, copies it, and points at the commands that print the exact original', async () => {
		vi.mocked(proxyApi().block).mockResolvedValue(block);
		card(running({ recentCompressions: [entry] }));
		await openRow();

		expect(await screen.findByTestId('token-proxy-compression-diff')).toHaveTextContent(
			'[maestro: 2 more identical lines]'
		);
		expect(screen.getByTestId('token-proxy-compression-key')).toHaveTextContent(HASH);
		const recover = screen.getByTestId('token-proxy-compression-recover');
		expect(recover).toHaveTextContent(`maestro-cli models proxy block ${HASH} --original`);
		expect(recover).toHaveTextContent('--lines 10:30');
		expect(recover).toHaveTextContent('says whether the range was complete');

		await act(async () => {
			fireEvent.click(screen.getByTestId('token-proxy-compression-copy'));
		});
		expect(safeClipboardWrite).toHaveBeenCalledWith(HASH);
	});

	it('shows the text that was sent in its place when the original is no longer stored', async () => {
		vi.mocked(proxyApi().block).mockResolvedValue({ ...block, original: null });
		card(running({ recentCompressions: [entry] }));
		await openRow();

		expect(await screen.findByTestId('token-proxy-compression-no-original')).toHaveTextContent(
			'still stored under this cache key, and is shown here'
		);
		const replacement = screen.getByTestId('token-proxy-compression-replacement');
		expect(replacement.textContent).toBe(block.compressed);
		// There is nothing to compare against, so no diff is drawn. The key is still named.
		expect(screen.queryByTestId('token-proxy-compression-diff')).not.toBeInTheDocument();
		expect(screen.getByTestId('token-proxy-compression-key')).toHaveTextContent(HASH);
	});

	it('shows replacement text as text and never as markup', async () => {
		vi.mocked(proxyApi().block).mockResolvedValue({
			...block,
			original: null,
			compressed: '<img src=x onerror=alert(1)> [maestro: elided]',
		});
		card(running({ recentCompressions: [entry] }));
		await openRow();

		const replacement = await screen.findByTestId('token-proxy-compression-replacement');
		expect(replacement.textContent).toBe('<img src=x onerror=alert(1)> [maestro: elided]');
		expect(replacement.querySelector('img')).toBeNull();
	});

	it('says the cache holds nothing, and offers no key to copy, for a block that is gone', async () => {
		card(running({ recentCompressions: [entry] }));
		await openRow();

		expect(await screen.findByTestId('token-proxy-compression-missing')).toBeInTheDocument();
		expect(screen.queryByTestId('token-proxy-compression-key')).not.toBeInTheDocument();
		expect(screen.queryByTestId('token-proxy-compression-recover')).not.toBeInTheDocument();
	});
});

describe('recovery and read opportunities since the app started', () => {
	const withObservations = (extra: Partial<TokenProxyReport> = {}) =>
		running({
			recovery: recoveryObservations({
				mcpRetrieveTool: {
					invocations: 3,
					rangedInvocations: 3,
					recoveredOriginals: 2,
					missingOriginals: 1,
					returnedOriginalBytes: 18_432,
					returnedOriginalTokenEstimate: 4_608,
				},
				otherReads: { invocations: 2, recoveredOriginals: 1, unavailableBlocks: 1 },
			}),
			readOpportunities: readOpportunities(),
			...extra,
		});

	it('stays closed and draws nothing until it is opened', () => {
		card(withObservations());

		expect(screen.getByTestId('token-proxy-observations-disclosure-toggle')).toHaveAttribute(
			'aria-expanded',
			'false'
		);
		expect(screen.queryByTestId('token-proxy-observations')).not.toBeInTheDocument();
		expect(screen.getByTestId('token-proxy-observations-disclosure')).toHaveTextContent(
			'since the app started, all agents; not part of the last 30 days'
		);
	});

	it('says the originals read back by caller, apart from the range and from any saving', () => {
		card(withObservations());
		open('token-proxy-observations-disclosure');

		const recovery = screen.getByTestId('token-proxy-recovery');
		expect(recovery).toHaveTextContent(TOKEN_PROXY_RECOVERY_HEADING);
		const lines = screen.getByTestId('token-proxy-recovery-lines');
		expect(lines).toHaveTextContent('Retrieve tool3 calls: 2 returned original text');
		expect(lines).toHaveTextContent('Other reads2 reads: 1 returned original text');
		expect(lines).toHaveTextContent('the actor is unknown');
		expect(lines).toHaveTextContent('Net savingnot evaluated');
		expect(screen.getByTestId('token-proxy-observations-disclosure')).toHaveTextContent(
			'counts as one of the other reads'
		);
	});

	it('says the read opportunities as observation, with the reasons a read could not be compared', () => {
		card(withObservations());
		open('token-proxy-observations-disclosure');

		expect(screen.getByTestId('token-proxy-opportunity-note')).toHaveTextContent(
			TOKEN_PROXY_OPPORTUNITY_NOTE
		);
		const lines = screen.getByTestId('token-proxy-opportunity-lines');
		expect(lines).toHaveTextContent(
			'412 requests examined, 38 with a read among their newest results. Passthrough requests are not read.'
		);
		expect(lines).toHaveTextContent('2 an earlier request was still being examined');
		// An unsupported read is named by its reason, not hidden in a total.
		expect(lines).toHaveTextContent('8 not comparable (outside-workspace 5, partial-range 3)');
		expect(lines).toHaveTextContent('1 refused (insufficient-reduction 1)');
		expect(lines).toHaveTextContent('2 refused (parse-error 2)');
		expect(screen.getByTestId('token-proxy-opportunity-identity')).toHaveTextContent(
			'Not available: tab, native-session, subagent, window.'
		);
		// No potential figure is called a saving.
		expect(lines.textContent).not.toMatch(/tokens saved/);
	});

	it('opens a preview to its facts and its text, and names the agent it came from', () => {
		card(withObservations());
		open('token-proxy-observations-disclosure');

		const row = screen.getByTestId('token-proxy-opportunity');
		expect(row).toHaveTextContent('Unchanged re-read');
		expect(row).toHaveTextContent('/work/app/src/a.ts');
		expect(row).toHaveTextContent('1,200 to 40 tokens (potential)');
		expect(row).toHaveTextContent('Alpha');
		expect(screen.queryByTestId('token-proxy-opportunity-detail')).not.toBeInTheDocument();

		fireEvent.click(within(row).getByTestId('token-proxy-opportunity-toggle'));

		const detail = screen.getByTestId('token-proxy-opportunity-detail');
		expect(detail).toHaveTextContent(
			'Potential1,200 to 40 tokens, so 1,160 tokens could be removed'
		);
		expect(detail).toHaveTextContent('Nothing was removed.');
		expect(detail).toHaveTextContent('DeliveryThe result went to the provider unchanged.');
		expect(screen.getByTestId('token-proxy-opportunity-text').textContent).toBe(
			'[maestro-preview unchanged-read baseline=toolu_01 sha256=3fa2c1d9e0b1 lines=120]'
		);
		expect(within(row).getByTestId('token-proxy-opportunity-toggle')).toHaveAttribute(
			'aria-expanded',
			'true'
		);
	});

	it('shows a preview as text, says when it was cut or had a secret replaced, and names an agent that was removed', () => {
		const base = readOpportunities();
		const [first] = base.recent;
		card(
			withObservations({
				readOpportunities: {
					...base,
					recent: [
						{
							...first,
							agentId: 'removed-agent-1234',
							text: '<script>alert(1)</script>',
							cut: true,
							redacted: true,
							textChars: 30_000,
						},
					],
				},
			})
		);
		open('token-proxy-observations-disclosure');

		const row = screen.getByTestId('token-proxy-opportunity');
		expect(row).toHaveTextContent('Removed agent removed-');
		fireEvent.click(within(row).getByTestId('token-proxy-opportunity-toggle'));

		const text = screen.getByTestId('token-proxy-opportunity-text');
		expect(text.textContent).toBe('<script>alert(1)</script>');
		expect(text.querySelector('script')).toBeNull();
		expect(screen.getByTestId('token-proxy-opportunity-detail')).toHaveTextContent(
			'cut at a line break for display; the whole preview is 30,000 characters; text shaped like a secret was replaced'
		);
	});

	it('says plainly that nothing has been examined, and that no preview exists yet (zero coverage)', () => {
		const base = readOpportunities();
		card(
			withObservations({
				readOpportunities: {
					...base,
					coverage: {
						...base.coverage,
						observed: 0,
						withReads: 0,
						skipped: { busy: 0, 'too-large': 0, unreadable: 0, 'no-workspace': 0, failed: 0 },
					},
					recent: [],
				},
			})
		);
		open('token-proxy-observations-disclosure');

		expect(screen.getByTestId('token-proxy-opportunity-none')).toHaveTextContent(
			'No request has been examined since the app started'
		);
		expect(screen.getByTestId('token-proxy-opportunity-no-previews')).toBeInTheDocument();
		expect(screen.queryByTestId('token-proxy-opportunity-recent')).not.toBeInTheDocument();
	});

	it('names a reason that this build does not know, as it was recorded', () => {
		const base = readOpportunities();
		card(
			withObservations({
				readOpportunities: {
					...base,
					reads: { ...base.reads, unsupportedByReason: { 'newer-route-shape': 6 } },
					coverage: {
						...base.coverage,
						skipped: { ...base.coverage.skipped, 'newer-skip': 2 } as never,
					},
				},
			})
		);
		open('token-proxy-observations-disclosure');

		const lines = screen.getByTestId('token-proxy-opportunity-lines');
		expect(lines).toHaveTextContent('(newer-route-shape 6)');
		expect(lines).toHaveTextContent('2 newer-skip');
		expect(lines.textContent).not.toMatch(/undefined/);
	});

	it('says an older desktop sent no observations, and shows none while the proxy is not set up', () => {
		const older = running();
		const view = card(older);
		open('token-proxy-observations-disclosure');
		expect(screen.getByTestId('token-proxy-observations-none')).toHaveTextContent(
			'This desktop sent no observations.'
		);
		view.unmount();

		card(
			withObservations({
				status: { port: null, running: false, agentIds: [], lastError: null, gatewayUrls: null },
				usage: null,
			})
		);
		expect(screen.queryByTestId('token-proxy-observations-disclosure')).not.toBeInTheDocument();
		expect(screen.queryByTestId('token-proxy-diagnostics')).not.toBeInTheDocument();
	});

	it('shows only the part this desktop sent', () => {
		card(withObservations({ readOpportunities: undefined }));
		open('token-proxy-observations-disclosure');

		expect(screen.getByTestId('token-proxy-recovery')).toBeInTheDocument();
		expect(screen.queryByTestId('token-proxy-opportunities')).not.toBeInTheDocument();
	});
});

describe('reads', () => {
	it('reads the report on mount and on Refresh only, keeps an open disclosure open, and never polls', async () => {
		const first = readOpportunities();
		vi.mocked(proxyApi().report).mockResolvedValue(
			running({ readOpportunities: first, recovery: recoveryObservations() })
		);
		render(<Harness />);
		await screen.findByTestId('token-proxy-usage-table');
		expect(proxyApi().report).toHaveBeenCalledTimes(1);

		open('token-proxy-diagnostics');
		open('token-proxy-observations-disclosure');
		fireEvent.click(screen.getByTestId('token-proxy-opportunity-toggle'));
		expect(proxyApi().report).toHaveBeenCalledTimes(1);

		// The same previews arrive again, as they do in a real report, with a new tally.
		const next = { ...first, coverage: { ...first.coverage, observed: 999 } };
		vi.mocked(proxyApi().report).mockResolvedValue(
			running({ readOpportunities: next, recovery: recoveryObservations() })
		);
		await act(async () => {
			fireEvent.click(screen.getByTestId('token-proxy-refresh'));
		});

		await waitFor(() =>
			expect(screen.getByTestId('token-proxy-opportunity-lines')).toHaveTextContent(
				'999 requests examined'
			)
		);
		expect(proxyApi().report).toHaveBeenCalledTimes(2);
		// Every disclosure the reader opened is still open after the new report arrived.
		expect(screen.getByTestId('token-proxy-diagnostics-lines')).toBeInTheDocument();
		expect(screen.getByTestId('token-proxy-opportunity-detail')).toBeInTheDocument();

		vi.useFakeTimers();
		await act(async () => {
			vi.advanceTimersByTime(3_600_000);
		});
		expect(proxyApi().report).toHaveBeenCalledTimes(2);
	});

	it('does not read the report when a diff is opened; the count it adds shows after Refresh', async () => {
		vi.mocked(proxyApi().report).mockResolvedValue(
			running({
				recentCompressions: [
					{
						hash: HASH,
						originalTokens: 2_400,
						compressedTokens: 300,
						compressors: ['logs'],
						agentId: AGENT,
						at: Date.now() - 60_000,
					},
				],
				recovery: recoveryObservations(),
			})
		);
		vi.mocked(proxyApi().block).mockResolvedValue({
			hash: HASH,
			original: 'a\nb\n',
			compressed: 'a\n',
			originalTokens: 2,
			compressedTokens: 1,
			compressors: ['logs'],
			createdAt: Date.now(),
		});
		render(<Harness />);
		await screen.findByTestId('token-proxy-usage-table');

		await act(async () => {
			fireEvent.click(await screen.findByTestId(`token-proxy-compression-toggle-${HASH}`));
		});

		await screen.findByTestId('token-proxy-compression-diff');
		expect(proxyApi().block).toHaveBeenCalledTimes(1);
		expect(proxyApi().report).toHaveBeenCalledTimes(1);
	});

	it('shows a read that failed, and keeps the evidence it already had', async () => {
		render(<Harness />);
		await screen.findByTestId('token-proxy-usage-table');
		open('token-proxy-diagnostics');
		vi.mocked(proxyApi().report).mockRejectedValue(new Error('bridge closed'));

		await act(async () => {
			fireEvent.click(screen.getByTestId('token-proxy-refresh'));
		});

		expect(await screen.findByTestId('token-proxy-error')).toHaveTextContent('bridge closed');
		expect(screen.getByTestId('token-proxy-diagnostics-lines')).toBeInTheDocument();
	});
});
