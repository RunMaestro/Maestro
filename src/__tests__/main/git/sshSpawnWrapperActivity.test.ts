import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import path from 'path';
import type { ExecResult } from '../../../main/utils/execFile';
import type { SshSpawnWrapConfig } from '../../../main/utils/ssh-spawn-wrapper';
import type { SshRemoteConfig } from '../../../shared/types';

vi.mock('fs/promises', async (original) => {
	const actual = await original<typeof import('fs/promises')>();
	return { ...actual, default: { ...actual, realpath: vi.fn() } };
});
vi.mock('../../../main/utils/execFile', () => ({ execFileNoThrow: vi.fn() }));
vi.mock('../../../shared/maestro-lib/launch/exec-file', () => ({ execFileNoThrow: vi.fn() }));
vi.mock('../../../shared/pathUtils', async (original) => ({
	...(await original<typeof import('../../../shared/pathUtils')>()),
	buildExpandedEnv: vi.fn(),
}));
import { execFileNoThrow } from '../../../main/utils/execFile';
import { execFileNoThrow as libraryExec } from '../../../shared/maestro-lib/launch/exec-file';
import { buildExpandedEnv } from '../../../shared/pathUtils';

describe('desktop SSH spawn wrapping activity', () => {
	const target = path.resolve('ssh-wrapper-target');
	const remote: SshRemoteConfig = {
		id: 'remote',
		name: 'Remote',
		host: 'example.invalid',
		port: 2222,
		username: 'worker',
		privateKeyPath: '',
		enabled: true,
	};
	const ssh = { enabled: true, remoteId: remote.id };
	const config: SshSpawnWrapConfig = {
		command: '/local/bin/claude',
		agentBinaryName: 'claude',
		args: ['--print'],
		cwd: '~/remote project',
		prompt: 'hello',
		customEnvVars: { KEPT: 'a b', BLANK: '' },
		querySource: 'cue',
		isWindowsHost: false,
	};
	const found = { stdout: '/custom/ssh\r\n/other/ssh\n', stderr: '', exitCode: 0 };
	const absent = { stdout: '', stderr: 'not found', exitCode: 1 };
	let gate: typeof import('../../../main/git/worktreeActivity');
	let desktop: typeof import('../../../main/utils/ssh-spawn-wrapper');
	let core: typeof import('../../../shared/maestro-lib/launch/ssh-spawn-wrapper');
	let builders: typeof import('../../../main/utils/ssh-command-builder');
	let host: typeof import('../../../shared/maestro-lib/host');
	let store: { getSshRemotes: ReturnType<typeof vi.fn<() => SshRemoteConfig[]>> };
	let releases: Array<() => void>;
	let natives: Array<{
		child: EventEmitter;
		result: ReturnType<typeof Promise.withResolvers<ExecResult>>;
	}>;
	const drain = () => new Promise(setImmediate);
	const request = (overrides: Partial<SshSpawnWrapConfig> = {}) =>
		desktop.wrapSpawnWithSsh({ ...config, ...overrides }, ssh, store);
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
		vi.mocked(buildExpandedEnv).mockReset().mockReturnValue({ PATH: '/custom/bin' });
		vi.mocked(libraryExec).mockReset().mockResolvedValue(found);
		releases = [];
		natives = [];
		store = { getSshRemotes: vi.fn(() => [remote]) };
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
		builders = await import('../../../main/utils/ssh-command-builder');
		desktop = await import('../../../main/utils/ssh-spawn-wrapper');
		core = await import('../../../shared/maestro-lib/launch/ssh-spawn-wrapper');
		host = await import('../../../shared/maestro-lib/host');
	});
	afterEach(async () => {
		for (const release of releases) release();
		for (const native of natives) {
			native.result.resolve(found);
			native.child.emit('close');
		}
		await drain();
		vi.restoreAllMocks();
	});

	it.each([target, path.join(target, 'descendant'), path.resolve('other-repository')])(
		'refuses before config, local fallback, store or diagnostics under %s',
		async (root) => {
			await reserve(root);
			const read = vi.fn(() => {
				throw new Error('Unexpected setup');
			});
			const input = new Proxy(config, { get: read });
			const diagnostic = vi.fn();
			host.setMaestroLibLogger({
				debug: diagnostic,
				info: diagnostic,
				warn: diagnostic,
				error: diagnostic,
			});
			for (const enabled of [true, false]) {
				await expect(desktop.wrapSpawnWithSsh(input, { ...ssh, enabled }, store)).rejects.toThrow(
					/reserved/
				);
			}
			for (const work of [
				read,
				store.getSshRemotes,
				diagnostic,
				buildExpandedEnv,
				execFileNoThrow,
				libraryExec,
			])
				expect(work).not.toHaveBeenCalled();
		}
	);
	it('admits while reservation canonicalization is pending', async () => {
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const reservation = gate.reserveWorktreeCleanup(target);
		const pending = request();
		canonical.resolve(target);
		await expect(reservation).resolves.toMatchObject({ status: 'blocked' });
		natives[0].result.resolve(found);
		await pending;
		await blocked();
		natives[0].child.emit('close');
		await reserve();
	});
	it.each([
		['inline', {}],
		['large prompt', { prompt: 'x'.repeat(4001) }],
		['forced stdin', { launchViaStdinScript: true }],
		['oversized inline', { args: ['x'.repeat(32000)], isWindowsHost: true }],
	] satisfies Array<[string, Partial<SshSpawnWrapConfig>]>)(
		'preserves %s routing and cache without releasing an older native child',
		async (_label, overrides) => {
			const pending = request(overrides);
			natives[0].result.resolve(found);
			const result = await pending;
			const resolvePath = async () => '/custom/ssh';
			const shared = await import('../../../shared/maestro-lib/launch/ssh-command-builder');
			await expect(
				core.wrapSpawnWithSsh({ ...config, ...overrides }, ssh, store, {
					buildSshCommand: (r, o) => shared.buildSshCommand(r, o, resolvePath),
					buildSshCommandWithStdin: (r, o) => shared.buildSshCommandWithStdin(r, o, resolvePath),
				})
			).resolves.toEqual(result);
			await expect(request(overrides)).resolves.toEqual(result);
			expect(execFileNoThrow).toHaveBeenCalledTimes(1);
			expect(execFileNoThrow).toHaveBeenCalledWith(
				expect.stringMatching(/^(which|where)$/),
				['ssh'],
				undefined,
				{ PATH: '/custom/bin' },
				expect.any(Function)
			);
			expect(libraryExec).not.toHaveBeenCalled();
			await blocked();
			natives[0].child.emit('close');
			const hold = await reserve();
			await expect(request(overrides)).rejects.toThrow(/reserved/);
			hold.release();
			await expect(request(overrides)).resolves.toEqual(result);
		}
	);
	it.each(['result', 'error', 'exit', 'timeout', 'rejection'])(
		'retains native ownership after %s settles the wrapper',
		async (event) => {
			const pending = request();
			if (event === 'error') natives[0].child.emit('error', new Error('native error'));
			if (event === 'exit') natives[0].child.emit('exit', 1);
			if (event === 'rejection') {
				natives[0].result.reject(new Error('executor rejected'));
				await expect(pending).rejects.toThrow('executor rejected');
			} else {
				natives[0].result.resolve(event === 'timeout' ? absent : found);
				await expect(pending).resolves.toMatchObject({ sshRemoteUsed: remote });
			}
			await blocked();
			natives[0].child.emit('close');
			await reserve();
		}
	);
	it('retains request work after native close until the result is assembled', async () => {
		const pending = request();
		natives[0].child.emit('close');
		await blocked();
		natives[0].result.resolve(found);
		await pending;
		await reserve();
	});
	it.each([false, true])(
		'holds across deferred inline-to-stdin fallback (reject: %s)',
		async (reject) => {
			vi.spyOn(builders, 'buildSshCommand').mockResolvedValue({
				command: 'ssh',
				args: ['x'.repeat(32000)],
				remoteCommandLine: 'claude',
			});
			const fallback =
				Promise.withResolvers<Awaited<ReturnType<typeof builders.buildSshCommandWithStdin>>>();
			vi.spyOn(builders, 'buildSshCommandWithStdin').mockReturnValueOnce(fallback.promise);
			const pending = request({ isWindowsHost: true });
			await drain();
			expect(builders.buildSshCommandWithStdin).toHaveBeenCalledTimes(1);
			expect(natives).toHaveLength(0);
			await blocked();
			if (reject) {
				fallback.reject(new Error('fallback failed'));
				await expect(pending).rejects.toThrow('fallback failed');
			} else {
				fallback.resolve({
					command: 'ssh',
					args: ['host'],
					stdinScript: 'script',
					remoteCommandLine: 'claude',
				});
				await expect(pending).resolves.toMatchObject({ sshStdinScript: 'script' });
			}
			await reserve();
		}
	);
	it('keeps concurrent generations independent of duplicate native close', async () => {
		const first = request();
		const second = request();
		natives[0].result.resolve(found);
		natives[1].result.resolve(found);
		await Promise.all([first, second]);
		natives[0].child.emit('close');
		natives[0].child.emit('close');
		await blocked();
		natives[1].child.emit('close');
		await reserve();
	});
	it('keeps concurrent wrapper requests independent after one finishes without a child', async () => {
		const first = Promise.withResolvers<Awaited<ReturnType<typeof builders.buildSshCommand>>>();
		const second = Promise.withResolvers<Awaited<ReturnType<typeof builders.buildSshCommand>>>();
		vi.spyOn(builders, 'buildSshCommand')
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const a = request();
		const b = request();
		const result = { command: 'ssh', args: ['host'], remoteCommandLine: 'claude' };
		first.resolve(result);
		await a;
		expect(natives).toHaveLength(0);
		await blocked();
		second.resolve(result);
		await b;
		await reserve();
	});
	it.each(['store', 'environment', 'prompt', 'report'])(
		'releases %s setup failure and permits retry',
		async (stage) => {
			const fail = () => {
				throw new Error('setup failed');
			};
			if (stage === 'store') store.getSshRemotes.mockImplementationOnce(fail);
			if (stage === 'environment') vi.mocked(buildExpandedEnv).mockImplementationOnce(fail);
			if (stage === 'report')
				host.setMaestroLibLogger({ debug: vi.fn(), info: fail, warn: vi.fn(), error: vi.fn() });
			await expect(request(stage === 'prompt' ? { promptArgs: fail } : {})).rejects.toThrow(
				'setup failed'
			);
			expect(execFileNoThrow).not.toHaveBeenCalled();
			(await reserve()).release();
			host.setMaestroLibLogger({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
			const retry = request();
			natives[0].result.resolve(found);
			natives[0].child.emit('close');
			await retry;
			await reserve();
		}
	);
	it('retains an early-result native child after completion diagnostics throw', async () => {
		host.setMaestroLibLogger({
			debug: () => {
				throw new Error('report failed');
			},
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		});
		const pending = request();
		natives[0].result.resolve(found);
		await expect(pending).rejects.toThrow('report failed');
		await blocked();
		natives[0].child.emit('close');
		await reserve();
	});
	it.each(['missing', 'failed', 'throw'])('blocks unknown native observation: %s', async (mode) => {
		vi.mocked(execFileNoThrow).mockImplementationOnce((_c, _a, _d, _o, observe) => {
			if (mode === 'throw') throw new Error('unknown launch');
			if (mode === 'failed')
				observe?.({
					once() {
						throw new Error('observer failed');
					},
				} as never);
			return Promise.resolve(found);
		});
		if (mode === 'missing') await request();
		else await expect(request()).rejects.toThrow(/unknown launch|observer failed/);
		await blocked();
	});
	it.each(['disabled', 'missing'])(
		'preserves %s remote results without native setup',
		async (kind) => {
			if (kind === 'missing') store.getSshRemotes.mockReturnValue([]);
			const sshConfig = kind === 'disabled' ? undefined : ssh;
			await expect(desktop.wrapSpawnWithSsh(config, sshConfig, store)).resolves.toEqual({
				command: config.command,
				args: config.args,
				cwd: config.cwd,
				customEnvVars: config.customEnvVars,
				prompt: config.prompt,
				sshRemoteUsed: null,
			});
			expect(execFileNoThrow).not.toHaveBeenCalled();
			await reserve();
		}
	);
	it('leaves default standalone library discovery independent of desktop reservations', async () => {
		await reserve();
		await expect(core.wrapSpawnWithSsh(config, ssh, store)).resolves.toMatchObject({
			command: '/custom/ssh',
		});
		expect(libraryExec).toHaveBeenCalledTimes(1);
		expect(execFileNoThrow).not.toHaveBeenCalled();
	});
});
