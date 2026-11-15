/**
 * @file stats-usage.test.ts
 * @description `maestro-cli stats` and the Usage Dashboard read verbs
 * (`stats-delegation`, `stats-cue`, `stats-plan-usage`, `stats-agents`,
 * `stats-activity`) plus `stats-export`: each sends one bridge message and
 * prints what the matching panel shows.
 */

import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));

import {
	stats,
	statsActivity,
	statsAgents,
	statsCue,
	statsDelegation,
	statsExport,
	statsPlanUsage,
} from '../../../cli/commands/stats';
import { withMaestroClient } from '../../../cli/services/maestro-client';

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
