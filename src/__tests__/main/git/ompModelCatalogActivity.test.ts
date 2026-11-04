import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import path from 'path';
import type { ExecResult } from '../../../main/utils/execFile';

vi.mock('fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs/promises')>();
	return { ...actual, default: { ...actual, realpath: vi.fn() } };
});
vi.mock('../../../main/utils/execFile', () => ({ execFileNoThrow: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({ logger: { warn: vi.fn() } }));

import { execFileNoThrow } from '../../../main/utils/execFile';
import { logger } from '../../../main/utils/logger';

describe('standalone Oh My Pi catalog prime activity', () => {
	const target = path.resolve('omp-prime-target');
	const env = { PATH: '/test/bin' };
	const success = {
		stdout: JSON.stringify({ models: [{ id: 'test-model', contextWindow: 123_456 }] }),
		stderr: '',
		exitCode: 0,
	};
	let gate: typeof import('../../../main/git/worktreeActivity');
	let catalog: typeof import('../../../main/agents/omp-model-catalog');
	let natives: Array<{
		child: EventEmitter;
		result: ReturnType<typeof Promise.withResolvers<ExecResult>>;
	}>;
	let releases: Array<() => void>;

	function prime(
		key = 'test',
		primeEnv: NodeJS.ProcessEnv | undefined = env,
		options?: { retryFailedPrime?: boolean }
	) {
		const result = catalog.primeOmpModelCatalog('omp', primeEnv, key, options);
		void result.catch(() => {});
		return result;
	}
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
		expect(hold).toMatchObject({
			status: 'blocked',
			blockers: [{ code: 'mutation-busy' }],
		});
	}
	beforeEach(async () => {
		vi.resetModules();
		vi.mocked(fs.realpath).mockImplementation(async (p) => String(p));
		vi.mocked(execFileNoThrow).mockReset();
		vi.mocked(logger.warn).mockReset();
		natives = [];
		releases = [];
		vi.mocked(execFileNoThrow).mockImplementation((_command, _args, _cwd, _opts, onSpawn) => {
			const child = new EventEmitter();
			child.on('error', () => {});
			const result = Promise.withResolvers<ExecResult>();
			natives.push({ child, result });
			onSpawn?.(child as Parameters<NonNullable<typeof onSpawn>>[0]);
			return result.promise;
		});
		gate = await import('../../../main/git/worktreeActivity');
		catalog = await import('../../../main/agents/omp-model-catalog');
	});
	afterEach(async () => {
		for (const native of natives) {
			native.result.resolve(success);
			native.child.emit('close');
		}
		for (const release of releases) release();
		await new Promise(setImmediate);
		vi.restoreAllMocks();
	});

	it.each([target, path.join(target, 'descendant'), path.resolve('other-repo')])(
		'refuses before configuration and recovery under %s',
		async (root) => {
			await reserve(root);
			const getter = vi.fn(() => {
				throw new Error('configuration must not be read');
			});
			const options = Object.defineProperty({}, 'retryFailedPrime', { get: getter });
			const primeEnv = Object.defineProperty({}, 'PATH', { get: getter });
			expect(() => prime('test', primeEnv, options)).toThrow(/reserved/);
			expect(getter).not.toHaveBeenCalled();
			expect(execFileNoThrow).not.toHaveBeenCalled();
			expect(logger.warn).not.toHaveBeenCalled();
		}
	);

	it('blocks pending canonicalization and retains timeout/exit/error until close', async () => {
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const reservation = gate.reserveWorktreeCleanup(target);
		const result = prime();
		canonical.resolve(target);
		const hold = await reservation;
		if (hold.status === 'reserved-partially') releases.push(hold.release);
		expect(hold.status).toBe('blocked');
		natives[0].result.resolve({ stdout: '', stderr: 'timeout', exitCode: 'ETIMEDOUT' });
		await result;
		natives[0].child.emit('exit', 1);
		natives[0].child.emit('error', new Error('failed'));
		await blocked();
		natives[0].child.emit('close');
		await reserve();
	});

	it('retains pending parsing and reporting after native close', async () => {
		const result = prime();
		natives[0].child.emit('close');
		await blocked();
		const inspected = vi.fn(() => success.stdout);
		natives[0].result.resolve({
			...success,
			get stdout() {
				return inspected();
			},
		});
		await result;
		expect(inspected).toHaveBeenCalledOnce();
		expect(catalog.getOmpModelContextWindow('test-model', 'test')).toBe(123_456);
		await reserve();
	});

	it('preserves shared promise identity and invocation without releasing native ownership', async () => {
		const first = prime();
		const second = prime('test', env, { retryFailedPrime: true });
		expect(second).toBe(first);
		expect(execFileNoThrow).toHaveBeenCalledExactlyOnceWith(
			'omp',
			['models', '--json'],
			undefined,
			env,
			expect.any(Function)
		);
		natives[0].result.resolve(success);
		await Promise.all([first, second]);
		await blocked();
		natives[0].child.emit('close');
		await reserve();
	});

	it('owns concurrent identities independently', async () => {
		const first = prime('first');
		const second = prime('second');
		for (const native of natives) native.result.resolve(success);
		await Promise.all([first, second]);
		natives[0].child.emit('close');
		await blocked();
		natives[1].child.emit('close');
		await reserve();
	});

	it.each([true, false])('refuses cached success=%s before setup or spawning', async (ok) => {
		const first = prime();
		natives[0].result.resolve(ok ? success : { stdout: '', stderr: 'failed', exitCode: 1 });
		natives[0].child.emit('close');
		await first;
		await prime();
		expect(natives).toHaveLength(1);
		const hold = await reserve();
		expect(() => prime()).toThrow(/reserved/);
		hold.release();
		await prime();
		expect(natives).toHaveLength(1);
	});

	it('retains an older child when explicit retry bypasses the negative cache', async () => {
		const first = prime();
		natives[0].result.resolve({ stdout: '', stderr: 'failed', exitCode: 1 });
		await first;
		await prime();
		expect(natives).toHaveLength(1);
		const second = prime('test', env, { retryFailedPrime: true });
		expect(prime()).toBe(second);
		expect(natives).toHaveLength(2);
		natives[1].result.resolve(success);
		natives[1].child.emit('close');
		await second;
		await blocked();
		natives[0].child.emit('close');
		await reserve();
	});

	it('releases configuration failure before any native launch', async () => {
		const failure = new Error('bad environment');
		const primeEnv = Object.defineProperty({}, 'PATH', {
			get() {
				throw failure;
			},
		});
		expect(() => prime('test', primeEnv)).toThrow(failure);
		expect(execFileNoThrow).not.toHaveBeenCalled();
		expect(logger.warn).not.toHaveBeenCalled();
		(await reserve()).release();
		const result = prime();
		natives[0].result.resolve(success);
		natives[0].child.emit('close');
		await result;
		await reserve();
	});

	it('keeps rejected command work best-effort but busy until native close', async () => {
		const result = prime();
		natives[0].result.reject(new Error('native failed'));
		await expect(result).resolves.toBeUndefined();
		expect(logger.warn).toHaveBeenCalledOnce();
		await blocked();
		natives[0].child.emit('close');
		await reserve();
	});

	it('retains native ownership when diagnostics throw and clears in-flight state', async () => {
		const failure = new Error('diagnostics failed');
		vi.mocked(logger.warn).mockImplementation(() => {
			throw failure;
		});
		const result = prime();
		natives[0].result.resolve({ stdout: '', stderr: 'failed', exitCode: 1 });
		await expect(result).rejects.toBe(failure);
		await blocked();
		natives[0].child.emit('close');
		(await reserve()).release();
		const retried = prime('test', env, { retryFailedPrime: true });
		expect(natives).toHaveLength(2);
		natives[1].result.resolve(success);
		natives[1].child.emit('close');
		await retried;
		await reserve();
	});

	it.each(['missing child', 'observer failure', 'unknown launch'])(
		'fails closed for %s even after best-effort result settlement',
		async (kind) => {
			vi.mocked(execFileNoThrow).mockImplementationOnce((_c, _a, _d, _e, onSpawn) => {
				if (kind === 'missing child') return Promise.resolve(success);
				if (kind === 'observer failure')
					onSpawn?.({
						once() {
							throw new Error(kind);
						},
					} as never);
				throw new Error(kind);
			});
			await expect(prime()).resolves.toBeUndefined();
			await blocked();
		}
	);
});
