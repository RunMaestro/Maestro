/**
 * Unit tests for `cue-token-accessor.ts`.
 *
 * The accessor wires together two real subsystems we want to keep out of the
 * test environment:
 *   1. `getStatsDB().database` - a `better-sqlite3` handle. The native binding
 *      is compiled against Electron's NODE_MODULE_VERSION and won't load
 *      under vitest's plain-Node runtime (other Cue tests work around this
 *      the same way), so we mock `getStatsDB()` to return a fake `prepare(...).all(...)`.
 *   2. `getSessionStorage(agentType)` - registers per-agent storage modules
 *      that read on-disk session files. We register fake storages with
 *      hand-crafted `AgentSessionInfo` rows so we can assert on the exact
 *      mapping into `SessionTokenSummary`.
 *
 * Critically, the fixtures keep the two id spaces DISTINCT: `session_lifecycle`
 * rows are keyed by the Maestro agent id (`m-*`), while `AgentSessionInfo` rows
 * (what `listSessions` returns) are keyed by the provider session id (`p-*`).
 * Conflating them is the bug this accessor was rewritten to fix - using the
 * same id for both would silently pass even if the join were wrong.
 *
 * We exercise the dispatch table (`COVERAGE_BY_AGENT`) and cache via the
 * exported `_resetCueTokenAccessorCache` helper.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentSessionInfo, AgentSessionStorage } from '../../../main/agents';

// ─── Mocks ──────────────────────────────────────────────────────────────────

interface SessionLookupRow {
	session_id: string;
	agent_type: string;
	project_path: string | null;
	is_remote: number | null;
}

let lookupRows: SessionLookupRow[] = [];
const mockPrepareAll = vi.fn((...sessionIds: string[]): SessionLookupRow[] =>
	lookupRows.filter((r) => sessionIds.includes(r.session_id))
);
const mockPrepare = vi.fn(() => ({ all: mockPrepareAll }));

vi.mock('../../../main/stats', () => ({
	getStatsDB: vi.fn(() => ({
		database: { prepare: mockPrepare },
	})),
}));

const storageRegistry = new Map<string, AgentSessionStorage>();
vi.mock('../../../main/agents', () => ({
	getSessionStorage: (agentId: string) => storageRegistry.get(agentId) ?? null,
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		warn: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

import {
	getSessionTokenSummaries,
	sessionTokenLookupKey,
	getAgentTypesForSessions,
	_resetCueTokenAccessorCache,
} from '../../../main/cue/stats/cue-token-accessor';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeInfo(overrides: Partial<AgentSessionInfo> = {}): AgentSessionInfo {
	return {
		sessionId: 'p-x',
		projectPath: '/proj',
		timestamp: '2026-04-28T10:00:00.000Z',
		modifiedAt: '2026-04-28T10:30:00.000Z',
		firstMessage: '',
		messageCount: 1,
		sizeBytes: 1024,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		durationSeconds: 60,
		...overrides,
	};
}

/**
 * Register a fake storage for `agentId` that returns `infos` from
 * `listSessions(projectPath)`. Other methods throw - we never call them.
 */
