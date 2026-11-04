import fs from 'fs/promises';
import path from 'path';
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnExit, TurnHandlers } from '../../../shared/maestro-lib/run/start-turn';

const mocks = vi.hoisted(() => ({ start: vi.fn(), plan: vi.fn(), report: vi.fn() }));
vi.mock('fs/promises', () => ({ default: { realpath: vi.fn() } }));
vi.mock('../../../shared/maestro-lib/run/start-turn', async (original) => ({
	...(await original<typeof import('../../../shared/maestro-lib/run/start-turn')>()),
	startTurn: mocks.start,
}));
vi.mock('../../../main/process-manager/utils/windowsSpawnShell', () => ({
	planSpawnShell: mocks.plan,
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: mocks.report }));

const target = path.resolve('skill-discovery-target');
let gate: typeof import('../../../main/git/worktreeActivity');
let discover: typeof import('../../../main/agents/codex-skills').discoverCodexSkills;
let native: ReturnType<typeof makeNative>;
let reply: boolean;
let releases: Array<() => void>;

function makeNative() {
	const done = Promise.withResolvers<TurnExit>();
	const child = Object.assign(new EventEmitter(), {
		stdin: { writable: true, write: vi.fn() },
	});
	child.on('error', () => {});
	const result = {
		child,
		done,
		handlers: {} as TurnHandlers,
		terminate: vi.fn(() => done.resolve({} as TurnExit)),
	};
	child.stdin.write.mockImplementation((line: string) => {
		const message = JSON.parse(line);
		if (reply && message.id)
			queueMicrotask(() =>
				result.handlers.onLine?.(
					JSON.stringify({
						id: message.id,
						result: message.method === 'initialize' ? {} : { data: [] },
					})
				)
			);
	});
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
	expect(await gate.reserveWorktreeCleanup(target)).toMatchObject({
		status: 'blocked',
		blockers: [{ code: 'mutation-busy' }],
	});
}

beforeEach(async () => {
	vi.resetModules();
	vi.resetAllMocks();
	vi.mocked(fs.realpath).mockImplementation(async (p) => String(p));
	releases = [];
	reply = true;
	native = makeNative();
	mocks.plan.mockImplementation((command, args) => ({ command, args }));
	mocks.start.mockImplementation((_spec, handlers) => {
		native.handlers = handlers;
		return { child: native.child, done: native.done.promise, terminate: native.terminate };
	});
	gate = await import('../../../main/git/worktreeActivity');
	discover = (await import('../../../main/agents/codex-skills')).discoverCodexSkills;
});

