// Source: src/__tests__/cli/commands/stats-indexing.test.ts
// Source: src/__tests__/cli/commands/stats-usage.test.ts
// Source: src/__tests__/cli/commands/session.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { statsIndexing } from '../../../cli/commands/stats';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { EMPTY_STATS_INDEXING_STATE } from '../../../shared/statsIndexing';
import { STATS_INDEXING_VISIBLE_MIN_FILES } from '../../../shared/statsIndexing';
import type { StatsIndexingState } from '../../../shared/statsIndexing';
import path from 'path';
import { stats } from '../../../cli/commands/stats';
import { statsActivity } from '../../../cli/commands/stats';
import { statsAgents } from '../../../cli/commands/stats';
import { statsCue } from '../../../cli/commands/stats';
import { statsDelegation } from '../../../cli/commands/stats';
import { statsExport } from '../../../cli/commands/stats';
import { statsPlanUsage } from '../../../cli/commands/stats';
import { MaestroNotRunningError } from '../../../cli/services/maestro-not-running';
import { MAESTRO_NOT_RUNNING_MESSAGE } from '../../../cli/services/maestro-not-running';
import { sessionList } from '../../../cli/commands/session';
import { sessionShow } from '../../../cli/commands/session';
vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));
describeSourceSuite('stats-indexing', () => {
	const scanning: StatsIndexingState = {
		jobs: [
			{
				id: 'global-stats',
				label: 'Usage totals',
				reason: 'upgrade',
				doneFiles: 10,
				totalFiles: STATS_INDEXING_VISIBLE_MIN_FILES * 2,
				doneBytes: 512,
				totalBytes: 2048,
				startedAt: Date.now(),
				updatedAt: Date.now(),
				surfaced: true,
			},
		],
	};

	/** Reply to each `get_stats_indexing` with the next state in `states`. */
	function replyWith(...states: StatsIndexingState[]) {
		const sendCommand = vi.fn();
		for (const state of states) {
			sendCommand.mockResolvedValueOnce({ type: 'stats_indexing', data: state });
		}
		sendCommand.mockResolvedValue({ type: 'stats_indexing', data: states.at(-1) });
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({ sendCommand } as never)
		);
		return sendCommand;
	}

	describe('stats-indexing command', () => {
		let log: MockInstance;
		let exit: MockInstance;

		beforeEach(() => {
			vi.clearAllMocks();
			log = vi.spyOn(console, 'log').mockImplementation(() => {});
			exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		});

		afterEach(() => {
			log.mockRestore();
			exit.mockRestore();
		});

		it('says so when nothing is scanning', async () => {
			const send = replyWith(EMPTY_STATS_INDEXING_STATE);
			await statsIndexing({});
			expect(send).toHaveBeenCalledWith({ type: 'get_stats_indexing' }, 'stats_indexing');
			expect(log).toHaveBeenCalledWith('No usage data scan is running.');
		});

		it('prints the same summary the modal shows', async () => {
			replyWith(scanning);
			await statsIndexing({});
			const line = log.mock.calls[0][0] as string;
			expect(line).toContain('Upgrading usage data: 25%');
			expect(line).toContain('10 of 50 transcripts');
			expect(line).toContain('Usage totals');
		});

		it('emits JSON for scripts', async () => {
			replyWith(scanning);
			await statsIndexing({ json: true });
			const output = JSON.parse(log.mock.calls[0][0] as string);
			expect(output.running).toBe(true);
			expect(output.summary.fraction).toBeCloseTo(0.25);
		});

		it('--wait returns once the scan has finished', async () => {
			vi.useFakeTimers();
			try {
				const send = replyWith(scanning, EMPTY_STATS_INDEXING_STATE);
				const done = statsIndexing({ wait: true, json: true });
				await vi.advanceTimersByTimeAsync(1000);
				await done;
				expect(send).toHaveBeenCalledTimes(2);
				expect(JSON.parse(log.mock.calls.at(-1)![0] as string).running).toBe(false);
				expect(exit).not.toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
			}
		});

		it('--wait exits non-zero when it times out mid-scan', async () => {
			vi.useFakeTimers();
			try {
				replyWith(scanning);
				const done = statsIndexing({ wait: true, timeout: '1', json: true });
				await vi.advanceTimersByTimeAsync(2000);
				await done;
				expect(exit).toHaveBeenCalledWith(1);
			} finally {
				vi.useRealTimers();
			}
		});
	});
});
describeSourceSuite('stats-usage', () => {
	/** Answer every bridge message with `reply`. */
	function replyWith(reply: Record<string, unknown>) {
		const sendCommand = vi.fn().mockResolvedValue(reply);
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({ sendCommand } as never)
		);
		return sendCommand;
	}

	const slice = (count: number, durationMs: number) => ({ count, durationMs });

	describe('stats usage verbs', () => {
		let log: MockInstance;
		let error: MockInstance;
		let exit: MockInstance;

		beforeEach(() => {
			vi.clearAllMocks();
			log = vi.spyOn(console, 'log').mockImplementation(() => {});
			error = vi.spyOn(console, 'error').mockImplementation(() => {});
			exit = vi.spyOn(process, 'exit').mockImplementation((() => {
				throw new Error('exit');
			}) as never);
		});

		afterEach(() => {
			log.mockRestore();
			error.mockRestore();
			exit.mockRestore();
		});

		const output = () => log.mock.calls.map((call) => String(call[0])).join('\n');

		describe('stats', () => {
			it('labels distinct agents as active agents and prints the window and streak', async () => {
				replyWith({
					type: 'stats_aggregation',
					data: {
						totalQueries: 1200,
						totalSessions: 9,
						avgDuration: 95_000,
						bySource: { user: 1000, auto: 200 },
						byAgent: { 'claude-code': { count: 1200, duration: 1 } },
						window: { startYmd: '2026-11-08', endYmd: '2026-11-14' },
						streak: { current: 4, longest: 30 },
					},
				});
				await stats({});
				const text = output();
				expect(text).toContain('Range:           Nov 8, 2026 - Nov 14, 2026');
				expect(text).toContain('Active agents:   9');
				expect(text).not.toContain('Total sessions');
				expect(text).toContain('Avg duration:    1m 35s');
				expect(text).toContain('Streak:          4 days current, 30 longest');
				expect(text).toContain('Total queries:   1,200');
			});
		});

		describe('stats-delegation', () => {
			it('sends the range and prints the split and the active days', async () => {
				const send = replyWith({
					type: 'delegation_stats',
					data: {
						range: 'week',
						window: { startYmd: '2026-11-08', endYmd: '2026-11-14' },
						totals: {
							interactive: slice(10, 60_000),
							autoRun: slice(2, 120_000),
							cue: slice(1, 0),
						},
						percent: 66.6,
						byDay: [
							{
								date: '2026-11-08',
								interactive: slice(0, 0),
								autoRun: slice(0, 0),
								cue: slice(0, 0),
							},
							{
								date: '2026-11-13',
								interactive: slice(10, 60_000),
								autoRun: slice(2, 120_000),
								cue: slice(1, 0),
							},
						],
					},
				});
				await statsDelegation({ range: 'week' });
				expect(send).toHaveBeenCalledWith(
					{ type: 'get_delegation_stats', range: 'week' },
					'delegation_stats',
					undefined
				);
				const text = output();
				expect(text).toContain('Delegated:       67% of tracked time');
				expect(text).toContain('Nov 13, 2026: 10 interactive / 2 Auto Run / 1 Cue');
				expect(text).not.toContain('Nov 8, 2026:');
			});

			it('exits on an invalid range without contacting the app', async () => {
				const send = replyWith({});
				await expect(statsDelegation({ range: 'fortnight', json: true })).rejects.toThrow('exit');
				expect(send).not.toHaveBeenCalled();
				expect(String(error.mock.calls[0][0])).toContain('Invalid range');
			});

			it('fails on an error frame instead of printing an empty result', async () => {
				replyWith({ type: 'error', message: 'Database not initialized' });
				await expect(statsDelegation({ json: true })).rejects.toThrow('exit');
				expect(JSON.parse(String(error.mock.calls[0][0]))).toEqual({
					error: 'Database not initialized',
				});
			});
		});

		describe('stats-cue', () => {
			it('forwards trigger exclusions and prints totals and breakdowns', async () => {
				const totals = {
					occurrences: 5,
					successCount: 4,
					failureCount: 1,
					totalDurationMs: 300_000,
					totalInputTokens: 1000,
					totalOutputTokens: 2000,
					totalCacheReadTokens: 0,
					totalCacheCreationTokens: 0,
					totalCostUsd: 1.5,
				};
				const send = replyWith({
					type: 'cue_stats',
					data: {
						totals,
						durationPercentiles: {
							count: 5,
							min: 1,
							p50: 60_000,
							p75: 1,
							p90: 120_000,
							p95: 1,
							p99: 1,
							max: 180_000,
						},
						byPipeline: [{ key: 'p', label: 'Nightly', totals }],
						byAgent: [],
						byTriggerType: [],
						excludedTriggerTypes: ['time.heartbeat'],
						coverageWarnings: ['Codex sessions report partial token coverage'],
					},
				});
				await statsCue({ range: 'month', excludeTrigger: ['time.heartbeat'] });
				expect(send).toHaveBeenCalledWith(
					{ type: 'get_cue_stats', range: 'month', excludeTriggerTypes: ['time.heartbeat'] },
					'cue_stats',
					120_000
				);
				const text = output();
				expect(text).toContain('Runs:            5 (4 ok / 1 failed)');
				expect(text).toContain('Cost:            $1.50');
				expect(text).toContain('Nightly: 5 runs');
				expect(text).toContain('Excluded:        time.heartbeat');
				expect(text).toContain('Note: Codex sessions report partial token coverage');
			});
		});

		describe('stats-plan-usage', () => {
			const account = {
				provider: 'codex',
				accountKey: '/home/me/.codex',
				email: 'me@example.com',
				plan: 'pro',
				authState: 'authenticated',
				sampledAt: '2026-11-14T10:00:00.000Z',
				stale: true,
				windows: [{ name: 'Weekly', percent: 50, resetsAt: '2026-11-18' }],
				resetCreditsAvailable: 2,
			};

			it('prints each account with its windows, filtered by --provider', async () => {
				const send = replyWith({ type: 'plan_usage', data: { claude: [], codex: [account] } });
				await statsPlanUsage({ provider: 'codex' });
				expect(send).toHaveBeenCalledWith({ type: 'get_plan_usage' }, 'plan_usage', undefined);
				const text = output();
				expect(text).toContain('OpenAI Usage (Codex)');
				expect(text).not.toContain('Anthropic Usage');
				expect(text).toContain('/home/me/.codex (me@example.com, pro) [stale]');
				expect(text).toContain('Weekly: 50% used, resets 2026-11-18');
				expect(text).toContain('Reset credits: 2 available');
			});

			it('emits both providers as JSON', async () => {
				replyWith({ type: 'plan_usage', data: { claude: [], codex: [account] } });
				await statsPlanUsage({ json: true });
				expect(JSON.parse(output())).toEqual({ claude: [], codex: [account] });
			});

			it('rejects an unknown provider', async () => {
				replyWith({});
				await expect(statsPlanUsage({ provider: 'gemini' })).rejects.toThrow('exit');
			});
		});

		describe('stats-agents', () => {
			it('prints the agent count trend', async () => {
				replyWith({
					type: 'agent_count_stats',
					data: {
						range: 'week',
						liveAgents: 6,
						created: 2,
						removed: 1,
						points: [
							{ date: '2026-11-13', count: 5 },
							{ date: '2026-11-14', count: 6 },
						],
					},
				});
				await statsAgents({ range: 'week' });
				const text = output();
				expect(text).toContain('Agents now:      6');
				expect(text).toContain('Nov 13, 2026 - Nov 14, 2026, 5 -> 6 agents');
				expect(text).toContain('Created:         2');
				expect(text).toContain('Deleted:         1');
				expect(text).toContain('Nov 14, 2026: 6');
			});
		});

		describe('stats-activity', () => {
			it('prints totals and the days with activity', async () => {
				replyWith({
					type: 'activity_stats',
					data: {
						range: 'week',
						window: { startYmd: '2026-11-08', endYmd: '2026-11-14' },
						totals: {
							autoRuns: 3,
							autoRunGoalRuns: 1,
							autoRunUnfinished: 0,
							autoRunDurationMs: 600_000,
							autoRunTasksTotal: 10,
							autoRunTasksCompleted: 8,
							autoRunSuccessRate: 80,
							wizardRuns: 2,
							wizardRunsGenerated: 1,
							wizardDocuments: 3,
							wizardTasks: 12,
							wizardActiveMs: 120_000,
							resilienceEvents: 1,
							resilienceRecovered: 1,
							resilienceRetries: 4,
							shortcutPresses: 42,
						},
						byShortcut: [{ shortcutId: 'toggleSidebar', count: 9 }],
						autoRunTurnsByHour: [{ hour: 9, count: 5, successCount: 4 }],
						byDay: [
							{
								date: '2026-11-12',
								autoRuns: 3,
								autoRunTasksCompleted: 8,
								wizardRuns: 0,
								resilienceEvents: 0,
								shortcutPresses: 0,
							},
						],
					},
				});
				await statsActivity({});
				const text = output();
				expect(text).toContain(
					'Auto Runs:       3 (1 goal, 0 unfinished), 10m 0s, 8 of 10 tasks done (80%)'
				);
				expect(text).toContain('Most used shortcuts: toggleSidebar 9');
				expect(text).toContain('Agent turns by hour: 9 AM 5');
				expect(text).toContain('Resilience:      1 outages (1 recovered), 4 retries');
				expect(text).toContain('Shortcuts:       42 presses');
				expect(text).toContain('Nov 12, 2026: 3 Auto Runs');
			});
		});

		describe('stats-export', () => {
			it('resolves --output against the current directory and sends the export', async () => {
				const send = replyWith({
					type: 'stats_export_result',
					data: {
						path: '/abs/usage.zip',
						format: 'csv',
						rowCounts: { 'query-events': 12 },
						notes: ['Cue keeps 14 days of run history, so older Cue runs are not included.'],
					},
				});
				await statsExport({ output: 'usage.zip', range: 'month' });
				expect(send).toHaveBeenCalledWith(
					{
						type: 'stats_export',
						range: 'month',
						format: 'csv',
						path: path.resolve(process.cwd(), 'usage.zip'),
					},
					'stats_export_result',
					600_000
				);
				const text = output();
				expect(text).toContain('Exported usage data (csv, month) to /abs/usage.zip');
				expect(text).toContain('query-events: 12 rows');
				expect(text).toContain('Note: Cue keeps 14 days');
			});

			it('rejects an unknown format before contacting the app', async () => {
				const send = replyWith({});
				await expect(statsExport({ output: 'x.xml', format: 'xml' })).rejects.toThrow('exit');
				expect(send).not.toHaveBeenCalled();
			});
		});
	});
});
describeSourceSuite('session', () => {
	describe('session list command', () => {
		let consoleSpy: MockInstance;
		let processExitSpy: MockInstance;

		beforeEach(() => {
			vi.clearAllMocks();
			consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
			processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		});

		it('sends list_desktop_sessions and emits JSON with the desktop-supplied entries', async () => {
			const mockSendCommand = vi.fn().mockResolvedValue({
				type: 'desktop_sessions_list',
				success: true,
				sessions: [
					{
						tabId: 'tab-1',
						sessionId: 'tab-1',
						agentId: 'agent-a',
						agentName: 'Backend',
						toolType: 'claude-code',
						name: 'Refactor parser',
						agentSessionId: 'claude-uuid-1',
						state: 'idle',
						createdAt: 1714268000000,
						starred: false,
					},
				],
			});
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = { sendCommand: mockSendCommand };
				return action(mockClient as never);
			});

			await sessionList({ json: true });

			expect(mockSendCommand).toHaveBeenCalledWith(
				{ type: 'list_desktop_sessions' },
				'desktop_sessions_list'
			);

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.success).toBe(true);
			expect(output.sessions).toHaveLength(1);
			expect(output.sessions[0].tabId).toBe('tab-1');
			expect(output.sessions[0].agentId).toBe('agent-a');
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('returns an empty array when the desktop reports no open tabs', async () => {
			const mockSendCommand = vi.fn().mockResolvedValue({
				type: 'desktop_sessions_list',
				success: true,
				sessions: [],
			});
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = { sendCommand: mockSendCommand };
				return action(mockClient as never);
			});

			await sessionList({ json: true });

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.sessions).toEqual([]);
		});

		describe('hidden tabs (#2008)', () => {
			const entries = [
				{ tabId: 'tab-visible', agentId: 'agent-a', agentName: 'Backend', hidden: false },
				{ tabId: 'tab-consult', agentId: 'agent-a', agentName: 'Backend', hidden: true },
				// An older desktop omits the field; that tab is not hidden.
				{ tabId: 'tab-legacy', agentId: 'agent-a', agentName: 'Backend' },
			];
			const mockDesktop = () => {
				const mockSendCommand = vi.fn().mockResolvedValue({
					type: 'desktop_sessions_list',
					success: true,
					sessions: entries,
				});
				vi.mocked(withMaestroClient).mockImplementation(async (action) => {
					const mockClient = { sendCommand: mockSendCommand };
					return action(mockClient as never);
				});
			};

			it('leaves hidden tabs out by default', async () => {
				mockDesktop();
				await sessionList({ json: true });
				const output = JSON.parse(consoleSpy.mock.calls[0][0]);
				expect(output.sessions.map((s: { tabId: string }) => s.tabId)).toEqual([
					'tab-visible',
					'tab-legacy',
				]);
			});

			it('lists hidden tabs, flagged, with --include-hidden', async () => {
				mockDesktop();
				await sessionList({ json: true, includeHidden: true });
				const output = JSON.parse(consoleSpy.mock.calls[0][0]);
				expect(output.sessions.map((s: { tabId: string }) => s.tabId)).toEqual([
					'tab-visible',
					'tab-consult',
					'tab-legacy',
				]);
				expect(output.sessions[1].hidden).toBe(true);
			});
		});

		it('renders a human-readable table when --json is omitted', async () => {
			const mockSendCommand = vi.fn().mockResolvedValue({
				type: 'desktop_sessions_list',
				success: true,
				sessions: [
					{
						tabId: 'tab-1',
						sessionId: 'tab-1',
						agentId: 'agent-a',
						agentName: 'Backend',
						toolType: 'claude-code',
						name: null,
						agentSessionId: null,
						state: 'busy',
						createdAt: 1714268000000,
						starred: true,
					},
				],
			});
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = { sendCommand: mockSendCommand };
				return action(mockClient as never);
			});

			await sessionList({});

			// Default text mode includes state, star, tabId, agent name+id, and a
			// relative createdAt column. Asserting each surface independently catches
			// regressions where any column is dropped without freezing exact spacing.
			const line = consoleSpy.mock.calls[0][0] as string;
			expect(line).toContain('tab-1');
			expect(line).toContain('Backend');
			expect(line).toContain('busy');
			expect(line).toContain('★');
			// createdAt rendered via formatRelativeTime - the exact phrase depends on
			// `now`, but the column is non-empty for any finite epoch.
			expect(line.split('  ').filter(Boolean).length).toBeGreaterThanOrEqual(4);
		});

		describe('visible / hidden / orphaned scope (#2008)', () => {
			const tab = (
				tabId: string,
				visibility?: 'visible' | 'hidden' | 'orphaned',
				hiddenReason: string | null = null
			) => ({
				tabId,
				sessionId: tabId,
				agentId: 'agent-a',
				agentName: 'Backend',
				toolType: 'claude-code',
				name: tabId,
				agentSessionId: null,
				state: 'idle',
				createdAt: 1714268000000,
				starred: false,
				...(visibility === undefined
					? {}
					: { hidden: visibility === 'hidden', hiddenReason, visibility }),
			});
			const stripTab = (tabId: string, tabType: string, visibility: string, target: string) => ({
				tabId,
				tabType,
				agentId: 'agent-a',
				agentName: 'Backend',
				name: tabId,
				target,
				active: false,
				visibility,
			});
			const mockList = (sessions: unknown[], tabs?: unknown[]) => {
				const mockSendCommand = vi.fn().mockResolvedValue({
					type: 'desktop_sessions_list',
					success: true,
					sessions,
					...(tabs ? { tabs } : {}),
				});
				vi.mocked(withMaestroClient).mockImplementation(async (action) =>
					action({ sendCommand: mockSendCommand } as never)
				);
				return mockSendCommand;
			};
			const fleet = [
				tab('visible-1', 'visible'),
				tab('consult-1', 'hidden', 'consult'),
				tab('dispatch-1', 'hidden', 'background'),
				tab('closed-1', 'orphaned'),
				// A desktop that predates the field: treated as visible.
				tab('legacy-1'),
			];
			const strip = [
				stripTab('file-1', 'file', 'visible', '/repo/README.md'),
				stripTab('web-1', 'browser', 'visible', 'https://example.test/'),
				stripTab('term-1', 'terminal', 'orphaned', '/repo'),
			];

			it('lists only the tabs the tab strips draw by default, and counts the rest', async () => {
				mockList(fleet);
				await sessionList({ json: true });
				const output = JSON.parse(consoleSpy.mock.calls[0][0]);
				expect(output.scope).toBe('visible');
				expect(output.type).toBe('ai');
				expect(output.sessions.map((s: { tabId: string }) => s.tabId)).toEqual([
					'visible-1',
					'legacy-1',
				]);
				expect(output.counts).toEqual({ visible: 2, hidden: 2, orphaned: 1 });
				expect(output).not.toHaveProperty('tabs');
			});

			it('flags a desktop that does not report visibility', async () => {
				mockList([tab('legacy-1'), tab('legacy-2')]);
				await sessionList({ json: true });
				const output = JSON.parse(consoleSpy.mock.calls[0][0]);
				expect(output.visibilityReported).toBe(false);
				expect(output.sessions).toHaveLength(2);

				consoleSpy.mockClear();
				mockList(fleet);
				await sessionList({ json: true });
				expect(JSON.parse(consoleSpy.mock.calls[0][0]).visibilityReported).toBe(true);
			});

			it('--hidden lists only hidden tabs; --include-hidden adds them to the visible ones', async () => {
				mockList(fleet);
				await sessionList({ json: true, hidden: true });
				let output = JSON.parse(consoleSpy.mock.calls[0][0]);
				expect(output.scope).toBe('hidden');
				expect(output.sessions.map((s: { tabId: string }) => s.tabId)).toEqual([
					'consult-1',
					'dispatch-1',
				]);

				consoleSpy.mockClear();
				mockList(fleet);
				await sessionList({ json: true, includeHidden: true });
				output = JSON.parse(consoleSpy.mock.calls[0][0]);
				expect(output.scope).toBe('visible+hidden');
				expect(output.sessions.map((s: { tabId: string }) => s.tabId)).not.toContain('closed-1');
				expect(output.sessions).toHaveLength(4);
			});

			it('--all lists every tab, orphans included', async () => {
				mockList(fleet);
				await sessionList({ json: true, all: true });
				const output = JSON.parse(consoleSpy.mock.calls[0][0]);
				expect(output.scope).toBe('all');
				expect(output.sessions).toHaveLength(5);
				expect(
					output.sessions.find((s: { tabId: string }) => s.tabId === 'closed-1').visibility
				).toBe('orphaned');
			});

			it('--type all adds file, browser and terminal tabs under "tabs"', async () => {
				mockList(fleet, strip);
				await sessionList({ json: true, type: 'all' });
				const output = JSON.parse(consoleSpy.mock.calls[0][0]);
				expect(output.sessions.map((s: { tabId: string }) => s.tabId)).toEqual([
					'visible-1',
					'legacy-1',
				]);
				expect(output.tabs.map((t: { tabId: string }) => t.tabId)).toEqual(['file-1', 'web-1']);
				expect(output.counts).toEqual({ visible: 4, hidden: 2, orphaned: 2 });
			});

			it('--type file lists only file tabs and no AI tabs', async () => {
				mockList(fleet, strip);
				await sessionList({ json: true, type: 'file' });
				const output = JSON.parse(consoleSpy.mock.calls[0][0]);
				expect(output.sessions).toEqual([]);
				expect(output.tabs).toEqual([strip[0]]);
				expect(output.counts).toEqual({ visible: 1, hidden: 0, orphaned: 0 });
			});

			it('refuses a non-AI --type against a desktop that does not report those tabs', async () => {
				mockList(fleet);
				await sessionList({ json: true, type: 'terminal' });
				expect(JSON.parse(consoleSpy.mock.calls[0][0]).code).toBe('UNSUPPORTED');
				expect(processExitSpy).toHaveBeenCalledWith(1);
			});

			it('rejects an unknown --type before contacting the desktop', async () => {
				const send = mockList(fleet);
				await sessionList({ json: true, type: 'tiles' });
				expect(send).not.toHaveBeenCalled();
				expect(JSON.parse(consoleSpy.mock.calls[0][0]).code).toBe('INVALID_OPTION');
			});

			it('marks hidden and orphaned rows and names what was left out in text mode', async () => {
				mockList(fleet, strip);
				await sessionList({ all: true, type: 'all' });
				const lines = consoleSpy.mock.calls.map((c) => c[0] as string);
				expect(lines.find((l) => l.includes('consult-1'))).toContain('[hidden]');
				expect(lines.find((l) => l.includes('closed-1'))).toContain('[orphaned');
				expect(lines.find((l) => l.includes('visible-1'))).not.toContain('[');
				expect(lines.find((l) => l.includes('web-1'))).toContain('https://example.test/');
				expect(lines.find((l) => l.includes('term-1'))).toMatch(/^terminal .*\[orphaned/);

				consoleSpy.mockClear();
				mockList(fleet);
				await sessionList({});
				const footer = consoleSpy.mock.calls.at(-1)?.[0] as string;
				expect(footer).toContain('2 hidden, 1 orphaned not shown');
				expect(footer).toContain('--include-hidden');
			});

			it('rejects more than one scope flag before contacting the desktop', async () => {
				const send = mockList(fleet);
				await sessionList({ json: true, includeHidden: true, all: true });
				expect(send).not.toHaveBeenCalled();
				expect(JSON.parse(consoleSpy.mock.calls[0][0]).code).toBe('INVALID_OPTION');
				expect(processExitSpy).toHaveBeenCalledWith(1);
			});
		});

		it('preserves an unknown desktop state in human-readable output', async () => {
			const mockSendCommand = vi.fn().mockResolvedValue({
				type: 'desktop_sessions_list',
				success: true,
				sessions: [
					{
						tabId: 'tab-unknown',
						sessionId: 'tab-unknown',
						agentId: 'agent-a',
						agentName: 'Backend',
						toolType: 'claude-code',
						name: null,
						agentSessionId: null,
						state: 'unknown',
						createdAt: 1714268000000,
						starred: false,
					},
				],
			});
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = { sendCommand: mockSendCommand };
				return action(mockClient as never);
			});

			await sessionList({});

			expect(consoleSpy.mock.calls[0][0]).toContain('unknown');
		});

		it.each([
			['no-discovery-file'],
			['stale-discovery-file'],
			['connect-timeout'],
			['connect-failed'],
		] as const)(
			'maps a %s MaestroNotRunningError to MAESTRO_NOT_RUNNING, exit 3',
			async (reason) => {
				// Same outcome dispatch reports, so external scripts can branch on one
				// code and one exit status whichever verb they used.
				vi.mocked(withMaestroClient).mockRejectedValue(new MaestroNotRunningError(reason));

				await sessionList({ json: true });

				const output = JSON.parse(consoleSpy.mock.calls[0][0]);
				expect(output).toEqual({
					success: false,
					error: MAESTRO_NOT_RUNNING_MESSAGE,
					code: 'MAESTRO_NOT_RUNNING',
				});
				expect(processExitSpy.mock.calls[0]).toEqual([3]);
			}
		);

		it('keeps an ordinary error as COMMAND_FAILED, exit 1', async () => {
			vi.mocked(withMaestroClient).mockRejectedValue(new Error('ECONNREFUSED'));

			await sessionList({ json: true });

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.code).toBe('COMMAND_FAILED');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
	});

	describe('session show command', () => {
		let consoleSpy: MockInstance;
		let processExitSpy: MockInstance;

		beforeEach(() => {
			vi.clearAllMocks();
			consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
			processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		});

		it('sends get_session_history with the tab id and prints JSON when --json is set', async () => {
			const mockSendCommand = vi.fn().mockResolvedValue({
				type: 'session_history_result',
				success: true,
				tabId: 'tab-1',
				sessionId: 'tab-1',
				agentId: 'agent-a',
				agentSessionId: 'claude-uuid-1',
				messages: [
					{
						id: 'log-1',
						role: 'user',
						source: 'user',
						content: 'Hello',
						timestamp: '2026-04-28T10:00:00.000Z',
					},
					{
						id: 'log-2',
						role: 'assistant',
						source: 'ai',
						content: 'Hi there',
						timestamp: '2026-04-28T10:00:01.000Z',
					},
				],
			});
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = { sendCommand: mockSendCommand };
				return action(mockClient as never);
			});

			await sessionShow('tab-1', { json: true });

			expect(mockSendCommand).toHaveBeenCalledWith(
				{ type: 'get_session_history', tabId: 'tab-1' },
				'session_history_result'
			);

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.success).toBe(true);
			expect(output.tabId).toBe('tab-1');
			expect(output.messages).toHaveLength(2);
			expect(output.messages[0].role).toBe('user');
			expect(output.messages[1].role).toBe('assistant');
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('renders a formatted transcript by default (no --json flag)', async () => {
			// Default text mode prints a header line followed by one block per
			// message. ISO timestamps are emitted verbatim so callers can feed them
			// back into `--since` without re-parsing.
			const mockSendCommand = vi.fn().mockResolvedValue({
				type: 'session_history_result',
				success: true,
				tabId: 'tab-1',
				sessionId: 'tab-1',
				agentId: 'agent-a',
				agentSessionId: 'claude-uuid-1',
				messages: [
					{
						id: 'log-1',
						role: 'user',
						source: 'user',
						content: 'Hello',
						timestamp: '2026-04-28T10:00:00.000Z',
					},
					{
						id: 'log-2',
						role: 'assistant',
						source: 'ai',
						content: 'Hi there',
						timestamp: '2026-04-28T10:00:01.000Z',
					},
				],
			});
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = { sendCommand: mockSendCommand };
				return action(mockClient as never);
			});

			await sessionShow('tab-1', {});

			const lines = consoleSpy.mock.calls.map((c) => c[0] as string);
			const joined = lines.join('\n');
			// Header
			expect(joined).toContain('Tab: tab-1');
			expect(joined).toContain('Agent: agent-a');
			expect(joined).toContain('Session: claude-uuid-1');
			expect(joined).toContain('Messages: 2');
			// Per-message blocks with verbatim ISO timestamps + roles + content
			expect(joined).toContain('[2026-04-28T10:00:00.000Z] user');
			expect(joined).toContain('Hello');
			expect(joined).toContain('[2026-04-28T10:00:01.000Z] assistant');
			expect(joined).toContain('Hi there');
			// Should not be a single JSON blob
			expect(() => JSON.parse(lines[0])).toThrow();
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('prints a friendly placeholder when the conversation is empty (text mode)', async () => {
			const mockSendCommand = vi.fn().mockResolvedValue({
				type: 'session_history_result',
				success: true,
				tabId: 'tab-1',
				sessionId: 'tab-1',
				agentId: 'agent-a',
				agentSessionId: null,
				messages: [],
			});
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = { sendCommand: mockSendCommand };
				return action(mockClient as never);
			});

			await sessionShow('tab-1', {});

			const joined = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
			expect(joined).toContain('Messages: 0');
			expect(joined).toContain('(no messages)');
		});

		it('forwards --since as ms epoch when given an ISO timestamp', async () => {
			const mockSendCommand = vi.fn().mockResolvedValue({
				type: 'session_history_result',
				success: true,
				tabId: 'tab-1',
				sessionId: 'tab-1',
				agentId: 'agent-a',
				agentSessionId: null,
				messages: [],
			});
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = { sendCommand: mockSendCommand };
				return action(mockClient as never);
			});

			await sessionShow('tab-1', { since: '2026-04-28T10:00:00.000Z' });

			expect(mockSendCommand).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'get_session_history',
					tabId: 'tab-1',
					sinceMs: Date.parse('2026-04-28T10:00:00.000Z'),
				}),
				'session_history_result'
			);
		});

		it('treats a numeric --since below 1e12 as seconds (matches Date.now()/1000 cursors)', async () => {
			// Heuristic protection: a Discord bot pickling a `Math.floor(Date.now() /
			// 1000)` cursor would otherwise filter the entire transcript out (every
			// log timestamp is ms, so the seconds value would be ~1000x too small
			// and pass the > comparison trivially). Auto-scaling matches both
			// cursor styles without requiring explicit unit flags.
			const mockSendCommand = vi.fn().mockResolvedValue({
				type: 'session_history_result',
				success: true,
				tabId: 'tab-1',
				sessionId: 'tab-1',
				agentId: 'agent-a',
				agentSessionId: null,
				messages: [],
			});
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = { sendCommand: mockSendCommand };
				return action(mockClient as never);
			});

			await sessionShow('tab-1', { since: '1714268000' });

			expect(mockSendCommand).toHaveBeenCalledWith(
				expect.objectContaining({ sinceMs: 1714268000 * 1000 }),
				'session_history_result'
			);
		});

		it('treats a numeric --since at or above 1e12 as ms', async () => {
			const mockSendCommand = vi.fn().mockResolvedValue({
				type: 'session_history_result',
				success: true,
				tabId: 'tab-1',
				sessionId: 'tab-1',
				agentId: 'agent-a',
				agentSessionId: null,
				messages: [],
			});
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = { sendCommand: mockSendCommand };
				return action(mockClient as never);
			});

			await sessionShow('tab-1', { since: '1714268000000' });

			expect(mockSendCommand).toHaveBeenCalledWith(
				expect.objectContaining({ sinceMs: 1714268000000 }),
				'session_history_result'
			);
		});

		it('rejects an unparseable --since with INVALID_OPTION', async () => {
			await sessionShow('tab-1', { since: 'not-a-date' });

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.success).toBe(false);
			expect(output.code).toBe('INVALID_OPTION');
			expect(processExitSpy).toHaveBeenCalledWith(1);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});

		it('forwards --tail as an integer to the desktop', async () => {
			const mockSendCommand = vi.fn().mockResolvedValue({
				type: 'session_history_result',
				success: true,
				tabId: 'tab-1',
				sessionId: 'tab-1',
				agentId: 'agent-a',
				agentSessionId: null,
				messages: [],
			});
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = { sendCommand: mockSendCommand };
				return action(mockClient as never);
			});

			await sessionShow('tab-1', { tail: '5' });

			expect(mockSendCommand).toHaveBeenCalledWith(
				expect.objectContaining({ type: 'get_session_history', tabId: 'tab-1', tail: 5 }),
				'session_history_result'
			);
		});

		it('rejects a negative --tail with INVALID_OPTION', async () => {
			await sessionShow('tab-1', { tail: '-1' });

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.success).toBe(false);
			expect(output.code).toBe('INVALID_OPTION');
			expect(processExitSpy).toHaveBeenCalledWith(1);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});

		it.each([['5abc'], ['1.9'], ['5e2'], ['  '], ['']])(
			'rejects partially-numeric --tail %p with INVALID_OPTION (no silent truncation)',
			async (raw) => {
				// `Number.parseInt('5abc', 10) === 5` and `parseInt('1.9', 10) === 1`
				// silently accept these as valid tails - the strict regex precheck
				// is the only thing keeping a typo from quietly capping history at
				// the wrong number.
				await sessionShow('tab-1', { tail: raw });

				const output = JSON.parse(consoleSpy.mock.calls[0][0]);
				expect(output.success).toBe(false);
				expect(output.code).toBe('INVALID_OPTION');
				expect(processExitSpy).toHaveBeenCalledWith(1);
				expect(withMaestroClient).not.toHaveBeenCalled();
			}
		);

		it('forwards --tail 0 as numeric 0 (handler enforces empty-history semantics)', async () => {
			// `--tail 0` is a legitimate ask ("give me nothing yet, just confirm
			// the tab exists"). The CLI must propagate the literal zero - the
			// desktop side has its own slice-bug guard for the historical
			// `slice(-0)` foot-gun. Asserting the wire value here keeps the two
			// halves of the contract pinned down independently.
			const mockSendCommand = vi.fn().mockResolvedValue({
				type: 'session_history_result',
				success: true,
				tabId: 'tab-1',
				sessionId: 'tab-1',
				agentId: 'agent-a',
				agentSessionId: null,
				messages: [],
			});
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = { sendCommand: mockSendCommand };
				return action(mockClient as never);
			});

			await sessionShow('tab-1', { tail: '0' });

			expect(mockSendCommand).toHaveBeenCalledWith(
				expect.objectContaining({ type: 'get_session_history', tabId: 'tab-1', tail: 0 }),
				'session_history_result'
			);
		});

		it('surfaces TAB_NOT_FOUND from the desktop response', async () => {
			const mockSendCommand = vi.fn().mockResolvedValue({
				type: 'session_history_result',
				success: false,
				error: 'Tab not found: tab-bogus',
				code: 'TAB_NOT_FOUND',
			});
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = { sendCommand: mockSendCommand };
				return action(mockClient as never);
			});

			await sessionShow('tab-bogus', {});

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.success).toBe(false);
			expect(output.code).toBe('TAB_NOT_FOUND');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('maps an absent app to MAESTRO_NOT_RUNNING, exit 3', async () => {
			vi.mocked(withMaestroClient).mockRejectedValue(
				new MaestroNotRunningError('no-discovery-file')
			);

			await sessionShow('tab-1', {});

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.success).toBe(false);
			expect(output.code).toBe('MAESTRO_NOT_RUNNING');
			expect(processExitSpy.mock.calls[0]).toEqual([3]);
		});
	});
});
