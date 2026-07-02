/**
 * Tests for src/main/agents/codex-usage-startup.ts
 *
 * Covers review-sensitive behavior:
 *   - corrupted CODEX_HOME values fall back to the default account home
 *   - recoverable account failures do not cancel sampling for the rest of the batch
 *   - unexpected account failures are reported after the rest of the batch runs
 *   - discovery only swallows expected missing/unreadable auth.json errors
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canonKey } from '../../helpers/pathExpect';

const { sampleCodexUsageMock, loggerWarnMock, loggerInfoMock, captureExceptionMock } = vi.hoisted(
	() => ({
		sampleCodexUsageMock: vi.fn(),
		loggerWarnMock: vi.fn(),
		loggerInfoMock: vi.fn(),
		captureExceptionMock: vi.fn(),
	})
);

vi.mock('../../../main/agents/codex-usage-sampler', () => ({
	sampleCodexUsage: sampleCodexUsageMock,
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		warn: loggerWarnMock,
		info: loggerInfoMock,
		debug: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: captureExceptionMock,
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

import {
	discoverCodexHomes,
	runCodexUsageSampling,
} from '../../../main/agents/codex-usage-startup';
import {
	clearCodexUsageSnapshots,
	getAllCodexUsageSnapshots,
	resolveCodexHomeKey,
	__resetForTests as resetCodexUsageStore,
	type CodexUsageSnapshot,
} from '../../../main/stores/codexUsageStore';

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

function makeSnapshot(codexHomeKey: string): CodexUsageSnapshot {
	return {
		sampledAt: new Date().toISOString(),
		codexHomeKey,
		authState: 'authenticated',
		session: { percent: 25, resetsAt: '2026-05-15T05:00:00.000Z' },
		weekly: { percent: 50, resetsAt: '2026-05-22T00:00:00.000Z' },
	};
}

function makeDirent(name: string, isDirectory = true): fs.Dirent {
	return { name, isDirectory: () => isDirectory } as fs.Dirent;
}

const FAKE_AGENT = {
	id: 'codex',
	name: 'Codex',
	binaryName: 'codex',
	command: 'codex',
	path: '/usr/local/bin/codex',
	args: [],
	available: true,
};

describe('codex-usage-startup → discoverCodexHomes', () => {
	beforeEach(() => {
		captureExceptionMock.mockReset();
	});

	it('returns no homes for recoverable home directory read failures', async () => {
		const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
		const readdirSpy = vi.spyOn(fs.promises, 'readdir').mockRejectedValue(denied);

		try {
			await expect(discoverCodexHomes('/Users/test')).resolves.toEqual([]);
			expect(captureExceptionMock).not.toHaveBeenCalled();
		} finally {
			readdirSpy.mockRestore();
		}
	});

	it('reports and rethrows unexpected home directory read failures', async () => {
		const unexpected = Object.assign(new Error('disk failure'), { code: 'EIO' });
		const readdirSpy = vi.spyOn(fs.promises, 'readdir').mockRejectedValue(unexpected);

		try {
			await expect(discoverCodexHomes('/Users/test')).rejects.toThrow('disk failure');
			expect(captureExceptionMock).toHaveBeenCalledWith(unexpected, {
				operation: 'codexUsage:discoverCodexHomes.readdir',
				homeDir: '/Users/test',
			});
		} finally {
			readdirSpy.mockRestore();
		}
	});

	it('skips homes with missing or unreadable auth.json files', async () => {
		const readdirSpy = vi
			.spyOn(fs.promises, 'readdir')
			.mockResolvedValue([
				makeDirent('.codex-missing'),
				makeDirent('.codex-denied'),
				makeDirent('.codex-good'),
			] as never);
		const accessSpy = vi
			.spyOn(fs.promises, 'access')
			.mockImplementation(async (authPath: fs.PathLike) => {
				const pathText = String(authPath);
				if (pathText.includes('.codex-missing')) {
					throw Object.assign(new Error('missing'), { code: 'ENOENT' });
				}
				if (pathText.includes('.codex-denied')) {
					throw Object.assign(new Error('denied'), { code: 'EACCES' });
				}
			});

		try {
			await expect(discoverCodexHomes('/Users/test')).resolves.toEqual([
				path.join('/Users/test', '.codex-good'),
			]);
			expect(captureExceptionMock).not.toHaveBeenCalled();
		} finally {
			readdirSpy.mockRestore();
			accessSpy.mockRestore();
		}
	});

	it('reports and rethrows unexpected auth.json access errors', async () => {
		const unexpected = Object.assign(new Error('disk failure'), { code: 'EIO' });
		const readdirSpy = vi
			.spyOn(fs.promises, 'readdir')
			.mockResolvedValue([makeDirent('.codex-broken')] as never);
		const accessSpy = vi.spyOn(fs.promises, 'access').mockRejectedValue(unexpected);

		try {
			await expect(discoverCodexHomes('/Users/test')).rejects.toThrow('disk failure');
			expect(captureExceptionMock).toHaveBeenCalledWith(unexpected, {
				operation: 'codexUsage:discoverCodexHomes.access',
				codexHome: path.join('/Users/test', '.codex-broken'),
				authPath: path.join('/Users/test', '.codex-broken', 'auth.json'),
			});
		} finally {
			readdirSpy.mockRestore();
			accessSpy.mockRestore();
		}
	});
});

describe('codexUsageStore → resolveCodexHomeKey', () => {
	it('falls back to the default CODEX_HOME for an empty env value', () => {
		expect(resolveCodexHomeKey({ CODEX_HOME: '' })).toBe(
			canonKey(path.join(os.homedir(), '.codex'))
		);
	});
});

describe('codex-usage-startup → runCodexUsageSampling', () => {
	beforeEach(() => {
		sampleCodexUsageMock.mockReset();
		loggerWarnMock.mockReset();
		loggerInfoMock.mockReset();
		captureExceptionMock.mockReset();
		resetCodexUsageStore();
		clearCodexUsageSnapshots();
	});

	it('falls back to the default CODEX_HOME when stored env is corrupted', async () => {
		sampleCodexUsageMock.mockResolvedValue(makeSnapshot('/Users/test/.codex'));

		await runCodexUsageSampling({
			sessionsStore: makeStore({
				sessions: [
					{
						id: 'codex-1',
						toolType: 'codex',
						cwd: '/tmp',
						customEnvVars: { CODEX_HOME: { bad: true } },
					},
				],
			}) as never,
			agentConfigsStore: makeStore({ configs: {} }) as never,
			agentDetector: makeDetector(FAKE_AGENT) as never,
		});

		expect(sampleCodexUsageMock).toHaveBeenCalledWith({
			codexHome: path.join(os.homedir(), '.codex'),
		});
		expect(getAllCodexUsageSnapshots()).toHaveProperty('/Users/test/.codex');
	});

	it('continues sampling other accounts when one account throws a recoverable error', async () => {
		const recoverable = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
		sampleCodexUsageMock.mockImplementation(async ({ codexHome }: { codexHome: string }) => {
			if (codexHome === '/Users/test/.codex-broken') {
				throw recoverable;
			}
			return makeSnapshot(codexHome);
		});

		await runCodexUsageSampling({
			sessionsStore: makeStore({
				sessions: [
					{
						id: 'codex-good',
						toolType: 'codex',
						cwd: '/tmp',
						customEnvVars: { CODEX_HOME: '/Users/test/.codex-good' },
					},
					{
						id: 'codex-broken',
						toolType: 'codex',
						cwd: '/tmp',
						customEnvVars: { CODEX_HOME: '/Users/test/.codex-broken' },
					},
				],
			}) as never,
			agentConfigsStore: makeStore({ configs: {} }) as never,
			agentDetector: makeDetector(FAKE_AGENT) as never,
		});

		const snapshots = getAllCodexUsageSnapshots();
		expect(sampleCodexUsageMock).toHaveBeenCalledTimes(2);
		expect(snapshots).toHaveProperty('/Users/test/.codex-good');
		expect(snapshots).not.toHaveProperty('/Users/test/.codex-broken');
		expect(captureExceptionMock).not.toHaveBeenCalled();
		expect(loggerWarnMock).toHaveBeenCalledWith(
			expect.stringContaining('Failed to sample Codex usage snapshot'),
			expect.any(String),
			expect.objectContaining({
				codexHomeKey: canonKey('/Users/test/.codex-broken'),
				error: 'timed out',
			})
		);
	});

	it('samples remaining accounts before surfacing unexpected account errors', async () => {
		const unexpected = new Error('boom');
		sampleCodexUsageMock.mockImplementation(async ({ codexHome }: { codexHome: string }) => {
			if (codexHome === '/Users/test/.codex-broken') {
				throw unexpected;
			}
			return makeSnapshot(codexHome);
		});

		await expect(
			runCodexUsageSampling({
				sessionsStore: makeStore({
					sessions: [
						{
							id: 'codex-good',
							toolType: 'codex',
							cwd: '/tmp',
							customEnvVars: { CODEX_HOME: '/Users/test/.codex-good' },
						},
						{
							id: 'codex-broken',
							toolType: 'codex',
							cwd: '/tmp',
							customEnvVars: { CODEX_HOME: '/Users/test/.codex-broken' },
						},
					],
				}) as never,
				agentConfigsStore: makeStore({ configs: {} }) as never,
				agentDetector: makeDetector(FAKE_AGENT) as never,
			})
		).rejects.toThrow('boom');

		const snapshots = getAllCodexUsageSnapshots();
		expect(sampleCodexUsageMock).toHaveBeenCalledTimes(2);
		expect(snapshots).toHaveProperty('/Users/test/.codex-good');
		expect(snapshots).not.toHaveProperty('/Users/test/.codex-broken');
		expect(captureExceptionMock).toHaveBeenCalledWith(unexpected, {
			operation: 'codexUsage:runCodexUsageSampling.sample',
			codexHome: '/Users/test/.codex-broken',
			codexHomeKey: canonKey('/Users/test/.codex-broken'),
		});
		expect(loggerWarnMock).toHaveBeenCalledWith(
			expect.stringContaining('Unexpected failure while sampling Codex usage snapshot'),
			expect.any(String),
			expect.objectContaining({
				codexHomeKey: canonKey('/Users/test/.codex-broken'),
				error: 'boom',
			})
		);
	});
});
