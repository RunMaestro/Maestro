import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import path from 'path';

const nativeExec = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ execFile: nativeExec }));
vi.mock('fs/promises', async (original) => {
	const actual = await original<typeof import('fs/promises')>();
	return { ...actual, default: { ...actual, realpath: vi.fn() } };
});
vi.mock('../../../shared/platformDetection', () => ({ isWindows: vi.fn(() => false) }));
import { isWindows } from '../../../shared/platformDetection';

type Completion = (error: Error | null, stdout: string, stderr: string) => void;
describe('terminal child-process inspection activity', () => {
	const target = path.resolve('child-inspection-target');
	let gate: typeof import('../../../main/git/worktreeActivity');
	let service: typeof import('../../../main/process-manager/utils/childProcessInfo');
	let natives: Array<{ child: EventEmitter; complete: Completion }>;
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
		vi.mocked(fs.realpath)
			.mockReset()
			.mockImplementation(async (p) => String(p));
		vi.mocked(isWindows).mockReset().mockReturnValue(false);
		natives = [];
		releases = [];
		nativeExec.mockReset().mockImplementation((_cmd, _args, _options, complete: Completion) => {
			const child = new EventEmitter();
			child.on('error', () => {});
			natives.push({ child, complete });
			return child;
		});
		gate = await import('../../../main/git/worktreeActivity');
		service = await import('../../../main/process-manager/utils/childProcessInfo');
	});
	afterEach(async () => {
		for (const release of releases) release();
		for (let i = 0; i < natives.length; i++) {
			natives[i].complete(null, '42 node\n', '');
			natives[i].child.emit('close');
			await drain();
		}
		vi.restoreAllMocks();
	});

	it.each([target, path.join(target, 'descendant'), path.resolve('other-repository')])(
		'refuses before platform/native setup and fallback under %s',
		async (root) => {
			await reserve(root);
			await expect(service.getChildProcesses(10)).rejects.toThrow(/reserved/);
			expect(isWindows).not.toHaveBeenCalled();
			expect(nativeExec).not.toHaveBeenCalled();
		}
	);
	it('admits before pending reservation canonicalization', async () => {
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const reservation = gate.reserveWorktreeCleanup(target);
		const request = service.getChildProcesses(10);
		canonical.resolve(target);
		await expect(reservation).resolves.toMatchObject({ status: 'blocked' });
		natives[0].complete(null, '42 node', '');
		await expect(request).resolves.toEqual([{ pid: 42, command: 'node' }]);
		await blocked();
		natives[0].child.emit('close');
		await reserve();
	});
	it.each([false, true])('preserves platform %s argv, options and parsing', async (windows) => {
		vi.mocked(isWindows).mockReturnValue(windows);
		const request = service.getChildProcesses(123);
		expect(nativeExec).toHaveBeenCalledWith(
			windows ? 'wmic' : 'ps',
			windows
				? ['process', 'where', 'ParentProcessId=123', 'get', 'ProcessId,CommandLine', '/format:csv']
				: ['--ppid', '123', '-o', 'pid=,comm='],
			{ timeout: 3000 },
			expect.any(Function)
		);
		natives[0].complete(
			null,
			windows
				? 'Node,CommandLine,ProcessId\nHOST,node a,b.js,42\nHOST,,9\n'
				: '42 node\n7 /bin/bash\n8 zsh\ninvalid\n',
			''
		);
		await expect(request).resolves.toEqual([
			{ pid: 42, command: windows ? 'node a,b.js' : 'node' },
		]);
		await blocked();
		natives[0].child.emit('close');
		await reserve();
	});
	it.each(['error', 'exit', 'result'])('does not treat %s as native close', async (event) => {
		vi.mocked(isWindows).mockReturnValue(true);
		const request = service.getChildProcesses(10);
		if (event === 'error') natives[0].child.emit('error', new Error('timeout'));
		if (event === 'exit') natives[0].child.emit('exit', 0);
		natives[0].complete(event === 'result' ? null : new Error(event), '', '');
		await expect(request).resolves.toEqual([]);
		await blocked();
		natives[0].child.emit('close');
		await reserve();
	});
	it('retains request settlement after native close and all concurrent generations', async () => {
		vi.mocked(isWindows).mockReturnValue(true);
		const first = service.getChildProcesses(1);
		const second = service.getChildProcesses(2);
		natives[0].child.emit('close');
		natives[1].child.emit('close');
		await blocked();
		natives[0].complete(null, '', '');
		await first;
		natives[0].child.emit('close');
		await blocked();
		natives[1].complete(null, '', '');
		await second;
		await reserve();
	});
	it.each([false, true])(
		'retains every macOS fallback child; final command fails=%s',
		async (fail) => {
			const request = service.getChildProcesses(10);
			natives[0].complete(new Error('unsupported'), '', '');
			await drain();
			natives[1].complete(null, '', '');
			await drain();
			natives[2].complete(null, '100\n200\n', '');
			await drain();
			expect(nativeExec.mock.calls.map((c) => [c[0], c[1]])).toEqual([
				['ps', ['--ppid', '10', '-o', 'pid=,comm=']],
				['ps', ['-o', 'pid=,comm=', '-p', '10']],
				['pgrep', ['-P', '10']],
				['ps', ['-o', 'pid=,comm=', '-p', '100,200']],
			]);
			natives[3].complete(fail ? new Error('gone') : null, fail ? '' : '100 node\n200 bash', '');
			await expect(request).resolves.toEqual(
				fail
					? [
							{ pid: 100, command: '' },
							{ pid: 200, command: '' },
						]
					: [{ pid: 100, command: 'node' }]
			);
			for (const index of [3, 1, 0]) {
				natives[index].child.emit('close');
				await blocked();
			}
			natives[2].child.emit('close');
			await reserve();
		}
	);
	it('keeps fallback setup covered even when earlier children closed first', async () => {
		const request = service.getChildProcesses(10);
		natives[0].child.emit('close');
		natives[0].complete(new Error('unsupported'), '', '');
		await blocked();
		await drain();
		natives[1].child.emit('close');
		natives[1].complete(null, '', '');
		await blocked();
		await drain();
		natives[2].child.emit('close');
		natives[2].complete(null, ' \n', '');
		await expect(request).resolves.toEqual([]);
		await reserve();
	});
	it('refuses retained callbacks after settlement/close before late fallback effects', async () => {
		const request = service.getChildProcesses(10);
		natives[0].complete(null, '42 node', '');
		await request;
		natives[0].child.emit('close');
		await reserve();
		expect(() => natives[0].complete(new Error('late'), '', '')).toThrow(/reserved/);
		expect(nativeExec).toHaveBeenCalledTimes(1);
	});
	it('releases setup failures before a native attempt', async () => {
		vi.mocked(isWindows).mockImplementationOnce(() => {
			throw new Error('platform');
		});
		await expect(service.getChildProcesses(10)).rejects.toThrow('platform');
		expect(nativeExec).not.toHaveBeenCalled();
		await reserve();
	});
	it.each(['throw', 'missing', 'observer'])(
		'keeps unknown native %s state busy',
		async (failure) => {
			nativeExec.mockImplementationOnce(() => {
				if (failure === 'throw') throw new Error('unknown launch');
				return failure === 'missing'
					? undefined
					: {
							once() {
								throw new Error('observer');
							},
						};
			});
			await expect(service.getChildProcesses(10)).rejects.toThrow();
			await blocked();
		}
	);
	it('retains failed observation after a synchronous result already settled', async () => {
		vi.mocked(isWindows).mockReturnValue(true);
		nativeExec.mockImplementationOnce((_cmd, _args, _options, complete: Completion) => {
			complete(null, '', '');
			return {
				once() {
					throw new Error('unknown observer');
				},
			};
		});
		await expect(service.getChildProcesses(10)).resolves.toEqual([]);
		await blocked();
	});
	it('propagates fallback launch failure while retaining the unknown child', async () => {
		const request = service.getChildProcesses(10);
		const failure = expect(request).rejects.toThrow('fallback setup');
		nativeExec.mockImplementationOnce(() => {
			throw new Error('fallback setup');
		});
		natives[0].child.emit('close');
		natives[0].complete(new Error('unsupported'), '', '');
		await failure;
		await blocked();
	});
});
