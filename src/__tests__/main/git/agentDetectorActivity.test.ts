import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import path from 'path';
import type { ExecResult } from '../../../main/utils/execFile';
import type { AgentConfig } from '../../../main/agents/definitions';

vi.mock('fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs/promises')>();
	return { ...actual, default: { ...actual, realpath: vi.fn() } };
});
vi.mock('fs', async (importOriginal) => ({
	...(await importOriginal<typeof import('fs')>()),
	readFileSync: vi.fn(() => {
		throw new Error('missing config');
	}),
}));
vi.mock('../../../main/utils/execFile', () => ({ execFileNoThrow: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../main/agents/path-prober', () => ({
	checkBinaryExists: vi.fn(),
	checkCustomPath: vi.fn(),
	findAllBinaryPaths: vi.fn(),
	getExpandedEnv: vi.fn(),
}));
vi.mock('../../../main/agents/opencode-config', () => ({
	discoverModelsFromLocalConfigs: vi.fn(),
}));
vi.mock('../../../main/agents/omp-model-catalog', () => ({
	primeOmpModelCatalog: vi.fn(),
	buildOmpPrimeEnv: vi.fn(() => ({ PATH: '/omp/bin' })),
	computeOmpCatalogKey: vi.fn(() => 'catalog'),
	setOmpModelCatalog: vi.fn(),
}));

import { execFileNoThrow } from '../../../main/utils/execFile';
import { logger } from '../../../main/utils/logger';
import { captureException } from '../../../main/utils/sentry';
import {
	checkBinaryExists,
	checkCustomPath,
	findAllBinaryPaths,
	getExpandedEnv,
} from '../../../main/agents/path-prober';
import { discoverModelsFromLocalConfigs } from '../../../main/agents/opencode-config';

