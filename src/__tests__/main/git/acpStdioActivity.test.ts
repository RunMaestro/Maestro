import fs from 'fs/promises';
import path from 'path';
import { EventEmitter } from 'events';
import { PassThrough, Writable } from 'stream';
import type { ChildProcess } from 'child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureException } from '../../../shared/maestro-lib/host';

vi.mock('fs/promises', () => ({ default: { realpath: vi.fn() } }));
vi.mock('../../../shared/maestro-lib/host', () => ({ captureException: vi.fn() }));

const target = path.resolve('acp-stdio-fixture');
let gate: typeof import('../../../main/git/worktreeActivity');
let bridge: typeof import('../../../main/process-manager/spawners/acp-stdio');
let stdin: EventEmitter & {
	write: ReturnType<typeof vi.fn>;
	end: ReturnType<typeof vi.fn>;
	destroy: ReturnType<typeof vi.fn>;
	closed: boolean;
};
let stdout: EventEmitter & { destroy: ReturnType<typeof vi.fn> };
let child: ChildProcess;
const bytes = new TextEncoder().encode('permission response\n');
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

async function reserve(root = target) {
	const hold = await gate.reserveWorktreeCleanup(root);
	expect(hold.status).toBe('reserved-partially');
	if (hold.status !== 'reserved-partially') throw new Error('Reservation failed');
	expect(hold.blockers.map((b) => b.message).join(' ')).toMatch(/native.*registration.*OS/);
	return hold;
}
async function blocked() {
	expect(await gate.reserveWorktreeCleanup(target)).toMatchObject({ status: 'blocked' });
}
function callback(method: 'write' | 'end') {
	return stdin[method].mock.calls[0].at(-1) as (error?: Error) => void;
}

beforeEach(async () => {
	vi.resetModules();
	vi.resetAllMocks();
	vi.mocked(fs.realpath).mockImplementation(async (p) => String(p));
	stdin = Object.assign(new EventEmitter(), {
		write: vi.fn(() => false),
		end: vi.fn(),
		destroy: vi.fn(),
		closed: false,
	});
	stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() });
	child = Object.assign(new EventEmitter(), { stdin, stdout }) as unknown as ChildProcess;
	gate = await import('../../../main/git/worktreeActivity');
	bridge = await import('../../../main/process-manager/spawners/acp-stdio');
});