function registerFakeStorage(agentId: string, infos: AgentSessionInfo[]): void {
	const listSessions = vi.fn(async () => infos);
	storageRegistry.set(agentId, {
		agentId: agentId as AgentSessionStorage['agentId'],
		listSessions,
		listSessionsPaginated: vi.fn() as never,
		readSessionMessages: vi.fn() as never,
		searchSessions: vi.fn() as never,
		getSessionPath: vi.fn(() => null),
		deleteMessagePair: vi.fn() as never,
	});
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('cue-token-accessor', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		lookupRows = [];
		storageRegistry.clear();
		_resetCueTokenAccessorCache();
	});

	describe('per-agent coverage mapping', () => {
		it('claude-code session reports full coverage with all token + cost fields', async () => {
			lookupRows = [
				{
					session_id: 'm-claude',
					agent_type: 'claude-code',
					project_path: '/proj/a',
					is_remote: 0,
				},
			];
			registerFakeStorage('claude-code', [
				makeInfo({
					sessionId: 'p-claude',
					projectPath: '/proj/a',
					inputTokens: 1000,
					outputTokens: 500,
					cacheReadTokens: 200,
					cacheCreationTokens: 100,
					costUsd: 0.0123,
					timestamp: '2026-04-28T09:00:00.000Z',
					modifiedAt: '2026-04-28T09:45:00.000Z',
				}),
			]);

			const result = await getSessionTokenSummaries([
				{ maestroSessionId: 'm-claude', providerSessionId: 'p-claude' },
			]);

			expect(result.size).toBe(1);
			const summary = result.get(sessionTokenLookupKey('m-claude', 'p-claude'));
			expect(summary).toEqual({
				sessionId: 'p-claude',
				agentType: 'claude-code',
				inputTokens: 1000,
				outputTokens: 500,
				cacheReadTokens: 200,
				cacheCreationTokens: 100,
				costUsd: 0.0123,
				windowStartMs: Date.parse('2026-04-28T09:00:00.000Z'),
				windowEndMs: Date.parse('2026-04-28T09:45:00.000Z'),
				coverage: 'full',
			});
		});

		it('opencode session reports full coverage with cost', async () => {
			lookupRows = [
				{
					session_id: 'm-opencode',
					agent_type: 'opencode',
					project_path: '/proj/oc',
					is_remote: 0,
				},
			];
			registerFakeStorage('opencode', [
				makeInfo({
					sessionId: 'p-opencode',
					projectPath: '/proj/oc',
					inputTokens: 2222,
					outputTokens: 333,
					cacheReadTokens: 44,
					cacheCreationTokens: 5,
					costUsd: 0.05,
				}),
			]);

			const summary = (
				await getSessionTokenSummaries([
					{ maestroSessionId: 'm-opencode', providerSessionId: 'p-opencode' },
				])
			).get(sessionTokenLookupKey('m-opencode', 'p-opencode'));

			expect(summary?.coverage).toBe('full');
			expect(summary?.inputTokens).toBe(2222);
			expect(summary?.outputTokens).toBe(333);
			expect(summary?.cacheReadTokens).toBe(44);
			expect(summary?.cacheCreationTokens).toBe(5);
			expect(summary?.costUsd).toBe(0.05);
		});

		it('factory-droid session reports full coverage with costUsd === null (no cost field)', async () => {
			lookupRows = [
				{
					session_id: 'm-droid',
					agent_type: 'factory-droid',
					project_path: '/proj/d',
					is_remote: 0,
				},
			];
			registerFakeStorage('factory-droid', [
				makeInfo({
					sessionId: 'p-droid',
					projectPath: '/proj/d',
					inputTokens: 700,
					outputTokens: 300,
					cacheReadTokens: 50,
					cacheCreationTokens: 25,
					// no costUsd - droid storage omits it
				}),
			]);

			const summary = (
				await getSessionTokenSummaries([
					{ maestroSessionId: 'm-droid', providerSessionId: 'p-droid' },
				])
			).get(sessionTokenLookupKey('m-droid', 'p-droid'));

			expect(summary?.coverage).toBe('full');
			expect(summary?.costUsd).toBeNull();
			expect(summary?.inputTokens).toBe(700);
		});

		it('codex session reports partial coverage (cacheCreation always 0, no cost)', async () => {
			lookupRows = [
				{
					session_id: 'm-codex',
					agent_type: 'codex',
					project_path: '/proj/cx',
					is_remote: 0,
				},
			];
			registerFakeStorage('codex', [
				makeInfo({
					sessionId: 'p-codex',
					projectPath: '/proj/cx',
					inputTokens: 800,
					outputTokens: 400,
					cacheReadTokens: 90,
					cacheCreationTokens: 0,
				}),
			]);

			const summary = (
				await getSessionTokenSummaries([
					{ maestroSessionId: 'm-codex', providerSessionId: 'p-codex' },
				])
			).get(sessionTokenLookupKey('m-codex', 'p-codex'));

			expect(summary?.coverage).toBe('partial');
			expect(summary?.inputTokens).toBe(800);
			expect(summary?.cacheCreationTokens).toBe(0);
			expect(summary?.costUsd).toBeNull();
		});

		it('copilot-cli session reports partial coverage', async () => {
			lookupRows = [
				{
					session_id: 'm-copilot',
					agent_type: 'copilot-cli',
					project_path: '/proj/cp',
					is_remote: 0,
				},
			];
			registerFakeStorage('copilot-cli', [
				makeInfo({
					sessionId: 'p-copilot',
					projectPath: '/proj/cp',
					inputTokens: 1500,
					outputTokens: 250,
					cacheReadTokens: 100,
					cacheCreationTokens: 75,
				}),
			]);

			const summary = (
				await getSessionTokenSummaries([
					{ maestroSessionId: 'm-copilot', providerSessionId: 'p-copilot' },
				])
			).get(sessionTokenLookupKey('m-copilot', 'p-copilot'));

			expect(summary?.coverage).toBe('partial');
			expect(summary?.inputTokens).toBe(1500);
			expect(summary?.costUsd).toBeNull();
		});
	});

	describe('id-space join', () => {
		it('resolves agent/project by Maestro agent id but matches tokens by provider session id', async () => {
			// The whole point of the rewrite: the lookup id (Maestro agent id)
			// and the on-disk session id (provider session id) differ. A naive
			// `byId.get(maestroId)` would miss and report zeros.
			lookupRows = [
				{
					session_id: 'm-agent',
					agent_type: 'claude-code',
					project_path: '/proj/x',
					is_remote: 0,
				},
			];
			registerFakeStorage('claude-code', [
				makeInfo({ sessionId: 'p-run', projectPath: '/proj/x', inputTokens: 4242 }),
			]);

			const result = await getSessionTokenSummaries([
				{ maestroSessionId: 'm-agent', providerSessionId: 'p-run' },
			]);

			expect(result.get(sessionTokenLookupKey('m-agent', 'p-run'))?.inputTokens).toBe(4242);
		});

		it('provider session not present on disk yields partial zeros (not a miss)', async () => {
			lookupRows = [
				{
					session_id: 'm-agent',
					agent_type: 'claude-code',
					project_path: '/proj/x',
					is_remote: 0,
				},
			];
			registerFakeStorage('claude-code', [
				makeInfo({ sessionId: 'p-other', projectPath: '/proj/x', inputTokens: 100 }),
			]);

			const summary = (
				await getSessionTokenSummaries([
					{ maestroSessionId: 'm-agent', providerSessionId: 'p-run' },
				])
			).get(sessionTokenLookupKey('m-agent', 'p-run'));

			expect(summary?.coverage).toBe('partial');
			expect(summary?.inputTokens).toBe(0);
		});
	});

	describe('unsupported and missing sessions', () => {
		it('unknown agent type returns coverage=unsupported with zeros', async () => {
			lookupRows = [
				{
					session_id: 'm-unknown',
					agent_type: 'made-up-agent',
					project_path: '/proj/u',
					is_remote: 0,
				},
			];
			// No storage registered for the unknown agent.

			const summary = (
				await getSessionTokenSummaries([
					{ maestroSessionId: 'm-unknown', providerSessionId: 'p-unknown' },
				])
			).get(sessionTokenLookupKey('m-unknown', 'p-unknown'));

			expect(summary).toEqual({
				sessionId: 'p-unknown',
				agentType: 'made-up-agent',
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				costUsd: null,
				windowStartMs: 0,
				windowEndMs: 0,
				coverage: 'unsupported',
			});
		});

		it('Maestro agent absent from session_lifecycle is omitted from the result map', async () => {
			lookupRows = []; // DB returns nothing.

			const result = await getSessionTokenSummaries([
				{ maestroSessionId: 'm-missing', providerSessionId: 'p-missing' },
			]);

			expect(result.size).toBe(0);
			expect(result.has(sessionTokenLookupKey('m-missing', 'p-missing'))).toBe(false);
		});

		it('empty input returns empty map without touching the DB', async () => {
			const result = await getSessionTokenSummaries([]);
			expect(result.size).toBe(0);
			expect(mockPrepare).not.toHaveBeenCalled();
		});
	});

	describe('batched mixed-agent lookup', () => {
		it('returns correctly attributed results for sessions across multiple agent types in one call', async () => {
			lookupRows = [
				{
					session_id: 'm-claude',
					agent_type: 'claude-code',
					project_path: '/proj/a',
					is_remote: 0,
				},
				{
					session_id: 'm-codex',
					agent_type: 'codex',
					project_path: '/proj/b',
					is_remote: 0,
				},
				{
					session_id: 'm-droid',
					agent_type: 'factory-droid',
					project_path: '/proj/c',
					is_remote: 0,
				},
				// 'm-missing' is requested below but absent from the lookup table.
			];
			registerFakeStorage('claude-code', [
				makeInfo({
					sessionId: 'p-claude',
					projectPath: '/proj/a',
					inputTokens: 100,
					outputTokens: 50,
					cacheReadTokens: 10,
					cacheCreationTokens: 5,
					costUsd: 0.01,
				}),
			]);
			registerFakeStorage('codex', [
				makeInfo({
					sessionId: 'p-codex',
					projectPath: '/proj/b',
					inputTokens: 200,
					outputTokens: 75,
					cacheReadTokens: 25,
				}),
			]);
			registerFakeStorage('factory-droid', [
				makeInfo({
					sessionId: 'p-droid',
					projectPath: '/proj/c',
					inputTokens: 300,
					outputTokens: 100,
					cacheReadTokens: 30,
					cacheCreationTokens: 15,
				}),
			]);

			const result = await getSessionTokenSummaries([
				{ maestroSessionId: 'm-claude', providerSessionId: 'p-claude' },
				{ maestroSessionId: 'm-codex', providerSessionId: 'p-codex' },
				{ maestroSessionId: 'm-droid', providerSessionId: 'p-droid' },
				{ maestroSessionId: 'm-missing', providerSessionId: 'p-missing' },
			]);

			expect(result.size).toBe(3);
			expect(result.get(sessionTokenLookupKey('m-missing', 'p-missing'))).toBeUndefined();

			expect(result.get(sessionTokenLookupKey('m-claude', 'p-claude'))).toMatchObject({
				agentType: 'claude-code',
				inputTokens: 100,
				outputTokens: 50,
				costUsd: 0.01,
				coverage: 'full',
			});
			expect(result.get(sessionTokenLookupKey('m-codex', 'p-codex'))).toMatchObject({
				agentType: 'codex',
				inputTokens: 200,
				outputTokens: 75,
				cacheReadTokens: 25,
				cacheCreationTokens: 0,
				costUsd: null,
				coverage: 'partial',
			});
			expect(result.get(sessionTokenLookupKey('m-droid', 'p-droid'))).toMatchObject({
				agentType: 'factory-droid',
				inputTokens: 300,
				outputTokens: 100,
				cacheReadTokens: 30,
				cacheCreationTokens: 15,
				costUsd: null,
				coverage: 'full',
			});
		});

		it('groups sessions by (agentType, projectPath) so listSessions runs once per group', async () => {
			lookupRows = [
				{
					session_id: 'm-claude-1',
					agent_type: 'claude-code',
					project_path: '/proj/shared',
					is_remote: 0,
				},
				{
					session_id: 'm-claude-2',
					agent_type: 'claude-code',
					project_path: '/proj/shared',
					is_remote: 0,
				},
			];
			const listSessions = vi.fn(async () => [
				makeInfo({
					sessionId: 'p-claude-1',
					projectPath: '/proj/shared',
					inputTokens: 11,
				}),
				makeInfo({
					sessionId: 'p-claude-2',
					projectPath: '/proj/shared',
					inputTokens: 22,
				}),
			]);
			storageRegistry.set('claude-code', {
				agentId: 'claude-code',
				listSessions,
				listSessionsPaginated: vi.fn() as never,
				readSessionMessages: vi.fn() as never,
				searchSessions: vi.fn() as never,
				getSessionPath: vi.fn(() => null),
				deleteMessagePair: vi.fn() as never,
			});

			const result = await getSessionTokenSummaries([
				{ maestroSessionId: 'm-claude-1', providerSessionId: 'p-claude-1' },
				{ maestroSessionId: 'm-claude-2', providerSessionId: 'p-claude-2' },
			]);

			expect(listSessions).toHaveBeenCalledTimes(1);
			expect(result.get(sessionTokenLookupKey('m-claude-1', 'p-claude-1'))?.inputTokens).toBe(11);
			expect(result.get(sessionTokenLookupKey('m-claude-2', 'p-claude-2'))?.inputTokens).toBe(22);
		});
	});

	describe('remote-session safety net', () => {
		it('marks is_remote=1 sessions partial with zeros (known limitation)', async () => {
			lookupRows = [
				{
					session_id: 'm-remote',
					agent_type: 'claude-code',
					project_path: '/proj/r',
					is_remote: 1,
				},
			];
			const listSessions = vi.fn(async () => []);
			storageRegistry.set('claude-code', {
				agentId: 'claude-code',
				listSessions,
				listSessionsPaginated: vi.fn() as never,
				readSessionMessages: vi.fn() as never,
				searchSessions: vi.fn() as never,
				getSessionPath: vi.fn(() => null),
				deleteMessagePair: vi.fn() as never,
			});

			const summary = (
				await getSessionTokenSummaries([
					{ maestroSessionId: 'm-remote', providerSessionId: 'p-remote' },
				])
			).get(sessionTokenLookupKey('m-remote', 'p-remote'));

			expect(summary?.coverage).toBe('partial');
			expect(summary?.inputTokens).toBe(0);
			expect(listSessions).not.toHaveBeenCalled();
		});
	});

	describe('Grok attribution boundaries', () => {
		it.each([0, 1])(
			'keeps native lifetime usage unavailable for is_remote=%s',
			async (isRemote) => {
				lookupRows = ['m-account-a', 'm-account-b'].map((session_id) => ({
					session_id,
					agent_type: 'grok',
					project_path: '/proj/shared',
					is_remote: isRemote,
				}));
				registerFakeStorage('grok', [
					makeInfo({ sessionId: 'p-shared', inputTokens: 90_000, costUsd: 50 }),
				]);
				const firstTurn = { maestroSessionId: 'm-account-a', providerSessionId: 'p-shared' };
				const otherAccount = { maestroSessionId: 'm-account-b', providerSessionId: 'p-shared' };
				// A resumed turn shares a lookup pair; lifetime data cannot identify either turn's spend.
				const result = await getSessionTokenSummaries([firstTurn, firstTurn, otherAccount], {
					sinceMs: Date.parse('2026-04-28T00:00:00Z'),
					untilMs: Date.parse('2026-04-29T00:00:00Z'),
				});

				expect(result.size).toBe(2);
				for (const owner of ['m-account-a', 'm-account-b']) {
					expect(result.get(sessionTokenLookupKey(owner, 'p-shared'))).toEqual({
						sessionId: 'p-shared',
						agentType: 'grok',
						inputTokens: 0,
						outputTokens: 0,
						cacheReadTokens: 0,
						cacheCreationTokens: 0,
						costUsd: null,
						windowStartMs: 0,
						windowEndMs: 0,
						coverage: 'partial',
					});
				}
				expect(result.has('p-shared')).toBe(false);
				expect(storageRegistry.get('grok')!.listSessions).not.toHaveBeenCalled();
				expect(storageRegistry.get('grok')!.getSessionPath).not.toHaveBeenCalled();
			}
		);

		it('isolates colliding native IDs across owners, projects and providers on cache reuse', async () => {
			lookupRows = [
				{ session_id: 'm-a', agent_type: 'claude-code', project_path: '/proj/a', is_remote: 0 },
				{ session_id: 'm-b', agent_type: 'claude-code', project_path: '/proj/b', is_remote: 0 },
				{ session_id: 'm-grok', agent_type: 'grok', project_path: '/proj/a', is_remote: 0 },
			];
			registerFakeStorage('claude-code', []);
			const list = vi.mocked(storageRegistry.get('claude-code')!.listSessions);
			list.mockImplementation(async (projectPath) => [
				makeInfo({
					sessionId: 'p-shared',
					projectPath,
					inputTokens: projectPath === '/proj/a' ? 111 : 222,
					cacheReadTokens: projectPath === '/proj/a' ? 11 : 22,
				}),
			]);
			const lookups = lookupRows.map((row) => ({
				maestroSessionId: row.session_id,
				providerSessionId: 'p-shared',
			}));
			for (let poll = 0; poll < 2; poll++) {
				const result = await getSessionTokenSummaries(lookups);
				expect(result.size).toBe(3);
				expect(result.get(sessionTokenLookupKey('m-a', 'p-shared'))).toMatchObject({
					inputTokens: 111,
					cacheReadTokens: 11,
					agentType: 'claude-code',
				});
				expect(result.get(sessionTokenLookupKey('m-b', 'p-shared'))).toMatchObject({
					inputTokens: 222,
					cacheReadTokens: 22,
					agentType: 'claude-code',
				});
				expect(result.get(sessionTokenLookupKey('m-grok', 'p-shared'))).toMatchObject({
					inputTokens: 0,
					costUsd: null,
					coverage: 'partial',
					agentType: 'grok',
				});
			}
			expect(list).toHaveBeenCalledTimes(2);
			expect(mockPrepareAll).toHaveBeenCalledTimes(2);
		});
	});

	describe('lifecycle before cache', () => {
		it.each([
			'removed',
			'provider',
			'project',
			'remote',
			'missing-project',
			'lookup-error',
		] as const)('does not reuse a stale observation after lifecycle is %s', async (change) => {
			lookupRows = [
				{ session_id: 'm-agent', agent_type: 'claude-code', project_path: '/proj/a', is_remote: 0 },
			];
			registerFakeStorage('claude-code', [
				makeInfo({ sessionId: 'p-run', inputTokens: 123, costUsd: 0.5 }),
			]);
			registerFakeStorage('grok', [makeInfo({ sessionId: 'p-run', inputTokens: 90_000 })]);
			const lookups = [{ maestroSessionId: 'm-agent', providerSessionId: 'p-run' }];
			const key = sessionTokenLookupKey('m-agent', 'p-run');
			expect((await getSessionTokenSummaries(lookups)).get(key)?.inputTokens).toBe(123);
			const list = vi.mocked(storageRegistry.get('claude-code')!.listSessions);
			list.mockResolvedValue([makeInfo({ sessionId: 'p-run', inputTokens: 456 })]);
			switch (change) {
				case 'removed':
					lookupRows = [];
					break;
				case 'provider':
					lookupRows[0].agent_type = 'grok';
					break;
				case 'project':
					lookupRows[0].project_path = '/proj/b';
					break;
				case 'remote':
					lookupRows[0].is_remote = 1;
					break;
				case 'missing-project':
					lookupRows[0].project_path = null;
					break;
				case 'lookup-error':
					mockPrepareAll.mockImplementationOnce(() => {
						throw new Error('database unavailable');
					});
					break;
			}
			const result = await getSessionTokenSummaries(lookups);
			expect(mockPrepareAll).toHaveBeenCalledTimes(2);
			if (change === 'removed' || change === 'lookup-error') {
				expect(result.size).toBe(0);
			} else if (change === 'project') {
				expect(result.get(key)?.inputTokens).toBe(456);
				expect(list).toHaveBeenLastCalledWith('/proj/b');
			} else {
				expect(result.get(key)).toMatchObject({
					inputTokens: 0,
					costUsd: null,
					coverage: 'partial',
				});
			}
			expect(list).toHaveBeenCalledTimes(change === 'project' ? 2 : 1);
			expect(storageRegistry.get('grok')!.listSessions).not.toHaveBeenCalled();
		});
	});

	describe('getAgentTypesForSessions', () => {
		it('resolves agent type by Maestro agent id from session_lifecycle', async () => {
			lookupRows = [
				{ session_id: 'm-a', agent_type: 'claude-code', project_path: '/p', is_remote: 0 },
				{ session_id: 'm-b', agent_type: 'codex', project_path: '/p', is_remote: 0 },
			];

			const result = getAgentTypesForSessions(['m-a', 'm-b', 'm-missing']);

			expect(result.get('m-a')).toBe('claude-code');
			expect(result.get('m-b')).toBe('codex');
			expect(result.has('m-missing')).toBe(false);
		});

		it('returns an empty map for empty input without touching the DB', () => {
			const result = getAgentTypesForSessions([]);
			expect(result.size).toBe(0);
			expect(mockPrepare).not.toHaveBeenCalled();
		});
	});
});

