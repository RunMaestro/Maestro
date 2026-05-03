/**
 * Phase 02 task #3 — unit tests for `cue-token-accessor.ts`.
 *
 * The accessor wires together two real subsystems we want to keep out of the
 * test environment:
 *   1. `getStatsDB().database` — a `better-sqlite3` handle. The native binding
 *      is compiled against Electron's NODE_MODULE_VERSION and won't load
 *      under vitest's plain-Node runtime (other Cue tests work around this
 *      the same way), so we mock `getStatsDB()` to return a fake `prepare(...).all(...)`.
 *   2. `getSessionStorage(agentType)` — registers per-agent storage modules
 *      that read on-disk session files. We register fake storages with
 *      hand-crafted `AgentSessionInfo` rows so we can assert on the exact
 *      mapping into `SessionTokenSummary`.
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
	_resetCueTokenAccessorCache,
} from '../../../main/cue/stats/cue-token-accessor';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeInfo(overrides: Partial<AgentSessionInfo> = {}): AgentSessionInfo {
	return {
		sessionId: 'sess-x',
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
 * `listSessions(projectPath)`. Other methods throw — we never call them.
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
					session_id: 's-claude',
					agent_type: 'claude-code',
					project_path: '/proj/a',
					is_remote: 0,
				},
			];
			registerFakeStorage('claude-code', [
				makeInfo({
					sessionId: 's-claude',
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

			const result = await getSessionTokenSummaries(['s-claude']);

			expect(result.size).toBe(1);
			const summary = result.get('s-claude');
			expect(summary).toEqual({
				sessionId: 's-claude',
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
					session_id: 's-opencode',
					agent_type: 'opencode',
					project_path: '/proj/oc',
					is_remote: 0,
				},
			];
			registerFakeStorage('opencode', [
				makeInfo({
					sessionId: 's-opencode',
					projectPath: '/proj/oc',
					inputTokens: 2222,
					outputTokens: 333,
					cacheReadTokens: 44,
					cacheCreationTokens: 5,
					costUsd: 0.05,
				}),
			]);

			const summary = (await getSessionTokenSummaries(['s-opencode'])).get('s-opencode');

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
					session_id: 's-droid',
					agent_type: 'factory-droid',
					project_path: '/proj/d',
					is_remote: 0,
				},
			];
			registerFakeStorage('factory-droid', [
				makeInfo({
					sessionId: 's-droid',
					projectPath: '/proj/d',
					inputTokens: 700,
					outputTokens: 300,
					cacheReadTokens: 50,
					cacheCreationTokens: 25,
					// no costUsd — droid storage omits it
				}),
			]);

			const summary = (await getSessionTokenSummaries(['s-droid'])).get('s-droid');

			expect(summary?.coverage).toBe('full');
			expect(summary?.costUsd).toBeNull();
			expect(summary?.inputTokens).toBe(700);
		});

		it('codex session reports partial coverage (cacheCreation always 0, no cost)', async () => {
			lookupRows = [
				{
					session_id: 's-codex',
					agent_type: 'codex',
					project_path: '/proj/cx',
					is_remote: 0,
				},
			];
			registerFakeStorage('codex', [
				makeInfo({
					sessionId: 's-codex',
					projectPath: '/proj/cx',
					inputTokens: 800,
					outputTokens: 400,
					cacheReadTokens: 90,
					cacheCreationTokens: 0,
				}),
			]);

			const summary = (await getSessionTokenSummaries(['s-codex'])).get('s-codex');

			expect(summary?.coverage).toBe('partial');
			expect(summary?.inputTokens).toBe(800);
			expect(summary?.cacheCreationTokens).toBe(0);
			expect(summary?.costUsd).toBeNull();
		});

		it('copilot-cli session reports partial coverage', async () => {
			lookupRows = [
				{
					session_id: 's-copilot',
					agent_type: 'copilot-cli',
					project_path: '/proj/cp',
					is_remote: 0,
				},
			];
			registerFakeStorage('copilot-cli', [
				makeInfo({
					sessionId: 's-copilot',
					projectPath: '/proj/cp',
					inputTokens: 1500,
					outputTokens: 250,
					cacheReadTokens: 100,
					cacheCreationTokens: 75,
				}),
			]);

			const summary = (await getSessionTokenSummaries(['s-copilot'])).get('s-copilot');

			expect(summary?.coverage).toBe('partial');
			expect(summary?.inputTokens).toBe(1500);
			expect(summary?.costUsd).toBeNull();
		});
	});

	describe('unsupported and missing sessions', () => {
		it('unknown agent type returns coverage=unsupported with zeros', async () => {
			lookupRows = [
				{
					session_id: 's-unknown',
					agent_type: 'made-up-agent',
					project_path: '/proj/u',
					is_remote: 0,
				},
			];
			// No storage registered for the unknown agent.

			const summary = (await getSessionTokenSummaries(['s-unknown'])).get('s-unknown');

			expect(summary).toEqual({
				sessionId: 's-unknown',
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

		it('session absent from session_lifecycle is omitted from the result map', async () => {
			lookupRows = []; // DB returns nothing.

			const result = await getSessionTokenSummaries(['s-missing']);

			expect(result.size).toBe(0);
			expect(result.has('s-missing')).toBe(false);
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
					session_id: 's-claude',
					agent_type: 'claude-code',
					project_path: '/proj/a',
					is_remote: 0,
				},
				{
					session_id: 's-codex',
					agent_type: 'codex',
					project_path: '/proj/b',
					is_remote: 0,
				},
				{
					session_id: 's-droid',
					agent_type: 'factory-droid',
					project_path: '/proj/c',
					is_remote: 0,
				},
				// 's-missing' is requested below but absent from the lookup table.
			];
			registerFakeStorage('claude-code', [
				makeInfo({
					sessionId: 's-claude',
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
					sessionId: 's-codex',
					projectPath: '/proj/b',
					inputTokens: 200,
					outputTokens: 75,
					cacheReadTokens: 25,
				}),
			]);
			registerFakeStorage('factory-droid', [
				makeInfo({
					sessionId: 's-droid',
					projectPath: '/proj/c',
					inputTokens: 300,
					outputTokens: 100,
					cacheReadTokens: 30,
					cacheCreationTokens: 15,
				}),
			]);

			const result = await getSessionTokenSummaries([
				's-claude',
				's-codex',
				's-droid',
				's-missing',
			]);

			expect(result.size).toBe(3);
			expect(result.get('s-missing')).toBeUndefined();

			expect(result.get('s-claude')).toMatchObject({
				agentType: 'claude-code',
				inputTokens: 100,
				outputTokens: 50,
				costUsd: 0.01,
				coverage: 'full',
			});
			expect(result.get('s-codex')).toMatchObject({
				agentType: 'codex',
				inputTokens: 200,
				outputTokens: 75,
				cacheReadTokens: 25,
				cacheCreationTokens: 0,
				costUsd: null,
				coverage: 'partial',
			});
			expect(result.get('s-droid')).toMatchObject({
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
					session_id: 's-claude-1',
					agent_type: 'claude-code',
					project_path: '/proj/shared',
					is_remote: 0,
				},
				{
					session_id: 's-claude-2',
					agent_type: 'claude-code',
					project_path: '/proj/shared',
					is_remote: 0,
				},
			];
			const listSessions = vi.fn(async () => [
				makeInfo({
					sessionId: 's-claude-1',
					projectPath: '/proj/shared',
					inputTokens: 11,
				}),
				makeInfo({
					sessionId: 's-claude-2',
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

			const result = await getSessionTokenSummaries(['s-claude-1', 's-claude-2']);

			expect(listSessions).toHaveBeenCalledTimes(1);
			expect(result.get('s-claude-1')?.inputTokens).toBe(11);
			expect(result.get('s-claude-2')?.inputTokens).toBe(22);
		});
	});

	describe('remote-session safety net', () => {
		it('marks is_remote=1 sessions partial with zeros (Phase 02 known limitation)', async () => {
			lookupRows = [
				{
					session_id: 's-remote',
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

			const summary = (await getSessionTokenSummaries(['s-remote'])).get('s-remote');

			expect(summary?.coverage).toBe('partial');
			expect(summary?.inputTokens).toBe(0);
			expect(listSessions).not.toHaveBeenCalled();
		});
	});
});
