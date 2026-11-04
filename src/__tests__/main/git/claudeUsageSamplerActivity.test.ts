import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import path from 'path';

const mocks = vi.hoisted(() => ({
	exec: vi.fn(),
	mkdir: vi.fn(),
	lstat: vi.fn(),
	report: vi.fn(),
	identity: vi.fn(),
	key: vi.fn(),
}));
vi.mock('child_process', async (original) => {
	const actual = await original<typeof import('child_process')>();
	const { promisify } = await import('util');
	return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: mocks.exec }) };
});
vi.mock('fs', async (original) => {
	const actual = await original<typeof import('fs')>();
	return { ...actual, promises: { ...actual.promises, mkdir: mocks.mkdir, lstat: mocks.lstat } };
});
vi.mock('fs/promises', async (original) => {
	const actual = await original<typeof import('fs/promises')>();
	return { ...actual, default: { ...actual, realpath: vi.fn() } };
});
vi.mock('../../../main/utils/sentry', () => ({ captureMessage: mocks.report }));
vi.mock('../../../main/agents/claude-account-identity', () => ({
	readClaudeAccountIdentity: mocks.identity,
}));
vi.mock('../../../main/stores/claudeUsageStore', () => ({
	resolveConfigDirKey: mocks.key,
	getSnapshot: vi.fn(),
}));