describe('Grok Cue attribution', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		lookupRows = [];
		storageRegistry.clear();
		_resetCueTokenAccessorCache();
	});

	it('labels a Grok Cue run as grok while its spend stays unknown, beside a legacy provider', async () => {
		lookupRows = [
			{ session_id: 'm-grok', agent_type: 'grok', project_path: '/proj/s', is_remote: 0 },
			{ session_id: 'm-claude', agent_type: 'claude-code', project_path: '/proj/s', is_remote: 0 },
		];
		registerFakeStorage('grok', [
			makeInfo({
				sessionId: 'p-grok',
				inputTokens: 500,
				cacheReadTokens: 50,
				costUsd: 0,
				accounting: {
					completeness: 'complete',
					cost: { status: 'exact', costUsdTicks: '0' },
				} as unknown as AgentSessionInfo['accounting'],
			}),
		]);
		registerFakeStorage('claude-code', [
			makeInfo({ sessionId: 'p-claude', inputTokens: 40, cacheCreationTokens: 4, costUsd: 0.2 }),
		]);
		const range = { sinceMs: Date.parse('2026-04-28T00:00:00Z') };
		const result = await getSessionTokenSummaries(
			[
				{ maestroSessionId: 'm-grok', providerSessionId: 'p-grok' },
				{ maestroSessionId: 'm-claude', providerSessionId: 'p-claude' },
			],
			range
		);
		const grok = result.get(sessionTokenLookupKey('m-grok', 'p-grok'));
		// A native exact-zero lifetime is not this event's spend: null, never 0.
		expect(grok).toMatchObject({ agentType: 'grok', coverage: 'partial', costUsd: null });
		expect(grok).not.toHaveProperty('accounting');
		expect(grok!.inputTokens + grok!.cacheReadTokens + grok!.cacheCreationTokens).toBe(0);
		expect(result.get(sessionTokenLookupKey('m-claude', 'p-claude'))).toMatchObject({
			agentType: 'claude-code',
			inputTokens: 40,
			cacheCreationTokens: 4,
			costUsd: 0.2,
			coverage: 'full',
		});
		expect(storageRegistry.get('grok')!.listSessions).not.toHaveBeenCalled();
		expect(getAgentTypesForSessions(['m-grok', 'm-claude'])).toEqual(
			new Map([
				['m-grok', 'grok'],
				['m-claude', 'claude-code'],
			])
		);
	});

	it('keeps Grok partial, not unsupported, with no project or storage and no cached reuse', async () => {
		lookupRows = [{ session_id: 'm-grok', agent_type: 'grok', project_path: null, is_remote: 0 }];
		const lookups = [{ maestroSessionId: 'm-grok', providerSessionId: 'p-grok' }];
		const key = sessionTokenLookupKey('m-grok', 'p-grok');
		expect((await getSessionTokenSummaries(lookups)).get(key)).toMatchObject({
			coverage: 'partial',
			costUsd: null,
			inputTokens: 0,
		});
		// Storage appearing later and a recorded project still cannot attribute it.
		registerFakeStorage('grok', [makeInfo({ sessionId: 'p-grok', inputTokens: 9 })]);
		lookupRows[0].project_path = '/proj/s';
		expect((await getSessionTokenSummaries(lookups)).get(key)).toMatchObject({
			coverage: 'partial',
			inputTokens: 0,
		});
		expect(storageRegistry.get('grok')!.listSessions).not.toHaveBeenCalled();
		expect(mockPrepareAll).toHaveBeenCalledTimes(2);
	});
});