describe('ACP stdio writable activity', () => {
	it.each([target, path.join(target, 'descendant'), `${target}-unrelated`])(
		'refuses standalone setup before stream lookup under %s',
		async (root) => {
			const hold = await reserve(root);
			const lookup = vi.fn();
			const untrusted = new Proxy(child, { get: lookup });
			expect(() => bridge.acpStdioStream(untrusted)).toThrow('reserved');
			expect(lookup).not.toHaveBeenCalled();
			expect(captureException).not.toHaveBeenCalled();
			hold.release();
		}
	);

	it('admits setup before getters and preserves missing-stream errors and diagnostics', async () => {
		let pending!: Promise<unknown>;
		Object.defineProperty(child, 'stdin', {
			get: () => {
				pending = gate.reserveWorktreeCleanup(target);
				return undefined;
			},
		});
		const reporting = Promise.withResolvers<void>();
		vi.mocked(captureException).mockReturnValue(reporting.promise);
		expect(() => bridge.acpStdioStream(child)).toThrow('requires piped stdin and stdout');
		expect(await pending).toMatchObject({ status: 'blocked' });
		await blocked();
		reporting.resolve();
		await drain();
		(await reserve()).release();
	});

	it('preserves UTF-8 and byte reads without claiming child or readable lifetime coverage', async () => {
		const stream = bridge.acpStdioStream(child);
		const reader = stream.readable.getReader();
		const text = reader.read();
		stdout.emit('data', 'Grüße');
		expect((await text).value).toEqual(new TextEncoder().encode('Grüße'));
		const binary = reader.read();
		stdout.emit('data', bytes);
		expect((await binary).value).toBe(bytes);
		stdout.emit('end');
		expect((await reader.read()).done).toBe(true);
		(await reserve()).release();
	});

	it.each(['write', 'end'] as const)(
		'holds delayed %s through its callback despite child close',
		async (method) => {
			const writer = bridge.acpStdioStream(child).writable.getWriter();
			let settled = false;
			const operation = method === 'write' ? writer.write(bytes) : writer.close();
			void operation.then(() => {
				settled = true;
			});
			await drain();
			expect(stdin[method]).toHaveBeenCalledTimes(1);
			if (method === 'write') expect(stdin.write.mock.calls[0][0]).toBe(bytes);
			child.emit('close', 0);
			await blocked();
			expect(settled).toBe(false);
			callback(method)();
			await operation;
			await drain();
			(await reserve()).release();
		}
	);

	it.each(['write', 'end', 'destroy'] as const)(
		'refuses retained %s before native work or reporting',
		async (method) => {
			const writer = bridge.acpStdioStream(child).writable.getWriter();
			child.emit('close', 0);
			const hold = await reserve();
			const operation =
				method === 'write'
					? writer.write(bytes)
					: method === 'end'
						? writer.close()
						: writer.abort();
			await expect(operation).rejects.toThrow('reserved');
			expect(stdin[method]).not.toHaveBeenCalled();
			expect(captureException).not.toHaveBeenCalled();
			hold.release();
			(await reserve()).release();
		}
	);

	it.each(['write', 'end'] as const)(
		'preserves %s callback errors and retains rejected diagnostics',
		async (method) => {
			const writer = bridge.acpStdioStream(child).writable.getWriter();
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockReturnValue(reporting.promise);
			const failure = new Error('native stream failure');
			const operation = method === 'write' ? writer.write(bytes) : writer.close();
			const rejected = expect(operation).rejects.toBe(failure);
			void rejected.catch(() => {});
			await drain();
			callback(method)(failure);
			await rejected;
			expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
			await blocked();
			reporting.reject(new Error('reporting unavailable'));
			await drain();
			expect(captureException).toHaveBeenCalledTimes(1);
			(await reserve()).release();
		}
	);

	it.each(['write', 'end'] as const)(
		'preserves thrown %s errors and unknown completion until callback',
		async (method) => {
			const failure = new Error('native throw after queuing');
			stdin[method].mockImplementation(() => {
				throw failure;
			});
			vi.mocked(captureException).mockImplementation(() => {
				throw new Error('reporter throw');
			});
			const writer = bridge.acpStdioStream(child).writable.getWriter();
			await expect(method === 'write' ? writer.write(bytes) : writer.close()).rejects.toBe(failure);
			await blocked();
			child.emit('close', 0);
			await blocked();
			callback(method)();
			await drain();
			(await reserve()).release();
			expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
		}
	);

	it('holds destroy until observed stream close', async () => {
		const writer = bridge.acpStdioStream(child).writable.getWriter();
		const operation = writer.abort();
		await drain();
		expect(stdin.destroy).toHaveBeenCalledOnce();
		await blocked();
		child.emit('close', 0);
		await blocked();
		stdin.emit('close');
		await operation;
		await drain();
		(await reserve()).release();
	});

	it('retains unknown destroy completion after throw and preserves the original error', async () => {
		const writer = bridge.acpStdioStream(child).writable.getWriter();
		const failure = new Error('destroy failed');
		stdin.destroy.mockImplementation(() => {
			throw failure;
		});
		await expect(writer.abort()).rejects.toBe(failure);
		await blocked();
		stdin.emit('close');
		await drain();
		(await reserve()).release();
	});

	it('handles synchronous destroy-close and previously closed streams', async () => {
		stdin.destroy.mockImplementationOnce(() => stdin.emit('close'));
		await bridge.acpStdioStream(child).writable.abort();
		stdin.closed = true;
		await bridge.acpStdioStream(child).writable.abort();
		await drain();
		expect(stdin.destroy).toHaveBeenCalledTimes(2);
		(await reserve()).release();
	});

	it('wins admission against a pending reservation before a delayed write', async () => {
		const writer = bridge.acpStdioStream(child).writable.getWriter();
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const pending = gate.reserveWorktreeCleanup(target);
		const operation = writer.write(bytes);
		await drain();
		canonical.resolve(target);
		expect(await pending).toMatchObject({ status: 'blocked' });
		callback('write')();
		await operation;
		await drain();
		(await reserve()).release();
	});

	it('retains concurrent bridge writes independently', async () => {
		const first = bridge.acpStdioStream(child).writable.getWriter().write(bytes);
		const second = bridge.acpStdioStream(child).writable.getWriter().write(bytes);
		await drain();
		callback('write')();
		await first;
		await blocked();
		(stdin.write.mock.calls[1].at(-1) as () => void)();
		await second;
		await drain();
		(await reserve()).release();
	});

	it('preserves real Writable backpressure, ordering and end completion', async () => {
		const written: Buffer[] = [];
		let finishWrite!: () => void;
		const nativeInput = new Writable({
			highWaterMark: 1,
			write(chunk, _encoding, done) {
				written.push(chunk);
				finishWrite = done;
			},
		});
		const stream = bridge.acpStdioStream(
			Object.assign(child, { stdin: nativeInput, stdout: new PassThrough() })
		);
		const writer = stream.writable.getWriter();
		const first = writer.write(bytes);
		const second = writer.write(bytes);
		const closing = writer.close();
		await drain();
		expect(written).toHaveLength(1);
		await blocked();
		finishWrite();
		await first;
		await drain();
		expect(written).toEqual([Buffer.from(bytes), Buffer.from(bytes)]);
		await blocked();
		finishWrite();
		await second;
		await closing;
		expect(nativeInput.writableFinished).toBe(true);
		await drain();
		(await reserve()).release();
	});
});
