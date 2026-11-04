import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import path from 'path';
import type { ExecResult } from '../../../main/utils/execFile';
import type { SshRemoteConfig } from '../../../shared/types';
import type { AgentDetector } from '../../../main/agents/detector';

vi.mock('fs/promises', async (original) => {
	const actual = await original<typeof import('fs/promises')>();
	return { ...actual, default: { ...actual, realpath: vi.fn() } };
});
vi.mock('../../../main/utils/execFile', () => ({ execFileNoThrow: vi.fn() }));
vi.mock('../../../main/utils/ssh-command-builder', () => ({ buildSshCommand: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { execFileNoThrow } from '../../../main/utils/execFile';
import { buildSshCommand } from '../../../main/utils/ssh-command-builder';
import { logger } from '../../../main/utils/logger';

describe('shared model discovery activity', () => {
	const target = path.resolve('model-discovery-target');
	const success = { stdout: 'provider/model\nprovider/model\n', stderr: '', exitCode: 0 };
	const remote: SshRemoteConfig = {
		id: 'remote',
		name: 'Remote',
		host: 'remote.example',
		port: 22,
		username: 'test',
		privateKeyPath: '',
		enabled: true,
		remoteEnv: { MODEL_ENV: 'remote-value' },
	};
	let gate: typeof import('../../../main/git/worktreeActivity');
	let discovery: typeof import('../../../main/agents/model-discovery');
	let natives: Array<{
		child: EventEmitter;
		result: ReturnType<typeof Promise.withResolvers<ExecResult>>;
	}>;
	let releases: Array<() => void>;
	const localModels = vi.fn();
	const deps = {
		getAgentDetector: vi.fn(() => ({ discoverModels: localModels }) as unknown as AgentDetector),
		getSshRemote: vi.fn(() => remote),
	};
	const drain = () => new Promise(setImmediate);
	async function reserve(root = target) {
		const hold = await gate.reserveWorktreeCleanup(root);
		if (hold.status === 'reserved-partially') releases.push(hold.release);
		expect(hold.status).toBe('reserved-partially');
		if (hold.status !== 'reserved-partially') throw new Error('Expected partial reservation');
		expect(hold.blockers.map((b) => b.message).join(' ')).toMatch(/native.*registration.*OS/);
		return hold;
	}
	async function blocked() {
		const hold = await gate.reserveWorktreeCleanup(target);
		if (hold.status === 'reserved-partially') releases.push(hold.release);
		expect(hold).toMatchObject({ status: 'blocked', blockers: [{ code: 'mutation-busy' }] });
	}
	beforeEach(async () => {
		vi.resetModules();
		vi.mocked(fs.realpath)
			.mockReset()
			.mockImplementation(async (p) => String(p));
		for (const mock of [logger.info, logger.warn, logger.debug]) vi.mocked(mock).mockReset();
		deps.getAgentDetector.mockClear();
		deps.getSshRemote.mockClear();
		localModels.mockReset().mockResolvedValue(['local-model']);
		vi.mocked(buildSshCommand)
			.mockReset()
			.mockResolvedValue({ command: '/bin/ssh', args: ['wire'] });
		natives = [];
		releases = [];
		vi.mocked(execFileNoThrow)
			.mockReset()
			.mockImplementation((_cmd, _args, _cwd, _opts, observe) => {
				const child = new EventEmitter();
				child.on('error', () => {});
				const result = Promise.withResolvers<ExecResult>();
				natives.push({ child, result });
				observe?.(child as Parameters<NonNullable<typeof observe>>[0]);
				return result.promise;
			});
		gate = await import('../../../main/git/worktreeActivity');
		discovery = await import('../../../main/agents/model-discovery');
	});
	afterEach(async () => {
		for (let i = 0; i < natives.length; i++) {
			natives[i].result.resolve(success);
			natives[i].child.emit('close');
			await drain();
		}
		for (const release of releases) release();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it.each([target, path.join(target, 'descendant'), path.resolve('unrelated-repository')])(
		'refuses both exports before options, dependencies, cache, SSH or recovery under %s',
		async (root) => {
			await reserve(root);
			const options = {
				get agentId(): string {
					throw new Error('options touched');
				},
			};
			const config = {
				get id(): string {
					throw new Error('config touched');
				},
			} as SshRemoteConfig;
			await expect(discovery.discoverAgentModels(deps, options)).rejects.toThrow(/reserved/);
			await expect(discovery.discoverModelsRemote('omp', config, false)).rejects.toThrow(
				/reserved/
			);
			expect(deps.getAgentDetector).not.toHaveBeenCalled();
			expect(deps.getSshRemote).not.toHaveBeenCalled();
			expect(buildSshCommand).not.toHaveBeenCalled();
			expect(execFileNoThrow).not.toHaveBeenCalled();
			expect(logger.info).not.toHaveBeenCalled();
			expect(logger.warn).not.toHaveBeenCalled();
		}
	);

	it('holds local requests independently during pending canonicalization and concurrent discovery', async () => {
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const reservation = gate.reserveWorktreeCleanup(target);
		const first = Promise.withResolvers<string[]>(),
			second = Promise.withResolvers<string[]>();
		localModels.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const a = discovery.discoverAgentModels(deps, { agentId: 'omp' });
		const b = discovery.discoverAgentModels(deps, { agentId: 'omp', forceRefresh: true });
		canonical.resolve(target);
		await expect(reservation).resolves.toMatchObject({ status: 'blocked' });
		first.resolve(['first']);
		await expect(a).resolves.toEqual(['first']);
		await blocked();
		second.resolve(['second']);
		await expect(b).resolves.toEqual(['second']);
		expect(localModels.mock.calls).toEqual([
			['omp', false],
			['omp', true],
		]);
		expect(execFileNoThrow).not.toHaveBeenCalled();
		await reserve();
	});

	it('holds pending SSH setup and preserves remote routing, argv, parsing, cache and refresh', async () => {
		const setup = Promise.withResolvers<Awaited<ReturnType<typeof buildSshCommand>>>();
		vi.mocked(buildSshCommand).mockReturnValueOnce(setup.promise);
		const a = discovery.discoverAgentModels(deps, { agentId: 'omp', sshRemoteId: 'remote' });
		await blocked();
		setup.resolve({ command: '/bin/ssh', args: ['wire'] });
		await drain();
		expect(buildSshCommand).toHaveBeenCalledWith(remote, {
			command: 'omp',
			args: ['models', '--json'],
			env: remote.remoteEnv,
		});
		natives[0].result.resolve({
			...success,
			stdout: '{"models":[{"selector":"p/m"},{"id":"p/m"}]}',
		});
		await expect(a).resolves.toEqual(['p/m']);
		expect(execFileNoThrow).toHaveBeenCalledWith(
			'/bin/ssh',
			['wire'],
			undefined,
			undefined,
			expect.any(Function)
		);
		expect(deps.getAgentDetector).not.toHaveBeenCalled();
		await blocked();
		natives[0].child.emit('close');
		const hold = await reserve();
		await expect(discovery.discoverModelsRemote('omp', remote, false)).rejects.toThrow(/reserved/);
		hold.release();
		await expect(discovery.discoverModelsRemote('omp', remote, false)).resolves.toEqual(['p/m']);
		expect(natives).toHaveLength(1);
		const refreshed = discovery.discoverModelsRemote('omp', remote, true);
		await drain();
		natives[1].result.resolve({ ...success, stdout: '{"models":[{"id":"fresh"}]}' });
		await expect(refreshed).resolves.toEqual(['fresh']);
		await blocked();
		natives[1].child.emit('close');
		await reserve();
	});

	it('retains overlapping remote CLI/config children across config timeout and late settlement', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const request = discovery.discoverModelsRemote('opencode', remote, false);
		await drain();
		natives[0].result.resolve(success);
		await drain();
		expect(natives).toHaveLength(2);
		expect(vi.mocked(buildSshCommand).mock.calls[1][1]).toMatchObject({
			command: 'sh',
			env: remote.remoteEnv,
		});
		await vi.advanceTimersByTimeAsync(discovery.SSH_MODEL_TIMEOUT_MS);
		await expect(request).resolves.toEqual(['provider/model']);
		natives[1].child.emit('close');
		await blocked();
		natives[0].child.emit('exit', 0);
		natives[0].child.emit('error', new Error('late error'));
		await blocked();
		natives[0].child.emit('close');
		await reserve();
		natives[1].result.resolve(success);
	});

	it('keeps a timed-out remote request child busy through a concurrent retry', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const request = discovery.discoverModelsRemote('grok', remote, false);
		await drain();
		await vi.advanceTimersByTimeAsync(discovery.SSH_MODEL_TIMEOUT_MS);
		await expect(request).resolves.toEqual([]);
		const retry = discovery.discoverModelsRemote('grok', remote, false);
		await drain();
		natives[1].child.emit('close');
		natives[1].result.resolve(success);
		await retry;
		await blocked();
		natives[0].child.emit('close');
		await reserve();
	});

	it('preserves the remote cache TTL and refreshes an expired result', async () => {
		const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
		const request = discovery.discoverModelsRemote('grok', remote, false);
		await drain();
		natives[0].result.resolve(success);
		natives[0].child.emit('close');
		await request;
		clock.mockReturnValue(300999);
		await expect(discovery.discoverModelsRemote('grok', remote, false)).resolves.toEqual([
			'provider/model',
		]);
		expect(natives).toHaveLength(1);
		clock.mockReturnValue(301000);
		const expired = discovery.discoverModelsRemote('grok', remote, false);
		await drain();
		natives[1].result.resolve({ ...success, stdout: 'new/model' });
		await expect(expired).resolves.toEqual(['new/model']);
		await blocked();
		natives[1].child.emit('close');
		await reserve();
	});

	it.each(['config setup', 'config result', 'CLI reporting'])(
		'keeps child ownership across %s recovery',
		async (mode) => {
			const request = discovery.discoverModelsRemote('opencode', remote, true);
			await drain();
			if (mode === 'config setup')
				vi.mocked(buildSshCommand).mockRejectedValueOnce(new Error(mode));
			if (mode === 'CLI reporting')
				vi.mocked(logger.warn).mockImplementationOnce(() => {
					throw new Error(mode);
				});
			const settled =
				mode === 'CLI reporting'
					? expect(request).rejects.toThrow(mode)
					: expect(request).resolves.toEqual(['provider/model']);
			natives[0].result.resolve(mode === 'CLI reporting' ? { ...success, exitCode: 1 } : success);
			await drain();
			if (mode === 'config result') natives[1].result.reject(new Error(mode));
			await settled;
			await blocked();
			for (const native of natives) native.child.emit('close');
			await reserve();
		}
	);

	it('keeps the outer request through close-before-result, config merging and broadcast recovery', async () => {
		const broadcast = vi.fn(() => {
			throw new Error('window closed');
		});
		discovery.setModelsRefreshedBroadcaster(broadcast);
		const request = discovery.discoverAgentModels(deps, {
			agentId: 'opencode',
			sshRemoteId: 'remote',
			forceRefresh: true,
		});
		await drain();
		natives[0].child.emit('close');
		await blocked();
		natives[0].result.resolve(success);
		await drain();
		natives[1].child.emit('close');
		await blocked();
		natives[1].result.resolve({
			...success,
			stdout: '___OPENCODE_CONFIG_START___\n{"model":"config/model"}\n___OPENCODE_CONFIG_END___',
		});
		await expect(request).resolves.toEqual(['provider/model', 'config/model']);
		expect(broadcast).toHaveBeenCalledWith('agents:modelsRefreshed', {
			agentId: 'opencode',
			sshRemoteId: 'remote',
			models: ['provider/model', 'config/model'],
		});
		expect(logger.debug).toHaveBeenCalledWith(
			'Failed to broadcast refreshed models',
			expect.any(String),
			{ error: 'Error: window closed' }
		);
		await reserve();
	});

	it.each(['setup', 'local', 'reporting', 'options'])(
		'releases a failed %s request without an unobserved child',
		async (mode) => {
			if (mode === 'setup')
				deps.getAgentDetector.mockImplementationOnce(() => {
					throw new Error('setup');
				});
			if (mode === 'local') localModels.mockRejectedValueOnce(new Error('local'));
			if (mode === 'reporting')
				vi.mocked(logger.info).mockImplementationOnce(() => {
					throw new Error('reporting');
				});
			const options =
				mode === 'options'
					? {
							get agentId(): string {
								throw new Error('options');
							},
						}
					: { agentId: 'omp' };
			await expect(discovery.discoverAgentModels(deps, options)).rejects.toThrow(mode);
			await reserve();
		}
	);

	it('releases SSH setup failure but retains an observed child on command rejection', async () => {
		vi.mocked(buildSshCommand).mockRejectedValueOnce(new Error('SSH setup'));
		await expect(discovery.discoverModelsRemote('omp', remote, true)).rejects.toThrow('SSH setup');
		(await reserve()).release();
		const request = discovery.discoverModelsRemote('omp', remote, true);
		await drain();
		natives[0].result.reject(new Error('command rejected'));
		await expect(request).rejects.toThrow('command rejected');
		await blocked();
		natives[0].child.emit('close');
		await reserve();
	});

	it.each(['cli', 'config'])('fails closed for missing %s native observation', async (mode) => {
		const unobserved = () => Promise.resolve(success);
		if (mode === 'cli') vi.mocked(execFileNoThrow).mockImplementationOnce(unobserved);
		const request = discovery.discoverModelsRemote(
			mode === 'cli' ? 'grok' : 'opencode',
			remote,
			true
		);
		await drain();
		if (mode === 'config') {
			vi.mocked(execFileNoThrow).mockImplementationOnce(unobserved);
			natives[0].child.emit('close');
			natives[0].result.resolve(success);
		}
		await request;
		await blocked();
	});

	it.each(['unknown launch', 'failed observer'])('fails closed on %s', async (mode) => {
		vi.mocked(execFileNoThrow).mockImplementationOnce((_cmd, _args, _cwd, _opts, observe) => {
			if (mode === 'unknown launch') throw new Error(mode);
			observe?.(undefined!);
			return Promise.resolve(success);
		});
		await expect(discovery.discoverModelsRemote('grok', remote, true)).rejects.toThrow();
		await blocked();
	});
});
