import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';

// Mock electron so `app.isPackaged` / `process.resourcesPath` are inert in tests.
vi.mock('electron', () => ({
	app: { isPackaged: false },
}));

// Same in-memory MockStore shape the other claude-usage tests use — keeps the
// real electron-store out of the Vitest worker.
vi.mock('electron-store', () => {
	class MockStore<T extends Record<string, unknown>> {
		private state: Record<string, unknown>;
		constructor(options: { defaults?: T } = {}) {
			this.state = { ...(options.defaults ?? {}) };
		}
		get<K extends keyof T>(key: K, defaultValue?: T[K]): T[K] {
			const value = this.state[key as string];
			return (value === undefined ? defaultValue : value) as T[K];
		}
		set<K extends keyof T>(key: K, value: T[K]): void {
			this.state[key as string] = value;
		}
	}
	return { default: MockStore };
});

// Mock the sampler so we can drive its return value per-test without spawning
// node. The startup module is the unit under test; the sampler has its own
// dedicated suite.
const mockSampleUsage = vi.hoisted(() => vi.fn());
vi.mock('../../../main/agents/claude-usage-sampler', () => ({
	sampleUsage: mockSampleUsage,
}));

// Logger noise would clutter the test output; mock it to silent vi.fn()s so
// we can also assert on warn / info calls when useful.
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		error: vi.fn(),
	},
}));

import {
	runStartupUsageSampling,
	getMaestroPBinPath,
	type ClaudeUsageStartupDeps,
} from '../../../main/agents/claude-usage-startup';
import { clear, getAllSnapshots } from '../../../main/stores/claudeUsageStore';
import type { UsageSnapshot } from '../../../main/agents/claude-mode-selector';

interface RecentSessionFixture {
	id?: string;
	toolType?: string;
	createdAt?: number;
	customEnvVars?: Record<string, string>;
	cwd?: string;
	fullPath?: string;
}

function makeDeps(opts: {
	sessions?: RecentSessionFixture[];
	agentConfigs?: Record<string, { customEnvVars?: Record<string, string> }>;
	agentPath?: string | null;
}): ClaudeUsageStartupDeps {
	const sessions = opts.sessions ?? [];
	const agentConfigs = opts.agentConfigs ?? {};
	const detector = {
		getAgent: vi.fn(async (id: string) => {
			if (id !== 'claude-code') return null;
			if (opts.agentPath === null) return null;
			return {
				id: 'claude-code',
				command: 'claude',
				path: opts.agentPath ?? '/usr/local/bin/claude',
			} as never;
		}),
	};
	return {
		sessionsStore: {
			get: (_key: string, defaultValue?: RecentSessionFixture[]) =>
				sessions.length > 0 ? sessions : (defaultValue ?? []),
		},
		agentConfigsStore: {
			get: (
				_key: string,
				defaultValue?: Record<string, { customEnvVars?: Record<string, string> }>
			) => (Object.keys(agentConfigs).length > 0 ? agentConfigs : (defaultValue ?? {})),
		},
		getAgentDetector: () => detector as never,
	};
}

function buildSnapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
	return {
		sampledAt: new Date().toISOString(),
		configDirKey: path.resolve(path.join(os.homedir(), '.claude')),
		session: { percent: 12, resetsAt: '2099-12-31T00:00:00Z' },
		weekAllModels: { percent: 24, resetsAt: '2099-12-31T00:00:00Z' },
		weekSonnetOnly: { percent: 36, resetsAt: '2099-12-31T00:00:00Z' },
		...overrides,
	};
}

const NOW = Date.parse('2026-05-14T12:00:00Z');
const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;
const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000;

beforeEach(() => {
	clear();
	mockSampleUsage.mockReset();
});

