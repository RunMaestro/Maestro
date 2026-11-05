import fs from 'fs/promises';
import path from 'path';
import { EventEmitter } from 'events';
import { PassThrough, Writable } from 'stream';
import type { ChildProcess } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
let stdout: EventEmitter & { destroy: ReturnType<typeof vi.fn>; closed: boolean };
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
	stdout = Object.assign(new EventEmitter(), { destroy: vi.fn(), closed: false });
	child = Object.assign(new EventEmitter(), { stdin, stdout }) as unknown as ChildProcess;
	gate = await import('../../../main/git/worktreeActivity');
	bridge = await import('../../../main/process-manager/spawners/acp-stdio');
});

afterEach(() => vi.restoreAllMocks());

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

	it('preserves UTF-8 and byte reads without claiming child or listener lifetime coverage', async () => {
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

describe('ACP stdio readable callback and cancellation activity', () => {
	it.each(['data', 'end', 'error'] as const)(
		'refuses a retained %s callback before encoding, controller access or reporting',
		async (event) => {
			const stream = bridge.acpStdioStream(child);
			const reader = stream.readable.getReader();
			const dispatch = stdout.listeners(event)[0];
			child.emit('close', 0);
			const hold = await reserve();
			const encode = vi.spyOn(TextEncoder.prototype, 'encode');
			const enqueue = vi.spyOn(ReadableStreamDefaultController.prototype, 'enqueue');
			const close = vi.spyOn(ReadableStreamDefaultController.prototype, 'close');
			const error = vi.spyOn(ReadableStreamDefaultController.prototype, 'error');
			const failure = new Error('source failure');
			expect(() => dispatch(event === 'data' ? 'Grüße' : failure)).toThrow('reserved');
			for (const effect of [encode, enqueue, close, error, captureException])
				expect(effect).not.toHaveBeenCalled();
			hold.release();
			// Refusal must not poison the controller or replace a later native error.
			dispatch(event === 'data' ? 'Grüße' : failure);
			if (event === 'data')
				expect((await reader.read()).value).toEqual(new TextEncoder().encode('Grüße'));
			else if (event === 'end') expect((await reader.read()).done).toBe(true);
			else await expect(reader.read()).rejects.toBe(failure);
			(await reserve()).release();
		}
	);

	it('preserves encoding failures as the original readable rejection', async () => {
		const reader = bridge.acpStdioStream(child).readable.getReader();
		const failure = new Error('encode failed');
		vi.spyOn(TextEncoder.prototype, 'encode').mockImplementationOnce(() => {
			throw failure;
		});
		stdout.emit('data', 'text');
		await expect(reader.read()).rejects.toBe(failure);
		expect(captureException).not.toHaveBeenCalled();
		(await reserve()).release();
	});

	it.each(['resolve', 'reject', 'throw'] as const)(
		'retains late controller failure reporting until %s without replacing its throw',
		async (outcome) => {
			bridge.acpStdioStream(child);
			const end = stdout.listeners('end')[0];
			stdout.emit('end');
			child.emit('close', 0);
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockImplementation(() => {
				if (outcome === 'throw') throw new Error('reporter threw');
				return reporting.promise;
			});
			const failure = new Error('controller already closed');
			vi.spyOn(ReadableStreamDefaultController.prototype, 'close').mockImplementation(() => {
				throw failure;
			});
			expect(end).toThrow(failure);
			expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
			if (outcome !== 'throw') {
				await blocked();
				if (outcome === 'resolve') reporting.resolve();
				else reporting.reject(new Error('reporter rejected'));
				await drain();
			}
			(await reserve()).release();
			expect(captureException).toHaveBeenCalledTimes(1);
		}
	);

	it('retains independent late callback diagnostics across concurrent reports and pending reservation', async () => {
		bridge.acpStdioStream(child);
		const end = stdout.listeners('end')[0];
		stdout.emit('end');
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const pending = gate.reserveWorktreeCleanup(target);
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		vi.mocked(captureException)
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		expect(end).toThrow();
		expect(end).toThrow();
		canonical.resolve(target);
		expect(await pending).toMatchObject({ status: 'blocked' });
		first.resolve();
		await drain();
		await blocked();
		second.resolve();
		await drain();
		(await reserve()).release();
	});

	it('refuses cancellation before native lookup, close observer, destroy or reporting', async () => {
		const stream = bridge.acpStdioStream(child);
		const hold = await reserve();
		const closed = vi.fn(() => false);
		Object.defineProperty(stdout, 'closed', { get: closed });
		const observe = vi.spyOn(stdout, 'once');
		await expect(stream.readable.cancel()).rejects.toThrow('reserved');
		for (const effect of [closed, observe, stdout.destroy, captureException])
			expect(effect).not.toHaveBeenCalled();
		hold.release();
	});

	it('holds cancellation until stdout close independently of child or stdin close', async () => {
		const stream = bridge.acpStdioStream(child);
		let settled = false;
		const cancelling = stream.readable.cancel().then(() => {
			settled = true;
		});
		expect(stdout.destroy).toHaveBeenCalledOnce();
		child.emit('close', 0);
		stdin.emit('close');
		await blocked();
		expect(settled).toBe(false);
		stdout.emit('close');
		await cancelling;
		await drain();
		(await reserve()).release();
	});

	it.each(['resolve', 'reject', 'throw'] as const)(
		'preserves a thrown destroy with %s reporting and unknown native completion',
		async (outcome) => {
			const stream = bridge.acpStdioStream(child);
			const failure = new Error('destroy may have started');
			stdout.destroy.mockImplementation(() => {
				throw failure;
			});
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockImplementation(() => {
				if (outcome === 'throw') throw new Error('reporter threw');
				return reporting.promise;
			});
			await expect(stream.readable.cancel()).rejects.toBe(failure);
			if (outcome === 'resolve') reporting.resolve();
			else if (outcome === 'reject') reporting.reject(new Error('reporter rejected'));
			await drain();
			child.emit('close', 0);
			await blocked();
			stdout.emit('close');
			await drain();
			(await reserve()).release();
			expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
		}
	);

	it('keeps cancellation diagnostics after native completion and a successor setup', async () => {
		const stream = bridge.acpStdioStream(child);
		const failure = new Error('destroy failed');
		stdout.destroy.mockImplementation(() => {
			stdout.emit('close');
			throw failure;
		});
		const reporting = Promise.withResolvers<void>();
		vi.mocked(captureException).mockReturnValue(reporting.promise);
		await expect(stream.readable.cancel()).rejects.toBe(failure);
		bridge.acpStdioStream(child);
		await blocked();
		reporting.resolve();
		await drain();
		(await reserve()).release();
	});

	it.each([false, true])(
		'handles synchronous destroy-close and already-closed=%s',
		async (closed) => {
			stdout.closed = closed;
			if (!closed) stdout.destroy.mockImplementationOnce(() => stdout.emit('close'));
			await bridge.acpStdioStream(child).readable.cancel();
			expect(stdout.destroy).toHaveBeenCalledOnce();
			await drain();
			(await reserve()).release();
		}
	);

	it('tracks concurrent cancellations independently across sources', async () => {
		const first = bridge.acpStdioStream(child).readable.cancel();
		const other = Object.assign(new EventEmitter(), { destroy: vi.fn(), closed: false });
		const second = bridge.acpStdioStream(Object.assign(child, { stdout: other })).readable.cancel();
		stdout.emit('close');
		await first;
		await blocked();
		other.emit('close');
		await second;
		await drain();
		(await reserve()).release();
	});

	it('preserves a real PassThrough read and waits for actual cancellation close', async () => {
		const output = new PassThrough();
		output.setEncoding('utf8');
		const reader = bridge
			.acpStdioStream(Object.assign(child, { stdout: output }))
			.readable.getReader();
		const reading = reader.read();
		output.write('Grüße');
		expect((await reading).value).toEqual(new TextEncoder().encode('Grüße'));
		await reader.cancel();
		expect(output.closed).toBe(true);
		await drain();
		(await reserve()).release();
	});
});
