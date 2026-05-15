/**
 * Tests for src/main/agents/claude-usage-startup.ts
 *
 * Strategy: mock `claude-usage-sampler.ts` so we can drive its resolution
 * directly per-target, mock `electron-store` for the snapshot store, mock
 * `os.homedir()` for deterministic `~/.claude` resolution, and stub a fake
 * `AgentDetector` so the test fixtures don't need a real detector instance.
 *
 * The startup module's contract is: read sessions, filter to recent
 * claude-code ones, resolve agent+session env (session wins), dedup by
 * canonical configDirKey, sample each unique key in parallel, persist each
 * successful snapshot. We exercise every skip path, the happy path, dedup,
 * multi-account isolation, env precedence, partial failure, cwd
 * forwarding, and the `agent.path` → MAESTRO_CLAUDE_BIN passthrough.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { sampleUsageMock, loggerWarnMock, loggerInfoMock, loggerDebugMock } = vi.hoisted(() => ({
	sampleUsageMock: vi.fn(),
	loggerWarnMock: vi.fn(),
	loggerInfoMock: vi.fn(),
	loggerDebugMock: vi.fn(),
}));

vi.mock('../../../main/agents/claude-usage-sampler', () => ({
	sampleUsage: sampleUsageMock,
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		warn: loggerWarnMock,
		info: loggerInfoMock,
		debug: loggerDebugMock,
		error: vi.fn(),
	},
}));

vi.mock('electron-store', () => {
	return {
		default: class MockStore {
			data: Record<string, unknown>;
			constructor(options: Record<string, unknown>) {
				this.data = { ...((options.defaults as Record<string, unknown>) ?? {}) };
			}
			get(key: string, defaultValue?: unknown): unknown {
				if (Object.prototype.hasOwnProperty.call(this.data, key)) {
					return this.data[key];
				}
				return defaultValue;
			}
			set(key: string, value: unknown): void {
				this.data[key] = value;
			}
		},
	};
});

vi.mock('os', async () => {
	const actual = await vi.importActual<typeof import('os')>('os');
	const homedir = () => '/Users/test';
	return {
		...actual,
		homedir,
		default: { ...actual, homedir },
	};
});

import { runStartupUsageSampling } from '../../../main/agents/claude-usage-startup';
import {
	clear as clearUsageStore,
	getSnapshot,
	__resetForTests as resetUsageStore,
	type UsageSnapshot,
} from '../../../main/stores/claudeUsageStore';

const FROZEN_NOW = new Date('2026-05-15T12:00:00.000Z').getTime();
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

interface FakeStore<T> {
	get(key: string, defaultValue?: unknown): unknown;
	set(key: string, value: unknown): void;
	_data: T;
}

function makeStore<T extends Record<string, unknown>>(data: T): FakeStore<T> {
	const _data = { ...data };
	return {
		_data,
		get(key: string, defaultValue?: unknown): unknown {
			if (Object.prototype.hasOwnProperty.call(_data, key)) {
				return (_data as Record<string, unknown>)[key];
			}
			return defaultValue;
		},
		set(key: string, value: unknown): void {
			(_data as Record<string, unknown>)[key] = value;
		},
	};
}

function makeDetector(agentResult: unknown): {
	getAgent: ReturnType<typeof vi.fn>;
} {
	return { getAgent: vi.fn().mockResolvedValue(agentResult) };
}

function makeSnapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
	return {
		sampledAt: new Date(FROZEN_NOW).toISOString(),
		configDirKey: '/Users/test/.claude',
		session: { percent: 10, resetsAt: '2026-05-15T17:00:00.000Z' },
		weekAllModels: { percent: 20, resetsAt: '2026-05-22T12:00:00.000Z' },
		weekSonnetOnly: { percent: 5, resetsAt: '2026-05-22T12:00:00.000Z' },
		...overrides,
	};
}

function recentClaudeSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'sess-1',
		toolType: 'claude-code',
		cwd: '/var/projects/foo',
		projectRoot: '/var/projects/foo',
		createdAt: FROZEN_NOW - 60_000,
		...overrides,
	};
}

const FAKE_AGENT = {
	id: 'claude-code',
	name: 'Claude Code',
	binaryName: 'claude',
	command: 'claude',
	path: '/usr/local/bin/claude',
	args: [],
	available: true,
};

describe('claude-usage-startup → runStartupUsageSampling', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(FROZEN_NOW));
		sampleUsageMock.mockReset();
		loggerWarnMock.mockReset();
		loggerInfoMock.mockReset();
		loggerDebugMock.mockReset();
		resetUsageStore();
		clearUsageStore();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('skip paths', () => {
		it('skips when the claude-code agent is not detected', async () => {
			const deps = {
				sessionsStore: makeStore({ sessions: [recentClaudeSession()] }) as never,
				agentConfigsStore: makeStore({ configs: {} }) as never,
				settingsStore: makeStore({}) as never,
				agentDetector: makeDetector(null) as never,
			};

			await runStartupUsageSampling(deps);

			expect(sampleUsageMock).not.toHaveBeenCalled();
			expect(loggerWarnMock).toHaveBeenCalledWith(
				expect.stringContaining('claude-code agent not detected'),
				expect.any(String)
			);
		});

		it('skips when sessionsStore has zero claude-code sessions', async () => {
			const deps = {
				sessionsStore: makeStore({
					sessions: [
						{ id: 's-1', toolType: 'codex', cwd: '/x', createdAt: FROZEN_NOW },
						{ id: 's-2', toolType: 'opencode', cwd: '/y', createdAt: FROZEN_NOW },
					],
				}) as never,
				agentConfigsStore: makeStore({ configs: {} }) as never,
				settingsStore: makeStore({}) as never,
				agentDetector: makeDetector(FAKE_AGENT) as never,
			};

			await runStartupUsageSampling(deps);

			expect(sampleUsageMock).not.toHaveBeenCalled();
			expect(loggerInfoMock).toHaveBeenCalledWith(
				expect.stringContaining('no recent Claude Code sessions'),
				expect.any(String),
				expect.any(Object)
			);
		});

		it('skips when all claude-code sessions are older than 7 days', async () => {
			const deps = {
				sessionsStore: makeStore({
					sessions: [
						recentClaudeSession({ createdAt: FROZEN_NOW - SEVEN_DAYS_MS - 1 }),
						recentClaudeSession({ id: 'sess-2', createdAt: FROZEN_NOW - 30 * 24 * 60 * 60 * 1000 }),
					],
				}) as never,
				agentConfigsStore: makeStore({ configs: {} }) as never,
				settingsStore: makeStore({}) as never,
				agentDetector: makeDetector(FAKE_AGENT) as never,
			};

			await runStartupUsageSampling(deps);

			expect(sampleUsageMock).not.toHaveBeenCalled();
			expect(loggerInfoMock).toHaveBeenCalledWith(
				expect.stringContaining('no recent Claude Code sessions'),
				expect.any(String),
				expect.any(Object)
			);
		});

		it('skips sessions without a createdAt timestamp', async () => {
			const deps = {
				sessionsStore: makeStore({
					sessions: [{ id: 's-1', toolType: 'claude-code', cwd: '/x' /* no createdAt */ }],
				}) as never,
				agentConfigsStore: makeStore({ configs: {} }) as never,
				settingsStore: makeStore({}) as never,
				agentDetector: makeDetector(FAKE_AGENT) as never,
			};

			await runStartupUsageSampling(deps);

			expect(sampleUsageMock).not.toHaveBeenCalled();
		});
	});

	describe('happy path', () => {
		it('samples once and persists the snapshot for a single recent session', async () => {
			const snapshot = makeSnapshot({ configDirKey: '/Users/test/.claude' });
			sampleUsageMock.mockResolvedValue(snapshot);

			const deps = {
				sessionsStore: makeStore({ sessions: [recentClaudeSession()] }) as never,
				agentConfigsStore: makeStore({ configs: {} }) as never,
				settingsStore: makeStore({}) as never,
				agentDetector: makeDetector(FAKE_AGENT) as never,
			};

			await runStartupUsageSampling(deps);

			expect(sampleUsageMock).toHaveBeenCalledTimes(1);
			expect(getSnapshot('/Users/test/.claude')).toEqual(snapshot);
		});

		it('forwards session cwd into the sampleUsage call', async () => {
			sampleUsageMock.mockResolvedValue(makeSnapshot());

			const deps = {
				sessionsStore: makeStore({
					sessions: [recentClaudeSession({ cwd: '/var/projects/very-specific-path' })],
				}) as never,
				agentConfigsStore: makeStore({ configs: {} }) as never,
				settingsStore: makeStore({}) as never,
				agentDetector: makeDetector(FAKE_AGENT) as never,
			};

			await runStartupUsageSampling(deps);

			expect(sampleUsageMock).toHaveBeenCalledWith(
				expect.objectContaining({ cwd: '/var/projects/very-specific-path' })
			);
		});

		it('threads MAESTRO_CLAUDE_BIN from the detected agent path', async () => {
			sampleUsageMock.mockResolvedValue(makeSnapshot());

			const deps = {
				sessionsStore: makeStore({ sessions: [recentClaudeSession()] }) as never,
				agentConfigsStore: makeStore({ configs: {} }) as never,
				settingsStore: makeStore({}) as never,
				agentDetector: makeDetector({ ...FAKE_AGENT, path: '/opt/claude/bin/claude' }) as never,
			};

			await runStartupUsageSampling(deps);

			expect(sampleUsageMock).toHaveBeenCalledWith(
				expect.objectContaining({
					customEnvVars: expect.objectContaining({ MAESTRO_CLAUDE_BIN: '/opt/claude/bin/claude' }),
				})
			);
		});

		it('omits MAESTRO_CLAUDE_BIN when the agent has neither path nor command resolved', async () => {
			// In this fixture neither path nor command is set, so the startup
			// module has nothing safe to thread through.
			sampleUsageMock.mockResolvedValue(makeSnapshot());

			const deps = {
				sessionsStore: makeStore({ sessions: [recentClaudeSession()] }) as never,
				agentConfigsStore: makeStore({ configs: {} }) as never,
				settingsStore: makeStore({}) as never,
				agentDetector: makeDetector({
					id: 'claude-code',
					name: 'Claude Code',
					binaryName: 'claude',
					command: '',
					path: undefined,
					args: [],
					available: true,
				}) as never,
			};

			await runStartupUsageSampling(deps);

			const call = sampleUsageMock.mock.calls[0]?.[0];
			expect(call?.customEnvVars).not.toHaveProperty('MAESTRO_CLAUDE_BIN');
		});
	});

	describe('dedup', () => {
		it('collapses two sessions sharing the same config dir into one sample', async () => {
			sampleUsageMock.mockResolvedValue(makeSnapshot());

			const deps = {
				sessionsStore: makeStore({
					sessions: [
						recentClaudeSession({ id: 'sess-1' }),
						recentClaudeSession({ id: 'sess-2', cwd: '/var/projects/bar' }),
						recentClaudeSession({ id: 'sess-3', cwd: '/var/projects/baz' }),
					],
				}) as never,
				agentConfigsStore: makeStore({ configs: {} }) as never,
				settingsStore: makeStore({}) as never,
				agentDetector: makeDetector(FAKE_AGENT) as never,
			};

			await runStartupUsageSampling(deps);

			expect(sampleUsageMock).toHaveBeenCalledTimes(1);
		});
	});

	describe('multi-account', () => {
		it('samples and stores each unique account independently', async () => {
			sampleUsageMock.mockImplementation(async (opts: { configDir?: string }) => {
				if (opts.configDir === '/Users/test/.claude-gmail') {
					return makeSnapshot({
						configDirKey: '/Users/test/.claude-gmail',
						session: { percent: 30, resetsAt: '2026-05-15T17:00:00.000Z' },
					});
				}
				return makeSnapshot({
					configDirKey: '/Users/test/.claude-smash',
					session: { percent: 80, resetsAt: '2026-05-15T17:00:00.000Z' },
				});
			});

			const deps = {
				sessionsStore: makeStore({
					sessions: [
						recentClaudeSession({
							id: 'sess-gmail',
							customEnvVars: { CLAUDE_CONFIG_DIR: '/Users/test/.claude-gmail' },
						}),
						recentClaudeSession({
							id: 'sess-smash',
							customEnvVars: { CLAUDE_CONFIG_DIR: '/Users/test/.claude-smash' },
						}),
					],
				}) as never,
				agentConfigsStore: makeStore({ configs: {} }) as never,
				settingsStore: makeStore({}) as never,
				agentDetector: makeDetector(FAKE_AGENT) as never,
			};

			await runStartupUsageSampling(deps);

			expect(sampleUsageMock).toHaveBeenCalledTimes(2);
			expect(getSnapshot('/Users/test/.claude-gmail')?.session.percent).toBe(30);
			expect(getSnapshot('/Users/test/.claude-smash')?.session.percent).toBe(80);
		});
	});

	describe('env precedence', () => {
		it('uses agent-level customEnvVars when no session-level override exists', async () => {
			sampleUsageMock.mockResolvedValue(makeSnapshot());

			const deps = {
				sessionsStore: makeStore({ sessions: [recentClaudeSession()] }) as never,
				agentConfigsStore: makeStore({
					configs: {
						'claude-code': { customEnvVars: { CLAUDE_CONFIG_DIR: '/Users/test/.claude-agent' } },
					},
				}) as never,
				settingsStore: makeStore({}) as never,
				agentDetector: makeDetector(FAKE_AGENT) as never,
			};

			await runStartupUsageSampling(deps);

			expect(sampleUsageMock).toHaveBeenCalledWith(
				expect.objectContaining({ configDir: '/Users/test/.claude-agent' })
			);
		});

		it('lets session-level customEnvVars override agent-level customEnvVars', async () => {
			sampleUsageMock.mockResolvedValue(makeSnapshot());

			const deps = {
				sessionsStore: makeStore({
					sessions: [
						recentClaudeSession({
							customEnvVars: { CLAUDE_CONFIG_DIR: '/Users/test/.claude-session' },
						}),
					],
				}) as never,
				agentConfigsStore: makeStore({
					configs: {
						'claude-code': { customEnvVars: { CLAUDE_CONFIG_DIR: '/Users/test/.claude-agent' } },
					},
				}) as never,
				settingsStore: makeStore({}) as never,
				agentDetector: makeDetector(FAKE_AGENT) as never,
			};

			await runStartupUsageSampling(deps);

			expect(sampleUsageMock).toHaveBeenCalledWith(
				expect.objectContaining({ configDir: '/Users/test/.claude-session' })
			);
		});

		it('falls back to ~/.claude when neither agent- nor session-level env vars are set', async () => {
			sampleUsageMock.mockResolvedValue(makeSnapshot({ configDirKey: '/Users/test/.claude' }));

			const deps = {
				sessionsStore: makeStore({ sessions: [recentClaudeSession()] }) as never,
				agentConfigsStore: makeStore({ configs: {} }) as never,
				settingsStore: makeStore({}) as never,
				agentDetector: makeDetector(FAKE_AGENT) as never,
			};

			await runStartupUsageSampling(deps);

			expect(getSnapshot('/Users/test/.claude')).not.toBeNull();
		});

		it('preserves non-CLAUDE_CONFIG_DIR customEnvVars through to sampleUsage', async () => {
			sampleUsageMock.mockResolvedValue(makeSnapshot());

			const deps = {
				sessionsStore: makeStore({
					sessions: [
						recentClaudeSession({
							customEnvVars: {
								ANTHROPIC_API_KEY: 'sk-test',
								CLAUDE_CONFIG_DIR: '/Users/test/.claude-x',
							},
						}),
					],
				}) as never,
				agentConfigsStore: makeStore({
					configs: { 'claude-code': { customEnvVars: { HTTP_PROXY: 'http://proxy:8080' } } },
				}) as never,
				settingsStore: makeStore({}) as never,
				agentDetector: makeDetector(FAKE_AGENT) as never,
			};

			await runStartupUsageSampling(deps);

			expect(sampleUsageMock).toHaveBeenCalledWith(
				expect.objectContaining({
					customEnvVars: expect.objectContaining({
						HTTP_PROXY: 'http://proxy:8080',
						ANTHROPIC_API_KEY: 'sk-test',
					}),
				})
			);
		});
	});

	describe('partial failure', () => {
		it('persists only successful samples when some return null', async () => {
			sampleUsageMock.mockImplementation(async (opts: { configDir?: string }) => {
				if (opts.configDir === '/Users/test/.claude-broken') {
					return null;
				}
				return makeSnapshot({ configDirKey: opts.configDir ?? '/Users/test/.claude' });
			});

			const deps = {
				sessionsStore: makeStore({
					sessions: [
						recentClaudeSession({
							id: 'good',
							customEnvVars: { CLAUDE_CONFIG_DIR: '/Users/test/.claude-good' },
						}),
						recentClaudeSession({
							id: 'broken',
							customEnvVars: { CLAUDE_CONFIG_DIR: '/Users/test/.claude-broken' },
						}),
					],
				}) as never,
				agentConfigsStore: makeStore({ configs: {} }) as never,
				settingsStore: makeStore({}) as never,
				agentDetector: makeDetector(FAKE_AGENT) as never,
			};

			await runStartupUsageSampling(deps);

			expect(getSnapshot('/Users/test/.claude-good')).not.toBeNull();
			expect(getSnapshot('/Users/test/.claude-broken')).toBeNull();
			expect(loggerWarnMock).toHaveBeenCalledWith(
				expect.stringContaining('maestro-p --status sample failed'),
				expect.any(String),
				expect.objectContaining({ configDirKey: '/Users/test/.claude-broken' })
			);
		});
	});

	describe('configDirKey canonicalization', () => {
		it('dedups two sessions whose config dirs differ only by trailing slash / redundant separators', async () => {
			sampleUsageMock.mockResolvedValue(makeSnapshot());

			const deps = {
				sessionsStore: makeStore({
					sessions: [
						recentClaudeSession({
							id: 's-a',
							customEnvVars: { CLAUDE_CONFIG_DIR: '/Users/test/.claude-x/' },
						}),
						recentClaudeSession({
							id: 's-b',
							customEnvVars: { CLAUDE_CONFIG_DIR: '/Users/test/./.claude-x' },
						}),
					],
				}) as never,
				agentConfigsStore: makeStore({ configs: {} }) as never,
				settingsStore: makeStore({}) as never,
				agentDetector: makeDetector(FAKE_AGENT) as never,
			};

			await runStartupUsageSampling(deps);

			expect(sampleUsageMock).toHaveBeenCalledTimes(1);
		});
	});

	describe('now() override', () => {
		it('respects the injected now() for the 7-day cutoff', async () => {
			// Use an explicit `now` 30 days past FROZEN_NOW. Sessions created at
			// FROZEN_NOW are 30 days old by the injected clock, so they should
			// all be excluded.
			const deps = {
				sessionsStore: makeStore({ sessions: [recentClaudeSession()] }) as never,
				agentConfigsStore: makeStore({ configs: {} }) as never,
				settingsStore: makeStore({}) as never,
				agentDetector: makeDetector(FAKE_AGENT) as never,
				now: () => FROZEN_NOW + 30 * 24 * 60 * 60 * 1000,
			};

			await runStartupUsageSampling(deps);

			expect(sampleUsageMock).not.toHaveBeenCalled();
		});
	});
});