describe('runStartupUsageSampling', () => {
	it('skips silently when no Claude Code sessions exist', async () => {
		const deps = makeDeps({ sessions: [] });
		const stored = await runStartupUsageSampling(deps, NOW);
		expect(stored).toBe(0);
		expect(mockSampleUsage).not.toHaveBeenCalled();
		expect(getAllSnapshots()).toEqual({});
	});

	it('skips silently when there are no Claude Code sessions within the 7-day window', async () => {
		const deps = makeDeps({
			sessions: [
				{ id: 's1', toolType: 'claude-code', createdAt: NOW - EIGHT_DAYS_MS },
				{ id: 's2', toolType: 'codex', createdAt: NOW - 1000 },
			],
		});
		const stored = await runStartupUsageSampling(deps, NOW);
		expect(stored).toBe(0);
		expect(mockSampleUsage).not.toHaveBeenCalled();
	});

	it('skips when the Claude Code agent is not detected', async () => {
		const deps = makeDeps({
			sessions: [{ id: 's1', toolType: 'claude-code', createdAt: NOW - 1000 }],
			agentPath: null,
		});
		const stored = await runStartupUsageSampling(deps, NOW);
		expect(stored).toBe(0);
		expect(mockSampleUsage).not.toHaveBeenCalled();
	});

	it('samples once per unique CLAUDE_CONFIG_DIR for recent Claude Code sessions', async () => {
		mockSampleUsage.mockResolvedValue(
			buildSnapshot({ configDirKey: path.resolve('/Users/test/.claude-gmail') })
		);

		const deps = makeDeps({
			sessions: [
				{
					id: 'a',
					toolType: 'claude-code',
					createdAt: NOW - 1000,
					customEnvVars: { CLAUDE_CONFIG_DIR: '/Users/test/.claude-gmail' },
				},
				{
					id: 'b',
					toolType: 'claude-code',
					createdAt: NOW - SIX_DAYS_MS,
					customEnvVars: { CLAUDE_CONFIG_DIR: '/Users/test/.claude-gmail' }, // dupe
				},
			],
		});

		const stored = await runStartupUsageSampling(deps, NOW);
		expect(stored).toBe(1);
		expect(mockSampleUsage).toHaveBeenCalledTimes(1);
		const call = mockSampleUsage.mock.calls[0][0] as {
			configDir: string;
			customEnvVars: Record<string, string>;
		};
		expect(call.configDir).toBe('/Users/test/.claude-gmail');
		expect(call.customEnvVars.MAESTRO_CLAUDE_BIN).toBe('/usr/local/bin/claude');
		expect(call.customEnvVars.CLAUDE_CONFIG_DIR).toBe('/Users/test/.claude-gmail');
	});

	it('samples each distinct CLAUDE_CONFIG_DIR independently (multi-account)', async () => {
		let nth = 0;
		mockSampleUsage.mockImplementation(async (opts: { configDir?: string }) => {
			nth++;
			return buildSnapshot({
				configDirKey: path.resolve(opts.configDir ?? path.join(os.homedir(), '.claude')),
				session: { percent: 10 + nth, resetsAt: '2099-12-31T00:00:00Z' },
			});
		});

		const deps = makeDeps({
			sessions: [
				{
					id: 'g',
					toolType: 'claude-code',
					createdAt: NOW - 1000,
					customEnvVars: { CLAUDE_CONFIG_DIR: '/Users/test/.claude-gmail' },
				},
				{
					id: 's',
					toolType: 'claude-code',
					createdAt: NOW - 1000,
					customEnvVars: { CLAUDE_CONFIG_DIR: '/Users/test/.claude-smash' },
				},
			],
		});

		const stored = await runStartupUsageSampling(deps, NOW);
		expect(stored).toBe(2);
		expect(mockSampleUsage).toHaveBeenCalledTimes(2);
		const live = getAllSnapshots();
		expect(Object.keys(live).sort()).toEqual(
			[path.resolve('/Users/test/.claude-gmail'), path.resolve('/Users/test/.claude-smash')].sort()
		);
	});

	it('uses the agent-level CLAUDE_CONFIG_DIR when the session does not set one', async () => {
		mockSampleUsage.mockResolvedValue(
			buildSnapshot({ configDirKey: path.resolve('/agent/level/.claude') })
		);

		const deps = makeDeps({
			sessions: [{ id: 's', toolType: 'claude-code', createdAt: NOW - 1000 }],
			agentConfigs: {
				'claude-code': { customEnvVars: { CLAUDE_CONFIG_DIR: '/agent/level/.claude' } },
			},
		});

		const stored = await runStartupUsageSampling(deps, NOW);
		expect(stored).toBe(1);
		const call = mockSampleUsage.mock.calls[0][0] as { configDir: string };
		expect(call.configDir).toBe('/agent/level/.claude');
	});

	it('lets session env vars override agent-level CLAUDE_CONFIG_DIR', async () => {
		mockSampleUsage.mockResolvedValue(
			buildSnapshot({ configDirKey: path.resolve('/session/level/.claude') })
		);

		const deps = makeDeps({
			sessions: [
				{
					id: 's',
					toolType: 'claude-code',
					createdAt: NOW - 1000,
					customEnvVars: { CLAUDE_CONFIG_DIR: '/session/level/.claude' },
				},
			],
			agentConfigs: {
				'claude-code': { customEnvVars: { CLAUDE_CONFIG_DIR: '/agent/level/.claude' } },
			},
		});

		await runStartupUsageSampling(deps, NOW);
		const call = mockSampleUsage.mock.calls[0][0] as { configDir: string };
		expect(call.configDir).toBe('/session/level/.claude');
	});

	it('falls back to ~/.claude when no env var is set anywhere', async () => {
		const defaultKey = path.resolve(path.join(os.homedir(), '.claude'));
		mockSampleUsage.mockResolvedValue(buildSnapshot({ configDirKey: defaultKey }));

		const deps = makeDeps({
			sessions: [{ id: 's', toolType: 'claude-code', createdAt: NOW - 1000 }],
		});

		const stored = await runStartupUsageSampling(deps, NOW);
		expect(stored).toBe(1);
		const call = mockSampleUsage.mock.calls[0][0] as {
			configDir: string | undefined;
			customEnvVars: Record<string, string>;
		};
		// We pass undefined explicitly when no override is set so the sampler inherits the host's default.
		expect(call.configDir).toBeUndefined();
		// MAESTRO_CLAUDE_BIN should still be wired in regardless.
		expect(call.customEnvVars.MAESTRO_CLAUDE_BIN).toBe('/usr/local/bin/claude');
	});

	it('ignores sessions with no createdAt timestamp', async () => {
		mockSampleUsage.mockResolvedValue(buildSnapshot());
		const deps = makeDeps({
			sessions: [
				{ id: 's-no-ts', toolType: 'claude-code' },
				{ id: 's-old-ts', toolType: 'claude-code', createdAt: NOW - EIGHT_DAYS_MS },
			],
		});

		const stored = await runStartupUsageSampling(deps, NOW);
		expect(stored).toBe(0);
		expect(mockSampleUsage).not.toHaveBeenCalled();
	});

	it('returns the count of successfully stored snapshots when some samples fail', async () => {
		mockSampleUsage.mockImplementation(async (opts: { configDir?: string }) => {
			if (opts.configDir === '/fails/.claude') return null;
			return buildSnapshot({
				configDirKey: path.resolve(opts.configDir ?? path.join(os.homedir(), '.claude')),
			});
		});

		const deps = makeDeps({
			sessions: [
				{
					id: 'ok',
					toolType: 'claude-code',
					createdAt: NOW - 1000,
					customEnvVars: { CLAUDE_CONFIG_DIR: '/works/.claude' },
				},
				{
					id: 'bad',
					toolType: 'claude-code',
					createdAt: NOW - 1000,
					customEnvVars: { CLAUDE_CONFIG_DIR: '/fails/.claude' },
				},
			],
		});

		const stored = await runStartupUsageSampling(deps, NOW);
		expect(stored).toBe(1);
		expect(mockSampleUsage).toHaveBeenCalledTimes(2);
		// Successful one persists; failed one leaves no trace.
		const live = getAllSnapshots();
		expect(Object.keys(live)).toEqual([path.resolve('/works/.claude')]);
	});

	it('uses session cwd / fullPath for the child process working directory when available', async () => {
		mockSampleUsage.mockResolvedValue(buildSnapshot());

		const deps = makeDeps({
			sessions: [
				{
					id: 'with-cwd',
					toolType: 'claude-code',
					createdAt: NOW - 1000,
					cwd: '/some/project',
					customEnvVars: { CLAUDE_CONFIG_DIR: '/Users/test/.claude-cwd' },
				},
			],
		});

		await runStartupUsageSampling(deps, NOW);
		const call = mockSampleUsage.mock.calls[0][0] as { cwd: string };
		expect(call.cwd).toBe('/some/project');
	});

	it('does not include MAESTRO_CLAUDE_BIN when the detector returns an agent without a path', async () => {
		mockSampleUsage.mockResolvedValue(buildSnapshot());

		const deps: ClaudeUsageStartupDeps = {
			sessionsStore: {
				get: () => [
					{
						id: 's',
						toolType: 'claude-code',
						createdAt: NOW - 1000,
					},
				],
			},
			agentConfigsStore: { get: () => ({}) },
			getAgentDetector: () =>
				({
					getAgent: vi.fn(async () => ({
						id: 'claude-code',
						command: 'claude',
						// no path
					})),
				}) as never,
		};

		await runStartupUsageSampling(deps, NOW);
		const call = mockSampleUsage.mock.calls[0][0] as {
			customEnvVars: Record<string, string>;
		};
		expect(call.customEnvVars.MAESTRO_CLAUDE_BIN).toBeUndefined();
	});
});

describe('getMaestroPBinPath', () => {
	it('returns a sibling path under dist/cli when not packaged', () => {
		const resolved = getMaestroPBinPath();
		// `__dirname` in the running test is the source TS dir; resolution is relative,
		// so we only assert on the trailing segments.
		expect(resolved.endsWith(path.join('cli', 'maestro-p.js'))).toBe(true);
	});
});