describe('standalone Claude usage sampler activity', () => {
	const target = path.resolve('usage-sampler-target');
	const opts = { binPath: '/test/maestro-p.js' };
	const success = {
		stdout: JSON.stringify({
			type: 'status',
			config_dir: '/wire-account',
			session: { percent: 42 },
			week_all_models: { percent: 73 },
			week_sonnet_only: { percent: 19 },
		}),
		stderr: '',
	};
	let gate: typeof import('../../../main/git/worktreeActivity');
	let sampler: typeof import('../../../main/agents/claude-usage-sampler');
	let natives: Array<{
		child: EventEmitter;
		result: ReturnType<typeof Promise.withResolvers<typeof success>>;
	}>;
	let releases: Array<() => void>;
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
		for (const mock of Object.values(mocks)) mock.mockReset();
		vi.mocked(fs.realpath)
			.mockReset()
			.mockImplementation(async (p) => String(p));
		mocks.mkdir.mockResolvedValue(undefined);
		mocks.lstat.mockResolvedValue({
			isSymbolicLink: () => false,
			isDirectory: () => true,
			uid: process.getuid?.(),
			mode: 0o700,
		});
		mocks.report.mockResolvedValue(undefined);
		mocks.identity.mockResolvedValue(null);
		mocks.key.mockReturnValue('/test/account');
		natives = [];
		releases = [];
		mocks.exec.mockImplementation(() => {
			const child = new EventEmitter();
			child.on('error', () => {});
			const result = Promise.withResolvers<typeof success>();
			natives.push({ child, result });
			return Object.assign(result.promise, { child });
		});
		gate = await import('../../../main/git/worktreeActivity');
		sampler = await import('../../../main/agents/claude-usage-sampler');
	});
	afterEach(async () => {
		for (const native of natives) {
			native.result.resolve(success);
			native.child.emit('close');
		}
		await drain();
		for (const release of releases) release();
		vi.restoreAllMocks();
	});

	it.each([target, path.join(target, 'descendant'), path.resolve('unrelated-repository')])(
		'refuses before options, environment, folder or recovery under %s',
		async (root) => {
			await reserve(root);
			const access = vi.fn(() => 1);
			await expect(
				sampler.sampleUsage({
					...opts,
					get timeoutMs() {
						return access();
					},
				})
			).rejects.toThrow(/reserved/);
			expect(access).not.toHaveBeenCalled();
			for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
		}
	);

	it('admits synchronously during pending reservation and retains asynchronous folder setup', async () => {
		const canonical = Promise.withResolvers<string>();
		const folder = Promise.withResolvers<void>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		mocks.mkdir.mockReturnValueOnce(folder.promise);
		const reservation = gate.reserveWorktreeCleanup(target);
		const request = sampler.sampleUsage(opts);
		canonical.resolve(target);
		await expect(reservation).resolves.toMatchObject({ status: 'blocked' });
		await blocked();
		expect(mocks.exec).not.toHaveBeenCalled();
		folder.resolve();
		await drain();
		natives[0].child.emit('close');
		await blocked();
		natives[0].result.resolve(success);
		await expect(request).resolves.toMatchObject({ session: { percent: 42 } });
		await reserve();
	});

	it('preserves native arguments, environment, buffer, timeout and canonical snapshots', async () => {
		const request = sampler.sampleUsage({
			...opts,
			configDir: '/chosen',
			timeoutMs: 123,
			customEnvVars: { CLAUDE_CONFIG_DIR: '/ignored', TASK_USAGE: 'yes', BROWSER: 'ignored' },
		});
		await drain();
		expect(mocks.exec).toHaveBeenCalledWith(process.execPath, [opts.binPath, '--status'], {
			cwd: expect.stringContaining(sampler.USAGE_PROBE_DIR_NAME),
			encoding: 'utf8',
			maxBuffer: 1048576,
			timeout: 123,
			env: expect.objectContaining({
				CLAUDE_CONFIG_DIR: '/chosen',
				TASK_USAGE: 'yes',
				BROWSER: '/usr/bin/true',
				ELECTRON_RUN_AS_NODE: '1',
				MAESTRO_P_ACCEPT_WORKSPACE_TRUST: '1',
			}),
		});
		natives[0].result.resolve(success);
		await expect(request).resolves.toMatchObject({
			configDirKey: '/test/account',
			session: { percent: 42 },
			weekAllModels: { percent: 73 },
			weekSonnetOnly: { percent: 19 },
		});
		await blocked();
		natives[0].child.emit('close');
		await reserve();
	});

	it.each(['result', 'error', 'exit'] as const)(
		'retains child after %s until observed close',
		async (event) => {
			const request = sampler.sampleUsage(opts);
			await drain();
			if (event === 'error') natives[0].child.emit('error', new Error('native error'));
			if (event === 'exit') natives[0].child.emit('exit', 0);
			natives[0].result.resolve(success);
			await expect(request).resolves.not.toBeNull();
			await blocked();
			natives[0].child.emit('close');
			await reserve();
		}
	);

	it('retains identity lookup after native close and result', async () => {
		const identity = Promise.withResolvers<{ email: string }>();
		mocks.identity.mockReturnValueOnce(identity.promise);
		const request = sampler.sampleUsage(opts);
		await drain();
		natives[0].result.resolve(success);
		natives[0].child.emit('close');
		await drain();
		await blocked();
		identity.resolve({ email: 'usage@example.test' });
		await expect(request).resolves.toMatchObject({ accountEmail: 'usage@example.test' });
		await reserve();
	});

	it('retains concurrent generations despite duplicate close or earlier completion', async () => {
		const first = sampler.sampleUsage(opts);
		const second = sampler.sampleUsage(opts);
		await drain();
		expect(natives).toHaveLength(2);
		natives[0].result.resolve(success);
		natives[0].child.emit('close');
		await first;
		await blocked();
		natives[1].child.emit('close');
		natives[0].child.emit('close');
		await blocked();
		natives[1].result.resolve(success);
		await second;
		await reserve();
	});

	it.each([{ code: 'ENOENT' }, { killed: true }, { code: 2 }])(
		'retains rejected native result %j until close',
		async (details) => {
			const request = sampler.sampleUsage(opts);
			await drain();
			natives[0].result.reject(Object.assign(new Error('failure'), details));
			await expect(request).resolves.toBeNull();
			expect(mocks.report).toHaveBeenCalledTimes(1);
			await blocked();
			natives[0].child.emit('close');
			await reserve();
		}
	);

	it.each(['resolve', 'reject'] as const)(
		'retains asynchronous failure reporting through %s after result and close',
		async (outcome) => {
			const report = Promise.withResolvers<void>();
			mocks.report.mockReturnValueOnce(report.promise);
			const request = sampler.sampleUsage(opts);
			await drain();
			natives[0].result.resolve({ stdout: '', stderr: '' });
			natives[0].child.emit('close');
			await expect(request).resolves.toBeNull();
			await blocked();
			if (outcome === 'reject') report.reject(new Error('report failure'));
			else report.resolve();
			await drain();
			await reserve();
		}
	);

	it('preserves failure deduplication while independently retaining reports and retry children', async () => {
		const report = Promise.withResolvers<void>();
		mocks.report.mockReturnValueOnce(report.promise);
		const first = sampler.sampleUsage(opts);
		await drain();
		natives[0].result.resolve({ stdout: '', stderr: '' });
		natives[0].child.emit('close');
		await first;
		const retry = sampler.sampleUsage(opts);
		await drain();
		natives[1].result.resolve({ stdout: '', stderr: '' });
		await retry;
		expect(mocks.report).toHaveBeenCalledTimes(1);
		natives[1].child.emit('close');
		await blocked();
		report.resolve();
		await drain();
		await reserve();
	});

	it('observes synchronous diagnostic failure without losing native ownership', async () => {
		mocks.report.mockImplementationOnce(() => {
			throw new Error('diagnostic');
		});
		const request = sampler.sampleUsage(opts);
		await drain();
		natives[0].result.resolve({ stdout: '', stderr: '' });
		await expect(request).resolves.toBeNull();
		await blocked();
		natives[0].child.emit('close');
		await reserve();
	});

	it('retains failed private-folder reporting without attempting a native launch', async () => {
		const report = Promise.withResolvers<void>();
		mocks.mkdir.mockRejectedValueOnce(new Error('not private'));
		mocks.report.mockReturnValueOnce(report.promise);
		await expect(sampler.sampleUsage(opts)).resolves.toBeNull();
		expect(mocks.exec).not.toHaveBeenCalled();
		await blocked();
		report.resolve();
		await drain();
		await reserve();
	});

	it.each(['options', 'key', 'identity'] as const)(
		'releases request on %s setup/recovery failure',
		async (failure) => {
			let request: ReturnType<typeof sampler.sampleUsage>;
			if (failure === 'options') {
				request = sampler.sampleUsage({
					...opts,
					get timeoutMs(): number {
						throw new Error('options');
					},
				});
			} else if (failure === 'key') {
				mocks.key.mockImplementationOnce(() => {
					throw new Error('key');
				});
				request = sampler.sampleUsage(opts);
			} else {
				mocks.identity.mockRejectedValueOnce(new Error('identity'));
				request = sampler.sampleUsage(opts);
			}
			const assertion = expect(request).rejects.toThrow(failure);
			await drain();
			for (const native of natives) {
				native.result.resolve(success);
				native.child.emit('close');
			}
			await assertion;
			await reserve();
		}
	);

	it.each(['missing', 'observer', 'launch'] as const)(
		'keeps unknown %s native observation busy',
		async (failure) => {
			mocks.exec.mockImplementationOnce(() => {
				if (failure === 'launch') throw new Error('unknown launch');
				const child =
					failure === 'missing'
						? undefined
						: {
								once: () => {
									throw new Error('observer');
								},
							};
				return Object.assign(Promise.resolve(success), { child });
			});
			await expect(sampler.sampleUsage(opts)).resolves.toBeNull();
			await drain();
			await blocked();
		}
	);
});
