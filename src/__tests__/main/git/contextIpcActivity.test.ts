import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import type { ContextHandlerDependencies } from '../../../main/ipc/handlers/context';

vi.mock('fs/promises', async (original) => {
	const actual = await original<typeof import('fs/promises')>();
	return { ...actual, default: { ...actual, realpath: vi.fn() } };
});
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/process-manager', () => ({}));
vi.mock('../../../main/agents', () => ({ getSessionStorage: vi.fn() }));
vi.mock('../../../main/stores', () => ({ getSettingsStore: vi.fn() }));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../main/utils/ssh-remote-resolver', () => ({
	createSshRemoteStoreAdapter: vi.fn(() => ({ remote: true })),
}));
vi.mock('../../../main/utils/context-groomer', () => ({
	groomContext: vi.fn(),
	cancelAllGroomingSessions: vi.fn(),
}));

import { ipcMain } from 'electron';
import { logger } from '../../../main/utils/logger';
import { groomContext, cancelAllGroomingSessions } from '../../../main/utils/context-groomer';
import { getSettingsStore } from '../../../main/stores';

describe('context IPC operation activity', () => {
	const target = path.resolve('context-ipc-target');
	const response = { response: 'summary', durationMs: 10, completionReason: 'exit' };
	let gate: typeof import('../../../main/git/worktreeActivity');
	let releases: Array<() => void>;
	let active: number;
	let deps: ContextHandlerDependencies;
	type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
	const handler = (channel: string) =>
		vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel)![1] as Handler;
	const start = (options?: unknown) =>
		handler('context:groomContext')({}, '~/remote-only', 'codex', 'summarize', options);
	const cancel = () => handler('context:cancelGrooming')({});
	async function reservation(root = target) {
		const hold = await gate.reserveWorktreeCleanup(root);
		if (hold.status === 'reserved-partially') releases.push(hold.release);
		return hold;
	}
	async function idle(root = target) {
		const hold = await reservation(root);
		expect(hold.status).toBe('reserved-partially');
		if (hold.status !== 'reserved-partially') throw new Error('Expected partial reservation');
		expect(hold.blockers.map((b) => b.message).join(' ')).toMatch(/native.*registration.*OS/);
		return hold;
	}
	const busy = async () =>
		expect(await reservation()).toMatchObject({
			status: 'blocked',
			blockers: [{ code: 'mutation-busy' }],
		});
	beforeEach(async () => {
		vi.resetModules();
		vi.resetAllMocks();
		releases = [];
		vi.mocked(fs.realpath).mockImplementation(async (p) => String(p));
		vi.mocked(groomContext).mockResolvedValue(response);
		deps = {
			getMainWindow: vi.fn(() => null),
			getProcessManager: vi.fn(() => ({}) as never),
			getAgentDetector: vi.fn(() => ({}) as never),
			agentConfigsStore: { get: vi.fn(() => ({})) } as never,
			settingsStore: { get: vi.fn((_key, fallback) => fallback) } as never,
		};
		gate = await import('../../../main/git/worktreeActivity');
		active = 0;
		const admit = gate.beginGlobalWorktreeActivity;
		vi.spyOn(gate, 'beginGlobalWorktreeActivity').mockImplementation(() => {
			const release = admit();
			active++;
			let released = false;
			return () => {
				if (released) return;
				released = true;
				active--;
				release();
			};
		});
		const { registerContextHandlers } = await import('../../../main/ipc/handlers/context');
		registerContextHandlers(deps);
		vi.mocked(logger.info).mockClear();
	});
	afterEach(() => releases.forEach((release) => release()));

	it.each([target, path.join(target, 'child'), path.resolve('other-repository')])(
		'refuses start and cancel before setup or recovery under %s',
		async (root) => {
			await idle(root);
			const read = vi.fn(() => {
				throw new Error('options read');
			});
			await expect(start(new Proxy({}, { get: read }))).rejects.toThrow(/reserved/);
			await expect(cancel()).rejects.toThrow(/reserved/);
			for (const work of [
				read,
				deps.getProcessManager,
				deps.getAgentDetector,
				deps.settingsStore.get,
				deps.agentConfigsStore.get,
				getSettingsStore,
				groomContext,
				cancelAllGroomingSessions,
				logger.info,
			])
				expect(work).not.toHaveBeenCalled();
		}
	);
	it('admits before pending reservation canonicalization settles', async () => {
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const hold = reservation();
		const completion = Promise.withResolvers<typeof response>();
		vi.mocked(groomContext).mockReturnValueOnce(completion.promise);
		const pending = start();
		canonical.resolve(target);
		await expect(hold).resolves.toMatchObject({ status: 'blocked' });
		await busy();
		completion.resolve(response);
		await expect(pending).resolves.toBe('summary');
		await idle();
	});
	it('retains concurrent requests independently of nested utility admission', async () => {
		const first = Promise.withResolvers<typeof response>();
		const second = Promise.withResolvers<typeof response>();
		vi.mocked(groomContext).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const one = start();
		const two = start();
		await busy();
		first.resolve(response);
		await one;
		await busy();
		second.resolve(response);
		await two;
		await idle();
	});
	it.each(['process', 'detector', 'settings', 'configs', 'options'])(
		'admits before %s setup and releases on its failure',
		async (stage) => {
			let during: number | undefined;
			const fail = () => {
				during = active;
				throw new Error(stage);
			};
			if (stage === 'process') vi.mocked(deps.getProcessManager).mockImplementationOnce(fail);
			if (stage === 'detector') vi.mocked(deps.getAgentDetector).mockImplementationOnce(fail);
			if (stage === 'settings') vi.mocked(deps.settingsStore.get).mockImplementationOnce(fail);
			if (stage === 'configs') vi.mocked(deps.agentConfigsStore.get).mockImplementationOnce(fail);
			await expect(
				start(stage === 'options' ? new Proxy({}, { get: fail }) : undefined)
			).rejects.toThrow(stage);
			expect(during).toBe(1);
			expect(groomContext).not.toHaveBeenCalled();
			await idle();
		}
	);
	it.each([false, true])(
		'holds result extraction even after nested settlement (fail=%s)',
		async (fail) => {
			let during: number | undefined;
			vi.mocked(groomContext).mockResolvedValueOnce({
				...response,
				get response() {
					during = active;
					if (fail) throw new Error('result extraction');
					return 'summary';
				},
			});
			if (fail) await expect(start()).rejects.toThrow('result extraction');
			else await expect(start()).resolves.toBe('summary');
			expect(during).toBe(1);
			await idle();
		}
	);
	it('preserves utility configuration, SSH and answer-only options', async () => {
		vi.mocked(deps.settingsStore.get).mockImplementation((key, fallback) =>
			key === 'utilityAgentId'
				? 'claude-code'
				: key === 'utilityModelId'
					? 'utility-model'
					: fallback
		);
		const sshRemoteConfig = { enabled: true, remoteId: 'remote' };
		await expect(
			start({
				sshRemoteConfig,
				customPath: 'session-binary',
				customArgs: '--session',
				customEnvVars: { PRIVATE: 'session' },
				claudeTokenSource: {},
				readOnly: true,
				disableTools: true,
				timeoutMs: 1234,
			})
		).resolves.toBe('summary');
		expect(groomContext).toHaveBeenCalledWith(
			expect.objectContaining({
				projectRoot: '~/remote-only',
				agentType: 'claude-code',
				modelId: 'utility-model',
				sessionSshRemoteConfig: sshRemoteConfig,
				readOnlyMode: true,
				disableTools: true,
				timeoutMs: 1234,
				sessionCustomPath: undefined,
				sessionCustomArgs: undefined,
				sessionCustomEnvVars: undefined,
				claudeTokenSource: undefined,
			}),
			expect.any(Object),
			expect.any(Object)
		);
		expect(vi.mocked(fs.realpath).mock.calls).toEqual([]);
		await idle();
	});
	it.each(['logging', 'callback', 'failure'])(
		'holds cancel %s before nested work and releases on every outcome',
		async (stage) => {
			let during: number | undefined;
			const inspect = () => {
				during = active;
			};
			if (stage === 'logging') vi.mocked(logger.info).mockImplementationOnce(inspect);
			else
				vi.mocked(cancelAllGroomingSessions).mockImplementationOnce(() => {
					inspect();
					if (stage === 'failure') throw new Error('cancel failure');
				});
			if (stage === 'failure') await expect(cancel()).rejects.toThrow('cancel failure');
			else await expect(cancel()).resolves.toBeUndefined();
			expect(during).toBe(1);
			await idle();
		}
	);
	it('preserves nested errors and releases only its own request', async () => {
		const releaseNative = gate.beginGlobalWorktreeActivity();
		releases.push(releaseNative);
		const error = new Error('provider failure');
		vi.mocked(groomContext).mockRejectedValueOnce(error);
		await expect(start()).rejects.toBe(error);
		await busy();
		releaseNative();
		await idle();
	});
});