afterEach(() => {
	for (const release of releases) release();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('standalone Codex skill discovery activity', () => {
	it.each([target, path.join(target, 'descendant'), path.resolve('other-repository')])(
		'refuses before shell/native setup or recovery under %s',
		async (root) => {
			const hold = await reserve(root);
			await expect(discover('codex', target, {})).rejects.toThrow(/reserved/);
			for (const probe of [mocks.plan, mocks.start, mocks.report, native.terminate])
				expect(probe).not.toHaveBeenCalled();
			hold.release();
			await expect(discover('codex', target, {})).resolves.toEqual([]);
			native.child.emit('close');
		}
	);

	it('retains native ownership after successful discovery, termination and done', async () => {
		await expect(discover('codex', target, {})).resolves.toEqual([]);
		expect(native.terminate).toHaveBeenCalledOnce();
		native.child.emit('exit', 0);
		native.child.emit('error', new Error('late native error'));
		await blocked();
		native.child.emit('close');
		(await reserve()).release();
	});

	it('retains discovery and reporting when close arrives before the request settles', async () => {
		reply = false;
		const result = discover('codex', target, {});
		const rejected = expect(result).rejects.toThrow('Codex skill discovery exited');
		native.child.emit('close');
		await blocked();
		native.done.resolve({} as TurnExit);
		await rejected;
		(await reserve()).release();
	});

	it('counts a new start while cleanup canonicalization is pending', async () => {
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const reservation = gate.reserveWorktreeCleanup(target);
		const result = discover('codex', target, {});
		canonical.resolve(target);
		expect(await reservation).toMatchObject({
			status: 'blocked',
			blockers: [{ code: 'mutation-busy' }],
		});
		await result;
		native.child.emit('close');
		(await reserve()).release();
	});

	it('owns concurrent children independently and admits new discovery only after release', async () => {
		const first = native;
		await discover('codex', target, {});
		native = makeNative();
		await discover('codex', target, {});
		first.child.emit('close');
		await blocked();
		native.child.emit('close');
		const hold = await reserve();
		await expect(discover('codex', target, {})).rejects.toThrow(/reserved/);
		expect(mocks.start).toHaveBeenCalledTimes(2);
		hold.release();
	});

	it('timeout ends the verdict but does not establish native close', async () => {
		vi.useFakeTimers();
		reply = false;
		const assertion = expect(discover('codex', target, {})).rejects.toThrow(
			'no response after 5000ms'
		);
		await vi.advanceTimersByTimeAsync(5000);
		await assertion;
		expect(native.terminate).toHaveBeenCalledOnce();
		await blocked();
		native.child.emit('close');
		(await reserve()).release();
	});

	it('stdin failure rejects the request while preserving independent native ownership', async () => {
		reply = false;
		const assertion = expect(discover('codex', target, {})).rejects.toThrow('stdin failed');
		native.handlers.onStdinError?.(new Error('stdin failed'));
		await assertion;
		await blocked();
		native.child.emit('close');
		(await reserve()).release();
	});

	it('native completion rejection is observed independently without claiming close', async () => {
		vi.useFakeTimers();
		reply = false;
		const failure = new Error('native completion failed');
		const assertion = expect(discover('codex', target, {})).rejects.toBe(failure);
		native.done.reject(failure);
		await vi.advanceTimersByTimeAsync(5000);
		await assertion;
		expect(mocks.report).toHaveBeenCalledWith(failure);
		await blocked();
		native.child.emit('close');
		(await reserve()).release();
	});

	it('releases setup failure before launching without attempting cleanup', async () => {
		mocks.plan.mockImplementation(() => {
			throw new Error('shell setup failed');
		});
		await expect(discover('codex', target, {})).rejects.toThrow('shell setup failed');
		expect(mocks.start).not.toHaveBeenCalled();
		expect(native.terminate).not.toHaveBeenCalled();
		(await reserve()).release();
	});

	it('releases a proven not-started launch and retains unknown launch failure', async () => {
		const { TurnNotStartedError } = await import('../../../shared/maestro-lib/run/start-turn');
		mocks.start.mockImplementationOnce(() => {
			throw new TurnNotStartedError(new Error('not started'));
		});
		await expect(discover('codex', target, {})).rejects.toThrow('not started');
		(await reserve()).release();
		mocks.start.mockImplementationOnce(() => {
			throw new Error('unknown child');
		});
		await expect(discover('codex', target, {})).rejects.toThrow('unknown child');
		await blocked();
		expect(native.terminate).not.toHaveBeenCalled();
	});

	it('keeps a missing native close observer blocked', async () => {
		vi.spyOn(native.child, 'on').mockImplementation(() => {
			throw new Error('observer failed');
		});
		await expect(discover('codex', target, {})).rejects.toThrow('observer failed');
		await blocked();
		expect(native.terminate).not.toHaveBeenCalled();
	});

	it('retains unresolved completion when termination throws even after native close', async () => {
		native.terminate.mockImplementation(() => {
			throw new Error('termination failed');
		});
		await expect(discover('codex', target, {})).rejects.toThrow('termination failed');
		native.child.emit('close');
		await blocked();
		native.done.resolve({} as TurnExit);
		(await reserve()).release();
	});

	it('preserves synchronous write failure and holds cleanup until native close', async () => {
		native.child.stdin.write.mockImplementation(() => {
			throw new Error('write failed');
		});
		await expect(discover('codex', target, {})).rejects.toThrow('write failed');
		expect(native.terminate).toHaveBeenCalledOnce();
		await blocked();
		native.child.emit('close');
		(await reserve()).release();
	});

	it('holds through asynchronous cleanup even after the child closes', async () => {
		native.terminate.mockImplementation(() => {});
		const result = discover('codex', target, {});
		await new Promise(setImmediate);
		expect(native.terminate).toHaveBeenCalledOnce();
		native.child.emit('close');
		await blocked();
		native.done.resolve({} as TurnExit);
		await expect(result).resolves.toEqual([]);
		(await reserve()).release();
	});

	it.each(['response', 'stdin-error'] as const)(
		'refuses a retained %s callback before parsing/getters/state after ownership ends',
		async (kind) => {
			await discover('codex', target, {});
			native.child.emit('close');
			const hold = await reserve();
			const getter = vi.fn(() => 'late callback');
			const error = new Error();
			Object.defineProperty(error, 'message', { get: getter });
			const parse = vi.spyOn(JSON, 'parse');
			const callback = () =>
				kind === 'response'
					? native.handlers.onLine?.('{"id":1,"result":{}}')
					: native.handlers.onStdinError?.(error);
			expect(callback).toThrow(/reserved/);
			expect(getter).not.toHaveBeenCalled();
			expect(parse).not.toHaveBeenCalled();
			hold.release();
			expect(callback).not.toThrow();
		}
	);

	it('preserves malformed diagnostic handling and the original error with throwing diagnostics', async () => {
		mocks.report.mockImplementation(() => {
			throw new Error('diagnostics failed');
		});
		reply = false;
		const assertion = expect(discover('codex', target, {})).rejects.toThrow('original failure');
		expect(() => native.handlers.onLine?.('plain diagnostic')).not.toThrow();
		native.handlers.onStdinError?.(new Error('original failure'));
		await assertion;
		native.child.emit('close');
		(await reserve()).release();
	});
});
