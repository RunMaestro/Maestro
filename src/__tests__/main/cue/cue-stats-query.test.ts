/**
 * Phase 03 task #4 - unit tests for `cue-stats-query.ts`.
 *
 * The aggregation function reads from two upstream subsystems we'd rather
 * keep out of the test runtime:
 *   1. `getRecentCueEvents()` from `cue-db` - backed by `better-sqlite3`,
 *      whose native binding is built for Electron's NODE_MODULE_VERSION and
 *      fails to load under vitest (every other Cue test works around this
 *      the same way; see `cue-db.test.ts` and `cue-chain-lineage.test.ts`).
 *   2. `getSessionTokenSummaries()` + `getAgentTypesForSessions()` from the
 *      token accessor - which themselves read `session_lifecycle` and dispatch
 *      to per-agent storage.
 *
 * We mock both at the module boundary and seed deterministic event lists +
 * token summaries per test, then assert on the aggregation output. This
 * exercises the actual pipeline/agent/subscription rollups, chain forest
 * builder, time-series bucketing, and coverage-warning logic - none of which
 * touch SQL.
 *
 * Native summaries use the canonical Maestro/provider pair key. Grok receipts
 * remain event-scoped even across resumed turns and colliding account/host IDs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CueEventRecord } from '../../../main/cue/cue-db';
import {
	getSessionTokenSummaries,
	sessionTokenLookupKey,
	type SessionTokenSummary,
} from '../../../main/cue/stats/cue-token-accessor';
import type { UsageAccounting, UsageCost } from '../../../shared/types';

// ─── Mocks ──────────────────────────────────────────────────────────────────

let mockEvents: CueEventRecord[] = [];
let mockSummaries = new Map<string, SessionTokenSummary>();
let mockAgentTypes = new Map<string, string>();

vi.mock('../../../main/cue/cue-db', () => ({
	getRecentCueEvents: vi.fn((sinceMs: number) => mockEvents.filter((e) => e.createdAt >= sinceMs)),
}));

// Isolate native pools while retaining the real join-key implementation.
vi.mock('../../../main/agents', () => ({ getSessionStorage: vi.fn() }));
vi.mock('../../../main/stats', () => ({ getStatsDB: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({ logger: { warn: vi.fn() } }));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

vi.mock('../../../main/cue/stats/cue-token-accessor', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../main/cue/stats/cue-token-accessor')>()),
	getSessionTokenSummaries: vi.fn(
		async (lookups: Array<{ maestroSessionId: string; providerSessionId: string }>) => {
			const result = new Map<string, SessionTokenSummary>();
			for (const { maestroSessionId, providerSessionId } of lookups) {
				const key = sessionTokenLookupKey(maestroSessionId, providerSessionId);
				const summary = mockSummaries.get(key);
				if (summary) result.set(key, summary);
			}
			return result;
		}
	),
	// Legacy fixtures use equal IDs; explicit lifecycle labels cover swaps/collisions.
	getAgentTypesForSessions: vi.fn((maestroSessionIds: string[]) => {
		const result = new Map<string, string>();
		for (const id of maestroSessionIds) {
			const agentType =
				mockAgentTypes.get(id) ?? mockSummaries.get(sessionTokenLookupKey(id, id))?.agentType;
			if (agentType) result.set(id, agentType);
		}
		return result;
	}),
}));

import { getCueStatsAggregation } from '../../../main/cue/stats/cue-stats-query';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<CueEventRecord> = {}): CueEventRecord {
	const id = overrides.id ?? 'evt-1';
	const sessionId = overrides.sessionId ?? 'session-1';
	return {
		id,
		type: 'time.heartbeat',
		triggerName: 'trigger',
		sessionId,
		subscriptionName: 'sub-default',
		status: 'completed',
		createdAt: Date.now(),
		completedAt: null,
		payload: null,
		pipelineId: null,
		chainRootId: id,
		parentEventId: null,
		// Default the provider session id to the Maestro session id so token
		// attribution resolves; tests that care about the distinction override it.
		providerSessionId: overrides.providerSessionId ?? sessionId,
		...overrides,
	};
}

function makeSummary(overrides: Partial<SessionTokenSummary> = {}): SessionTokenSummary {
	return {
		sessionId: 'session-1',
		agentType: 'claude-code',
		inputTokens: 100,
		outputTokens: 50,
		cacheReadTokens: 10,
		cacheCreationTokens: 5,
		costUsd: 0.01,
		windowStartMs: 0,
		windowEndMs: 0,
		coverage: 'full',
		...overrides,
	};
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('cue-stats-query - getCueStatsAggregation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockEvents = [];
		mockSummaries = new Map();
		mockAgentTypes = new Map();
	});

	describe('totals', () => {
		it('sums occurrences, success/failure counts, durations, and tokens across events', async () => {
			const now = Date.now();
			mockEvents = [
				makeEvent({
					id: 'e1',
					sessionId: 's1',
					status: 'completed',
					createdAt: now - 60_000,
					completedAt: now - 30_000,
				}),
				makeEvent({
					id: 'e2',
					sessionId: 's2',
					status: 'failed',
					createdAt: now - 50_000,
					completedAt: now - 25_000,
				}),
				makeEvent({
					id: 'e3',
					sessionId: 's3',
					status: 'running',
					createdAt: now - 10_000,
					completedAt: null,
				}),
			];
			mockSummaries.set(
				sessionTokenLookupKey('s1', 's1'),
				makeSummary({
					sessionId: 's1',
					inputTokens: 100,
					outputTokens: 40,
					cacheReadTokens: 10,
					cacheCreationTokens: 5,
					costUsd: 0.01,
				})
			);
			mockSummaries.set(
				sessionTokenLookupKey('s2', 's2'),
				makeSummary({
					sessionId: 's2',
					inputTokens: 200,
					outputTokens: 80,
					cacheReadTokens: 20,
					cacheCreationTokens: 10,
					costUsd: 0.02,
				})
			);
			mockSummaries.set(
				sessionTokenLookupKey('s3', 's3'),
				makeSummary({
					sessionId: 's3',
					inputTokens: 300,
					outputTokens: 120,
					cacheReadTokens: 30,
					cacheCreationTokens: 15,
					costUsd: null,
				})
			);

			const result = await getCueStatsAggregation('day');

			expect(result.totals.occurrences).toBe(3);
			expect(result.totals.successCount).toBe(1);
			expect(result.totals.failureCount).toBe(1);
			// e1: 30s, e2: 25s, e3: null → 55s = 55_000ms
			expect(result.totals.totalDurationMs).toBe(55_000);
			expect(result.totals.totalInputTokens).toBe(600);
			expect(result.totals.totalOutputTokens).toBe(240);
			expect(result.totals.totalCacheReadTokens).toBe(60);
			expect(result.totals.totalCacheCreationTokens).toBe(30);
			// Known spend cannot make a mixed known/unknown total complete.
			expect(result.totals.totalCostUsd).toBeNull();
		});

		it('reports totalCostUsd as null when no event in the window has cost data', async () => {
			mockEvents = [makeEvent({ id: 'e1', sessionId: 's1', status: 'completed' })];
			mockSummaries.set(
				sessionTokenLookupKey('s1', 's1'),
				makeSummary({ sessionId: 's1', costUsd: null, agentType: 'codex', coverage: 'partial' })
			);

			const result = await getCueStatsAggregation('day');
			expect(result.totals.totalCostUsd).toBeNull();
		});
	});

	describe('byPipeline rollup', () => {
		it('groups events with the same pipeline_id together', async () => {
			mockEvents = [
				makeEvent({ id: 'e1', sessionId: 's1', pipelineId: 'pipe-a', status: 'completed' }),
				makeEvent({ id: 'e2', sessionId: 's2', pipelineId: 'pipe-a', status: 'completed' }),
				makeEvent({ id: 'e3', sessionId: 's3', pipelineId: 'pipe-b', status: 'failed' }),
			];
			mockSummaries.set(
				sessionTokenLookupKey('s1', 's1'),
				makeSummary({ sessionId: 's1', inputTokens: 100 })
			);
			mockSummaries.set(
				sessionTokenLookupKey('s2', 's2'),
				makeSummary({ sessionId: 's2', inputTokens: 200 })
			);
			mockSummaries.set(
				sessionTokenLookupKey('s3', 's3'),
				makeSummary({ sessionId: 's3', inputTokens: 50 })
			);

			const result = await getCueStatsAggregation('day');

			const pipeA = result.byPipeline.find((g) => g.key === 'pipe-a');
			expect(pipeA).toBeDefined();
			expect(pipeA!.totals.occurrences).toBe(2);
			expect(pipeA!.totals.successCount).toBe(2);
			expect(pipeA!.totals.totalInputTokens).toBe(300);

			const pipeB = result.byPipeline.find((g) => g.key === 'pipe-b');
			expect(pipeB).toBeDefined();
			expect(pipeB!.totals.occurrences).toBe(1);
			expect(pipeB!.totals.failureCount).toBe(1);
			expect(pipeB!.totals.totalInputTokens).toBe(50);
		});

		it('puts NULL pipeline_id events in the "Unattributed" group, sorted last', async () => {
			mockEvents = [
				makeEvent({ id: 'e1', sessionId: 's1', pipelineId: 'pipe-a', status: 'completed' }),
				makeEvent({ id: 'e2', sessionId: 's2', pipelineId: null, status: 'completed' }),
				makeEvent({ id: 'e3', sessionId: 's3', pipelineId: null, status: 'failed' }),
			];
			mockSummaries.set(sessionTokenLookupKey('s1', 's1'), makeSummary({ sessionId: 's1' }));
			mockSummaries.set(sessionTokenLookupKey('s2', 's2'), makeSummary({ sessionId: 's2' }));
			mockSummaries.set(sessionTokenLookupKey('s3', 's3'), makeSummary({ sessionId: 's3' }));

			const result = await getCueStatsAggregation('day');

			const unattributed = result.byPipeline.find((g) => g.label === 'Unattributed');
			expect(unattributed).toBeDefined();
			expect(unattributed!.totals.occurrences).toBe(2);
			expect(unattributed!.totals.successCount).toBe(1);
			expect(unattributed!.totals.failureCount).toBe(1);

			// Unattributed must sort last regardless of occurrences ordering.
			expect(result.byPipeline[result.byPipeline.length - 1]?.label).toBe('Unattributed');
		});
	});

	describe('chain trees', () => {
		it('builds a two-deep chain (root → child → grandchild) as one entry with three linked nodes', async () => {
			const baseTime = Date.now() - 5 * 60_000;
			mockEvents = [
				makeEvent({
					id: 'root',
					sessionId: 's1',
					subscriptionName: 'sub-root',
					chainRootId: 'root',
					parentEventId: null,
					createdAt: baseTime,
				}),
				makeEvent({
					id: 'child',
					sessionId: 's2',
					subscriptionName: 'sub-child',
					chainRootId: 'root',
					parentEventId: 'root',
					createdAt: baseTime + 1_000,
				}),
				makeEvent({
					id: 'grand',
					sessionId: 's3',
					subscriptionName: 'sub-grand',
					chainRootId: 'root',
					parentEventId: 'child',
					createdAt: baseTime + 2_000,
				}),
			];
			mockSummaries.set(sessionTokenLookupKey('s1', 's1'), makeSummary({ sessionId: 's1' }));
			mockSummaries.set(sessionTokenLookupKey('s2', 's2'), makeSummary({ sessionId: 's2' }));
			mockSummaries.set(sessionTokenLookupKey('s3', 's3'), makeSummary({ sessionId: 's3' }));

			const result = await getCueStatsAggregation('day');

			expect(result.chains).toHaveLength(1);
			const chain = result.chains[0];
			expect(chain.rootId).toBe('root');
			expect(chain.rootSubscriptionName).toBe('sub-root');
			expect(chain.nodes).toHaveLength(3);

			// Nodes are created_at-sorted; first is the root.
			expect(chain.nodes[0]).toMatchObject({
				eventId: 'root',
				parentEventId: null,
				subscriptionName: 'sub-root',
			});
			expect(chain.nodes[1]).toMatchObject({
				eventId: 'child',
				parentEventId: 'root',
				subscriptionName: 'sub-child',
			});
			expect(chain.nodes[2]).toMatchObject({
				eventId: 'grand',
				parentEventId: 'child',
				subscriptionName: 'sub-grand',
			});
		});

		it('renders a partial chain with synthetic <partial chain> root when the root event is outside the window', async () => {
			const now = Date.now();
			// Window for 'day' is now-24h. Place root outside (older), child + grandchild inside.
			mockEvents = [
				// Note: root event is NOT in the events list - it predates the window.
				makeEvent({
					id: 'child',
					sessionId: 's2',
					subscriptionName: 'sub-child',
					chainRootId: 'orphan-root',
					parentEventId: 'orphan-root',
					createdAt: now - 60_000,
				}),
				makeEvent({
					id: 'grand',
					sessionId: 's3',
					subscriptionName: 'sub-grand',
					chainRootId: 'orphan-root',
					parentEventId: 'child',
					createdAt: now - 30_000,
				}),
			];
			mockSummaries.set(sessionTokenLookupKey('s2', 's2'), makeSummary({ sessionId: 's2' }));
			mockSummaries.set(sessionTokenLookupKey('s3', 's3'), makeSummary({ sessionId: 's3' }));

			const result = await getCueStatsAggregation('day');

			expect(result.chains).toHaveLength(1);
			const chain = result.chains[0];
			expect(chain.rootId).toBe('orphan-root');
			expect(chain.rootSubscriptionName).toBe('<partial chain>');
			// 1 synthetic root + 2 real events = 3 nodes
			expect(chain.nodes).toHaveLength(3);
			expect(chain.nodes[0]).toMatchObject({
				eventId: 'orphan-root',
				parentEventId: null,
				subscriptionName: '<partial chain>',
				pipelineId: null,
				agentType: null,
			});
			expect(chain.nodes[1].eventId).toBe('child');
			expect(chain.nodes[2].eventId).toBe('grand');
		});
	});

	describe('coverageWarnings', () => {
		it('emits a warning when an agent in the window reports unsupported coverage', async () => {
			mockEvents = [
				makeEvent({ id: 'e1', sessionId: 's-claude' }),
				makeEvent({ id: 'e2', sessionId: 's-unknown' }),
			];
			mockSummaries.set(
				sessionTokenLookupKey('s-claude', 's-claude'),
				makeSummary({ sessionId: 's-claude', agentType: 'claude-code', coverage: 'full' })
			);
			mockSummaries.set(
				sessionTokenLookupKey('s-unknown', 's-unknown'),
				makeSummary({
					sessionId: 's-unknown',
					agentType: 'made-up-agent',
					coverage: 'unsupported',
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
					costUsd: null,
				})
			);

			const result = await getCueStatsAggregation('day');

			expect(result.coverageWarnings.length).toBeGreaterThan(0);
			expect(
				result.coverageWarnings.some(
					(w) => w.includes('made-up-agent') && w.includes('no token data')
				)
			).toBe(true);
		});

		it('emits a warning for partial-coverage agents and stays silent when all coverage is full', async () => {
			mockEvents = [
				makeEvent({ id: 'e1', sessionId: 's-codex' }),
				makeEvent({ id: 'e2', sessionId: 's-claude' }),
			];
			mockSummaries.set(
				sessionTokenLookupKey('s-codex', 's-codex'),
				makeSummary({ sessionId: 's-codex', agentType: 'codex', coverage: 'partial' })
			);
			mockSummaries.set(
				sessionTokenLookupKey('s-claude', 's-claude'),
				makeSummary({ sessionId: 's-claude', agentType: 'claude-code', coverage: 'full' })
			);

			const result = await getCueStatsAggregation('day');

			expect(
				result.coverageWarnings.some((w) => w.includes('Codex') && w.includes('partial'))
			).toBe(true);
			// No warning for the full-coverage agent.
			expect(result.coverageWarnings.some((w) => w.includes('Claude Code'))).toBe(false);
		});

		it('returns no warnings when every session reports full coverage', async () => {
			mockEvents = [makeEvent({ id: 'e1', sessionId: 's-claude' })];
			mockSummaries.set(
				sessionTokenLookupKey('s-claude', 's-claude'),
				makeSummary({ sessionId: 's-claude', agentType: 'claude-code', coverage: 'full' })
			);

			const result = await getCueStatsAggregation('day');
			expect(result.coverageWarnings).toEqual([]);
		});
	});

	// Plans/maestro-lib-cli-migration.md, "Cue": `cue-token-accessor.ts`'s
	// on-disk lookup can never resolve a session file for an SSH-remote run -
	// the file lives on the remote host - so it always returns zeros with
	// `coverage: 'partial'` for one. `stream_usage_json` (populated live by
	// `cue-process-lifecycle.ts` from the run's own stdout, regardless of
	// where the process ran) is the only real token figure available then.
	describe('stream-usage fallback (SSH-remote token attribution)', () => {
		it('falls back to stream-parsed usage when the on-disk summary is zeroed (partial coverage)', async () => {
			mockEvents = [
				makeEvent({
					id: 'e1',
					sessionId: 's-remote',
					streamUsageJson: JSON.stringify({
						inputTokens: 120,
						outputTokens: 40,
						cacheReadInputTokens: 5,
						cacheCreationInputTokens: 2,
						totalCostUsd: 0.03,
						contextWindow: 200000,
					}),
				}),
			];
			// Mirrors what cue-token-accessor.ts actually returns for a remote
			// session: zeroed totals, coverage 'partial'.
			mockSummaries.set(
				sessionTokenLookupKey('s-remote', 's-remote'),
				makeSummary({
					sessionId: 's-remote',
					agentType: 'claude-code',
					coverage: 'partial',
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
					costUsd: null,
				})
			);

			const result = await getCueStatsAggregation('day');

			expect(result.totals.totalInputTokens).toBe(120);
			expect(result.totals.totalOutputTokens).toBe(40);
			expect(result.totals.totalCacheReadTokens).toBe(5);
			expect(result.totals.totalCacheCreationTokens).toBe(2);
		});

		it('prefers a non-zero on-disk summary over the stream fallback', async () => {
			mockEvents = [
				makeEvent({
					id: 'e1',
					sessionId: 's-local',
					streamUsageJson: JSON.stringify({ inputTokens: 999, outputTokens: 999 }),
				}),
			];
			mockSummaries.set(
				sessionTokenLookupKey('s-local', 's-local'),
				makeSummary({
					sessionId: 's-local',
					agentType: 'claude-code',
					coverage: 'full',
					inputTokens: 100,
					outputTokens: 50,
				})
			);

			const result = await getCueStatsAggregation('day');

			// The real on-disk figures win, not the stream fallback's.
			expect(result.totals.totalInputTokens).toBe(100);
			expect(result.totals.totalOutputTokens).toBe(50);
		});

		it('contributes nothing when neither the on-disk summary nor stream usage is available', async () => {
			mockEvents = [makeEvent({ id: 'e1', sessionId: 's-none', providerSessionId: null })];

			const result = await getCueStatsAggregation('day');

			expect(result.totals.totalInputTokens).toBe(0);
			expect(result.totals.totalOutputTokens).toBe(0);
		});
	});

	describe('Grok event accounting', () => {
		const accounting: UsageAccounting = {
			source: 'runtime-stream',
			providerId: 'grok',
			scope: 'turn',
			reporting: 'snapshot',
			cacheReadCounting: 'beside-input',
			cacheCreationCounting: 'beside-input',
			completeness: 'complete',
			cost: { status: 'exact', costUsdTicks: '0' },
			childInclusion: 'completed',
			childCompleteness: 'complete',
		};

		it.each<UsageCost>([
			{ status: 'exact', costUsdTicks: '200000000' },
			{ status: 'partial', costUsdTicks: '200000000' },
			{ status: 'unknown' },
		])('reconciles new/resumed turns and account collisions with $status spend', async (cost) => {
			const now = Date.now();
			mockAgentTypes.set('owner-a', 'claude-code'); // Creation-time provider before a swap.
			mockEvents = [
				{ id: 'new', sessionId: 'owner-a', input: 70, output: 30, read: 25, write: 10 },
				{ id: 'resume', sessionId: 'owner-a', input: 35, output: 20, read: 15, write: 5 },
				{ id: 'other', sessionId: 'owner-b', input: 7, output: 3, read: 2, write: 1 },
			].map((turn) =>
				makeEvent({
					id: turn.id,
					sessionId: turn.sessionId,
					providerSessionId: 'shared-native',
					createdAt: now,
					completedAt: now + 1,
					pipelineId: 'pipeline',
					subscriptionName: turn.sessionId,
					chainRootId: 'new',
					parentEventId: turn.id === 'new' ? null : 'new',
					streamUsageJson: JSON.stringify({
						inputTokens: turn.input,
						outputTokens: turn.output,
						cacheReadInputTokens: turn.read,
						cacheCreationInputTokens: turn.write,
						totalCostUsd: 0,
						accounting: {
							...accounting,
							cost: turn.id === 'resume' ? cost : accounting.cost,
							scopeId: `${turn.sessionId}/account/host`,
							processGeneration: turn.id,
						},
					}),
				})
			);
			for (const owner of ['owner-a', 'owner-b']) {
				mockSummaries.set(
					sessionTokenLookupKey(owner, 'shared-native'),
					makeSummary({
						agentType: 'grok',
						inputTokens: 999_999,
						outputTokens: 888_888,
						costUsd: 100,
					})
				);
			}
			const result = await getCueStatsAggregation('day');
			expect(getSessionTokenSummaries).toHaveBeenCalledWith([], expect.anything());
			const totals = {
				totalInputTokens: 112,
				totalOutputTokens: 53,
				totalCacheReadTokens: 42,
				totalCacheCreationTokens: 16,
				totalCostUsd: cost.status === 'exact' ? 0.02 : null,
			};
			for (const rollup of [
				result.totals,
				result.byPipeline[0].totals,
				result.byAgent[0].totals,
				result.chains[0].totals,
			])
				expect(rollup).toMatchObject(totals);
			expect(result.byAgent.map((g) => g.key)).toEqual(['grok']);
			expect(result.bySubscription.find((g) => g.key === 'owner-a')?.totals.totalInputTokens).toBe(
				105
			);
			expect(result.bySubscription.find((g) => g.key === 'owner-b')?.totals.totalInputTokens).toBe(
				7
			);
			expect(result.timeSeries).toEqual([
				expect.objectContaining({ inputTokens: 112, outputTokens: 53 }),
			]);
			expect(result.chains[0].nodes.map((n) => n.inputTokens)).toEqual([70, 35, 7]);
			expect(result.chains[0].nodes.map((n) => n.costUsd)).toEqual([
				0,
				cost.status === 'exact' ? 0.02 : null,
				0,
			]);
		});

		it.each([
			['missing', null, 'grok'],
			['corrupt', '{', 'grok'],
			['legacy-zero', '{"inputTokens":0,"totalCostUsd":0}', 'claude-code'],
			['unidentified-zero', '{"totalCostUsd":0}', null],
			['invalid-count', JSON.stringify({ inputTokens: -1, accounting }), 'claude-code'],
			[
				'native-lifetime',
				JSON.stringify({
					inputTokens: 999999,
					accounting: { ...accounting, scope: 'native-session' },
				}),
				'claude-code',
			],
			[
				'child-lifetime',
				JSON.stringify({ inputTokens: 999999, accounting: { ...accounting, scope: 'child' } }),
				'claude-code',
			],
			['missing-cost', JSON.stringify({ accounting: { providerId: 'grok' } }), 'codex'],
		])(
			'keeps %s receipt unknown without inferring native scope',
			async (_name, streamUsageJson, lifecycle) => {
				if (lifecycle) mockAgentTypes.set('owner', lifecycle);
				mockEvents = [
					makeEvent({
						sessionId: 'owner',
						providerSessionId:
							lifecycle === 'claude-code' && !streamUsageJson?.includes('providerId')
								? null
								: 'shared-native',
						status: 'stopped',
						streamUsageJson,
					}),
				];
				const result = await getCueStatsAggregation('day');
				expect(getSessionTokenSummaries).toHaveBeenCalledWith([], expect.anything());
				expect(result.totals).toMatchObject({
					totalInputTokens: 0,
					totalCostUsd: null,
					failureCount: 1,
				});
				expect(result.chains[0].nodes[0]).toMatchObject({ inputTokens: 0, costUsd: null });
				expect(result.byAgent[0].key).toBe(
					streamUsageJson?.includes('providerId') ? 'grok' : (lifecycle ?? '__unknown__')
				);
			}
		);

		it.each(['failed', 'timeout', 'stopped', 'running'])(
			'keeps observed Codex after a Grok swap for %s without a native ID',
			async (status) => {
				mockAgentTypes.set('owner', 'grok');
				mockEvents = [
					makeEvent({
						sessionId: 'owner',
						providerSessionId: null,
						status,
						streamUsageJson: JSON.stringify({
							inputTokens: 8,
							accounting: { ...accounting, providerId: 'codex' },
						}),
					}),
				];
				const result = await getCueStatsAggregation('day');
				expect(getSessionTokenSummaries).toHaveBeenCalledWith([], expect.anything());
				expect(result.byAgent[0].key).toBe('codex');
				expect(result.totals).toMatchObject({
					totalInputTokens: 8,
					totalCostUsd: 0,
					failureCount: status === 'running' ? 0 : 1,
				});
			}
		);

		it('keeps non-Grok native lookups separate for colliding provider IDs', async () => {
			for (const [owner, input] of [
				['owner-a', 11],
				['owner-b', 22],
			] as const) {
				mockAgentTypes.set(owner, 'claude-code');
				mockEvents.push(
					makeEvent({ id: owner, sessionId: owner, providerSessionId: 'shared-native' })
				);
				mockSummaries.set(
					sessionTokenLookupKey(owner, 'shared-native'),
					makeSummary({ inputTokens: input })
				);
			}
			mockEvents.push(
				makeEvent({
					id: 'swapped',
					sessionId: 'owner-a',
					providerSessionId: 'shared-native',
					streamUsageJson: JSON.stringify({ inputTokens: 7, accounting }),
				})
			);
			const result = await getCueStatsAggregation('day');
			expect(getSessionTokenSummaries).toHaveBeenCalledWith(
				[
					{ maestroSessionId: 'owner-a', providerSessionId: 'shared-native' },
					{ maestroSessionId: 'owner-b', providerSessionId: 'shared-native' },
				],
				expect.anything()
			);
			expect(result.totals.totalInputTokens).toBe(40);
			expect(
				Object.fromEntries(result.chains.map((c) => [c.rootId, c.totals.totalInputTokens]))
			).toEqual({ 'owner-a': 11, 'owner-b': 22, swapped: 7 });
		});
	});

	describe('byTriggerType rollup', () => {
		it('groups events by event.type and sorts by occurrences desc', async () => {
			const now = Date.now();
			mockEvents = [
				makeEvent({ id: 'e1', type: 'file.changed', createdAt: now - 60_000 }),
				makeEvent({ id: 'e2', type: 'file.changed', createdAt: now - 50_000 }),
				makeEvent({ id: 'e3', type: 'file.changed', createdAt: now - 40_000 }),
				makeEvent({ id: 'e4', type: 'time.scheduled', createdAt: now - 30_000 }),
				makeEvent({ id: 'e5', type: 'time.scheduled', createdAt: now - 20_000 }),
				makeEvent({ id: 'e6', type: 'github.pull_request', createdAt: now - 10_000 }),
			];

			const result = await getCueStatsAggregation('day');

			expect(result.byTriggerType.map((g) => g.key)).toEqual([
				'file.changed',
				'time.scheduled',
				'github.pull_request',
			]);
			expect(result.byTriggerType[0].label).toBe('File Change');
			expect(result.byTriggerType[0].totals.occurrences).toBe(3);
			expect(result.byTriggerType[1].label).toBe('Scheduled');
			expect(result.byTriggerType[1].totals.occurrences).toBe(2);
			expect(result.byTriggerType[2].label).toBe('GitHub PR');
			expect(result.byTriggerType[2].totals.occurrences).toBe(1);
		});

		it('preserves the raw key as label for unknown trigger types', async () => {
			const now = Date.now();
			mockEvents = [
				makeEvent({ id: 'e1', type: 'custom.future-trigger', createdAt: now - 60_000 }),
			];

			const result = await getCueStatsAggregation('day');

			expect(result.byTriggerType).toHaveLength(1);
			expect(result.byTriggerType[0].key).toBe('custom.future-trigger');
			expect(result.byTriggerType[0].label).toBe('custom.future-trigger');
		});
	});

	describe('excludeTriggerTypes filter', () => {
		function heartbeatHeavy(now: number) {
			return [
				makeEvent({ id: 'h1', type: 'time.heartbeat', createdAt: now - 60_000 }),
				makeEvent({ id: 'h2', type: 'time.heartbeat', createdAt: now - 50_000 }),
				makeEvent({ id: 'h3', type: 'time.heartbeat', createdAt: now - 40_000 }),
				makeEvent({ id: 'f1', type: 'file.changed', createdAt: now - 30_000 }),
			];
		}

		it('drops the excluded types from totals and every rollup', async () => {
			const now = Date.now();
			mockEvents = heartbeatHeavy(now);

			const result = await getCueStatsAggregation('day', {
				excludeTriggerTypes: ['time.heartbeat'],
			});

			expect(result.totals.occurrences).toBe(1);
			expect(result.byTriggerType.map((g) => g.key)).toEqual(['file.changed']);
			expect(result.excludedTriggerTypes).toEqual(['time.heartbeat']);
			expect(result.byHourOfDay.reduce((sum, bucket) => sum + bucket.occurrences, 0)).toBe(1);
			expect(result.timeSeries.reduce((sum, bucket) => sum + bucket.occurrences, 0)).toBe(1);
		});

		it('still reports the excluded type in triggerTypeOptions with its full count', async () => {
			const now = Date.now();
			mockEvents = heartbeatHeavy(now);

			const result = await getCueStatsAggregation('day', {
				excludeTriggerTypes: ['time.heartbeat'],
			});

			expect(result.triggerTypeOptions).toEqual([
				{ key: 'time.heartbeat', label: 'Heartbeat', occurrences: 3 },
				{ key: 'file.changed', label: 'File Change', occurrences: 1 },
			]);
		});

		it('is a no-op when no exclusions are supplied', async () => {
			const now = Date.now();
			mockEvents = heartbeatHeavy(now);

			const result = await getCueStatsAggregation('day');

			expect(result.totals.occurrences).toBe(4);
			expect(result.excludedTriggerTypes).toEqual([]);
		});
	});

	describe('byHourOfDay distribution', () => {
		it('always returns 24 entries (hour 0..23) regardless of input volume', async () => {
			mockEvents = [];
			const result = await getCueStatsAggregation('day');
			expect(result.byHourOfDay).toHaveLength(24);
			expect(result.byHourOfDay.map((b) => b.hour)).toEqual(
				Array.from({ length: 24 }, (_, i) => i)
			);
		});

		it('buckets events by their local-time hour and tracks success / failure counts', async () => {
			// Build timestamps anchored to a known local hour by constructing
			// Date objects in the host TZ, so the assertion is deterministic
			// regardless of where the test runs.
			const at = (hour: number, status: string, idx: number) => {
				const d = new Date();
				d.setHours(hour, 30, 0, 0);
				return makeEvent({ id: `e-${hour}-${idx}`, status, createdAt: d.getTime() });
			};
			mockEvents = [
				at(9, 'completed', 1),
				at(9, 'completed', 2),
				at(9, 'failed', 3),
				at(14, 'completed', 1),
			];

			const result = await getCueStatsAggregation('day');

			expect(result.byHourOfDay[9]).toEqual({
				hour: 9,
				occurrences: 3,
				successCount: 2,
				failureCount: 1,
			});
			expect(result.byHourOfDay[14]).toEqual({
				hour: 14,
				occurrences: 1,
				successCount: 1,
				failureCount: 0,
			});
			// Hours with no events stay at zero.
			expect(result.byHourOfDay[0].occurrences).toBe(0);
			expect(result.byHourOfDay[23].occurrences).toBe(0);
		});
	});

	describe('bucketSizeMs', () => {
		it("is 3600000 (1 hour) for 'day'", async () => {
			const result = await getCueStatsAggregation('day');
			expect(result.bucketSizeMs).toBe(3_600_000);
		});

		it("is 3600000 (1 hour) for 'week'", async () => {
			const result = await getCueStatsAggregation('week');
			expect(result.bucketSizeMs).toBe(3_600_000);
		});

		it("is 86400000 (1 day) for 'month'", async () => {
			const result = await getCueStatsAggregation('month');
			expect(result.bucketSizeMs).toBe(86_400_000);
		});

		it("is 86400000 (1 day) for 'quarter', 'year', and 'all'", async () => {
			const quarter = await getCueStatsAggregation('quarter');
			const year = await getCueStatsAggregation('year');
			const all = await getCueStatsAggregation('all');
			expect(quarter.bucketSizeMs).toBe(86_400_000);
			expect(year.bucketSizeMs).toBe(86_400_000);
			expect(all.bucketSizeMs).toBe(86_400_000);
		});
	});
});