describe('AgentDetector request and direct-probe activity', () => {
	const target = path.resolve('detector-target');
	const success = { stdout: 'test-model', stderr: '', exitCode: 0 };
	let gate: typeof import('../../../main/git/worktreeActivity');
	let detector: import('../../../main/agents/detector').AgentDetector;
	let natives: Array<{
		child: EventEmitter;
		result: ReturnType<typeof Promise.withResolvers<ExecResult>>;
	}>;
	let releases: Array<() => void>;

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
	function available() {
		vi.spyOn(detector, 'getAgent').mockImplementation(
			async (id) =>
				({
					id,
					available: true,
					path: `/bin/${id}`,
					capabilities: { supportsModelSelection: true },
				}) as AgentConfig
		);
	}
	beforeEach(async () => {
		vi.resetModules();
		vi.mocked(fs.realpath).mockImplementation(async (p) => String(p));
		for (const mock of [
			execFileNoThrow,
			logger.info,
			logger.debug,
			logger.warn,
			logger.error,
			captureException,
			checkBinaryExists,
			checkCustomPath,
			findAllBinaryPaths,
			getExpandedEnv,
			discoverModelsFromLocalConfigs,
		])
			vi.mocked(mock).mockReset();
		vi.mocked(checkBinaryExists).mockResolvedValue({ exists: false });
		vi.mocked(findAllBinaryPaths).mockResolvedValue([]);
		vi.mocked(getExpandedEnv).mockReturnValue({ PATH: '/test/bin' });
		vi.mocked(discoverModelsFromLocalConfigs).mockResolvedValue([]);
		natives = [];
		releases = [];
		vi.mocked(execFileNoThrow).mockImplementation((_command, _args, _cwd, _env, onSpawn) => {
			const child = new EventEmitter();
			child.on('error', () => {});
			const result = Promise.withResolvers<ExecResult>();
			natives.push({ child, result });
			onSpawn?.(child as Parameters<NonNullable<typeof onSpawn>>[0]);
			return result.promise;
		});
		gate = await import('../../../main/git/worktreeActivity');
		const { AgentDetector } = await import('../../../main/agents/detector');
		detector = new AgentDetector();
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

	it.each(['detect', 'lookup', 'models', 'options'])(
		'refuses %s before cached detection, PATH, lookup or recovery',
		async (kind) => {
			await detector.detectAgents();
			vi.clearAllMocks();
			await reserve(path.resolve('other-repo'));
			const request =
				kind === 'detect'
					? detector.detectAgents()
					: kind === 'lookup'
						? detector.getAgent('omp')
						: kind === 'models'
							? detector.discoverModels('omp')
							: detector.discoverConfigOptions('claude-code', 'effort');
			await expect(request).rejects.toThrow(/reserved/);
			expect(getExpandedEnv).not.toHaveBeenCalled();
			expect(execFileNoThrow).not.toHaveBeenCalled();
			expect(logger.warn).not.toHaveBeenCalled();
		}
	);

	it('retains pending deduplicated detection and custom-path fallback through reporting', async () => {
		const setup = Promise.withResolvers<{ exists: boolean }>();
		vi.mocked(checkCustomPath).mockReturnValueOnce(setup.promise);
		detector.setCustomPaths({ 'claude-code': '/custom/claude' });
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const reservation = gate.reserveWorktreeCleanup(target);
		const first = detector.detectAgents();
		const second = detector.getAgent('claude-code');
		canonical.resolve(target);
		const hold = await reservation;
		if (hold.status === 'reserved-partially') releases.push(hold.release);
		expect(hold.status).toBe('blocked');
		expect(checkCustomPath).toHaveBeenCalledOnce();
		setup.resolve({ exists: false });
		await Promise.all([first, second]);
		expect(checkBinaryExists).toHaveBeenCalledWith('claude');
		await reserve(path.join(target, 'descendant'));
	});

	it('holds model setup even when the agent lookup is asynchronous', async () => {
		const lookup = Promise.withResolvers<AgentConfig | null>();
		vi.spyOn(detector, 'getAgent').mockReturnValue(lookup.promise);
		const result = detector.discoverModels('opencode');
		await blocked();
		lookup.resolve(null);
		await expect(result).resolves.toEqual([]);
		await reserve();
	});

	it.each([
		['opencode', 'test-model', ['models'], ['test-model']],
		[
			'omp',
			'{"models":[{"selector":"provider/test-model"}]}',
			['models', '--json'],
			['provider/test-model'],
		],
		['grok', '* test-model (default)', ['models'], ['test-model']],
	] as const)(
		'owns the %s model child after result/exit/error until close',
		async (id, stdout, args, models) => {
			available();
			const result = detector.discoverModels(id);
			await vi.waitFor(() => expect(natives).toHaveLength(1));
			expect(execFileNoThrow).toHaveBeenCalledExactlyOnceWith(
				`/bin/${id}`,
				args,
				undefined,
				{ PATH: id === 'omp' ? '/omp/bin' : '/test/bin' },
				expect.any(Function)
			);
			natives[0].result.resolve({ ...success, stdout });
			await expect(result).resolves.toEqual(models);
			natives[0].child.emit('exit', 0);
			natives[0].child.emit('error', new Error('late error'));
			await blocked();
			natives[0].child.emit('close');
			await reserve();
		}
	);

	it('retains disk fallback after native close and owns concurrent requests independently', async () => {
		available();
		const disk = Promise.withResolvers<string[]>();
		vi.mocked(discoverModelsFromLocalConfigs).mockReturnValue(disk.promise);
		const first = detector.discoverModels('opencode');
		const second = detector.discoverModels('opencode');
		await vi.waitFor(() => expect(natives).toHaveLength(2));
		for (const native of natives) {
			native.child.emit('close');
			native.result.resolve(success);
		}
		await vi.waitFor(() => expect(discoverModelsFromLocalConfigs).toHaveBeenCalledTimes(2));
		await blocked();
		disk.resolve(['config-model']);
		await expect(Promise.all([first, second])).resolves.toEqual([
			['test-model', 'config-model'],
			['test-model', 'config-model'],
		]);
		await reserve();
	});

	it('owns overlapping native attempts after both requests settle', async () => {
		available();
		const first = detector.discoverModels('opencode');
		const second = detector.discoverModels('opencode');
		await vi.waitFor(() => expect(natives).toHaveLength(2));
		for (const native of natives) native.result.resolve(success);
		await Promise.all([first, second]);
		natives[1].child.emit('close');
		await blocked();
		natives[0].child.emit('close');
		await reserve();
	});

	it('retains config static fallback until both failed children close', async () => {
		available();
		const result = detector.discoverConfigOptions('claude-code', 'effort');
		await vi.waitFor(() => expect(natives).toHaveLength(1));
		natives[0].result.resolve({ stdout: '', stderr: 'failed', exitCode: 1 });
		await vi.waitFor(() => expect(natives).toHaveLength(2));
		natives[1].result.reject(new Error('failed probe'));
		await expect(result).resolves.toEqual(expect.arrayContaining(['low', 'high']));
		natives[0].child.emit('close');
		await blocked();
		natives[1].child.emit('close');
		await reserve();
	});

	it('retains help and validation fallback children independently through cache and force refresh', async () => {
		available();
		const first = detector.discoverConfigOptions('claude-code', 'effort');
		await vi.waitFor(() => expect(natives).toHaveLength(1));
		natives[0].result.resolve({ stdout: '--help', stderr: 'timeout', exitCode: 'ETIMEDOUT' });
		await vi.waitFor(() => expect(natives).toHaveLength(2));
		expect(execFileNoThrow).toHaveBeenNthCalledWith(
			1,
			'/bin/claude-code',
			['--help'],
			undefined,
			{ PATH: '/test/bin' },
			expect.any(Function)
		);
		expect(execFileNoThrow).toHaveBeenNthCalledWith(
			2,
			'/bin/claude-code',
			['--effort', '__maestro_probe__', '--version'],
			undefined,
			{ PATH: '/test/bin' },
			expect.any(Function)
		);
		natives[1].child.emit('close');
		natives[1].result.resolve({
			stdout: '',
			stderr: '--effort valid values: low, high.',
			exitCode: 1,
		});
		await expect(first).resolves.toEqual(['', 'low', 'high']);
		await expect(detector.discoverConfigOptions('claude-code', 'effort')).resolves.toEqual([
			'',
			'low',
			'high',
		]);
		expect(natives).toHaveLength(2);
		await blocked();
		natives[0].child.emit('close');
		const hold = await reserve();
		await expect(detector.discoverConfigOptions('claude-code', 'effort')).rejects.toThrow(
			/reserved/
		);
		hold.release();
		const forced = detector.discoverConfigOptions('claude-code', 'effort', true);
		await vi.waitFor(() => expect(natives).toHaveLength(3));
		natives[2].result.resolve({ ...success, stdout: '--effort <level> Effort (low, medium)' });
		natives[2].child.emit('close');
		await expect(forced).resolves.toEqual(['', 'low', 'medium']);
		await reserve();
	});

	it('refuses a model cache hit before overridden lookup and preserves forced retry', async () => {
		available();
		const first = detector.discoverModels('opencode');
		await vi.waitFor(() => expect(natives).toHaveLength(1));
		natives[0].result.resolve(success);
		natives[0].child.emit('close');
		await first;
		await expect(detector.discoverModels('opencode')).resolves.toEqual(['test-model']);
		const hold = await reserve();
		vi.mocked(detector.getAgent).mockClear();
		await expect(detector.discoverModels('opencode')).rejects.toThrow(/reserved/);
		expect(detector.getAgent).not.toHaveBeenCalled();
		hold.release();
		const forced = detector.discoverModels('opencode', true);
		await vi.waitFor(() => expect(natives).toHaveLength(2));
		natives[1].result.resolve(success);
		natives[1].child.emit('close');
		await forced;
		await reserve();
	});

	it('releases pre-launch setup failure without recovery and permits retry', async () => {
		vi.mocked(getExpandedEnv).mockImplementationOnce(() => {
			throw new Error('bad env');
		});
		await expect(detector.detectAgents()).rejects.toThrow('bad env');
		expect(execFileNoThrow).not.toHaveBeenCalled();
		(await reserve()).release();
		await detector.detectAgents();
		await reserve();
	});

	it('retains asynchronous exception reporting after native close', async () => {
		available();
		const reporting = Promise.withResolvers<void>();
		vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
		const result = detector.discoverModels('opencode');
		await vi.waitFor(() => expect(natives).toHaveLength(1));
		natives[0].child.emit('close');
		natives[0].result.reject(new Error('failed probe'));
		await vi.waitFor(() => expect(captureException).toHaveBeenCalledOnce());
		try {
			await blocked();
		} finally {
			reporting.resolve();
		}
		await expect(result).resolves.toEqual([]);
		await reserve();
	});

	it('keeps native ownership after command and diagnostic failures', async () => {
		available();
		vi.mocked(logger.error).mockImplementation(() => {
			throw new Error('reporting failed');
		});
		const result = detector.discoverModels('opencode');
		await vi.waitFor(() => expect(natives).toHaveLength(1));
		natives[0].result.reject(new Error('native failed'));
		await expect(result).rejects.toThrow('reporting failed');
		await blocked();
		natives[0].child.emit('close');
		await reserve();
	});

	it.each(['missing child', 'observer failure', 'unknown launch'])(
		'keeps %s blocked after request recovery',
		async (kind) => {
			available();
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
			await detector.discoverModels('opencode');
			await blocked();
		}
	);
});
