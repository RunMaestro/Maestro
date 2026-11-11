import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServerRpc } from '../../../../shared/maestro-lib/codex/rpc-client';
import {
	RpcRequestTracker,
	type RpcTransportFailure,
} from '../../../../shared/maestro-lib/protocol/rpc-requests';

describe('RpcRequestTracker', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it.each(['resolve', 'reject', 'close'] as const)(
		'keeps synchronous %s settlement when the writer subsequently throws',
		async (settlement) => {
			const closedError = new Error('wrapper: closed');
			const protocolError = new Error('wrapper: refused');
			const transportError = vi.fn(() => closedError);
			const tracker = new RpcRequestTracker(transportError);
			const pending = tracker.request(
				'operation',
				(id) => {
					if (settlement === 'resolve') tracker.resolve(id, 'answer');
					else if (settlement === 'reject') tracker.reject(id, () => protocolError);
					else tracker.close('stream ended');
					throw new Error('late write failure');
				},
				100
			);
			if (settlement === 'resolve') await expect(pending).resolves.toBe('answer');
			else
				await expect(pending).rejects.toBe(settlement === 'reject' ? protocolError : closedError);
			expect(vi.getTimerCount()).toBe(0);
			expect(tracker.resolve(1, 'duplicate')).toBe(false);
			const duplicateError = vi.fn(() => new Error('duplicate'));
			expect(tracker.reject(1, duplicateError)).toBe(false);
			expect(duplicateError).not.toHaveBeenCalled();
			vi.advanceTimersByTime(100);
			if (settlement === 'close') {
				expect(transportError).toHaveBeenCalledExactlyOnceWith('operation', {
					type: 'closed',
					reason: 'stream ended',
				});
			} else expect(transportError).not.toHaveBeenCalled();
		}
	);

	it('passes the original write cause to the wrapper and removes its deadline', async () => {
		const cause = { code: 'EPIPE' };
		const formattedError = new Error('second protocol write error');
		const transportError = vi.fn(() => formattedError);
		const tracker = new RpcRequestTracker(transportError);
		const pending = tracker.request(
			'write-operation',
			() => {
				throw cause;
			},
			50
		);
		await expect(pending).rejects.toBe(formattedError);
		expect(transportError).toHaveBeenCalledExactlyOnceWith('write-operation', {
			type: 'write',
			cause,
		});
		expect(vi.getTimerCount()).toBe(0);
		expect(tracker.resolve(1, 'late answer')).toBe(false);
		tracker.close('closed after failure');
		vi.advanceTimersByTime(50);
		expect(transportError).toHaveBeenCalledTimes(1);
	});

	it('formats a deadline once and leaves unrelated requests without a deadline pending', async () => {
		const timeoutError = new Error('second protocol deadline error');
		const transportError = vi.fn(() => timeoutError);
		const tracker = new RpcRequestTracker(transportError);
		const timed = tracker.request('timed', () => {}, 25);
		const untimed = tracker.request('untimed', () => {});
		const rejection = expect(timed).rejects.toBe(timeoutError);
		vi.advanceTimersByTime(25);
		await rejection;
		expect(transportError).toHaveBeenCalledExactlyOnceWith('timed', {
			type: 'timeout',
			timeoutMs: 25,
		});
		expect(vi.getTimerCount()).toBe(0);
		const staleError = vi.fn(() => new Error('stale rejection'));
		expect(tracker.reject(1, staleError)).toBe(false);
		expect(tracker.reject(999, staleError)).toBe(false);
		expect(staleError).not.toHaveBeenCalled();
		expect(tracker.resolve(2, 'still available')).toBe(true);
		await expect(untimed).resolves.toBe('still available');
		tracker.close('done');
		expect(transportError).toHaveBeenCalledTimes(1);
	});

	it('preserves an empty first close reason and never writes a refused request', async () => {
		const closedError = new Error('second protocol closed error');
		const transportError = vi.fn(() => closedError);
		const tracker = new RpcRequestTracker(transportError);
		const write = vi.fn();
		tracker.close('');
		tracker.close('replacement reason');
		expect(tracker.isClosed).toBe(true);
		await expect(tracker.request('after-close', write, 100)).rejects.toBe(closedError);
		expect(write).not.toHaveBeenCalled();
		expect(transportError).toHaveBeenCalledExactlyOnceWith('after-close', {
			type: 'closed',
			reason: '',
		});
		expect(vi.getTimerCount()).toBe(0);
	});

	it('supports a second envelope and error contract independently of the Codex wrapper', async () => {
		// Synthetic protocol, deliberately not an implementation of Grok ACP.
		const frames: Array<{ ticket: number; operation: string; data: unknown }> = [];
		const transportError = vi.fn((method: string, failure: RpcTransportFailure) =>
			Object.assign(new Error(`second protocol: ${method}`), { failure })
		);
		const tracker = new RpcRequestTracker(transportError);
		const secondProtocol = {
			request(operation: string, data: unknown) {
				return tracker.request(operation, (ticket) => frames.push({ ticket, operation, data }), 50);
			},
			receive(frame: { ticket: number; value: unknown }) {
				return tracker.resolve(frame.ticket, frame.value);
			},
		};
		const codexLines: string[] = [];
		const codex = new CodexAppServerRpc((line) => codexLines.push(line));
		const codexPending = codex.request('initialize');
		const first = secondProtocol.request('open', { version: 1 });
		const second = secondProtocol.request('read', null);
		expect(JSON.parse(codexLines[0])).toEqual({ jsonrpc: '2.0', id: 1, method: 'initialize' });
		expect(frames).toEqual([
			{ ticket: 1, operation: 'open', data: { version: 1 } },
			{ ticket: 2, operation: 'read', data: null },
		]);
		expect(secondProtocol.receive({ ticket: 2, value: 'second result' })).toBe(true);
		expect(secondProtocol.receive({ ticket: 1, value: 'first result' })).toBe(true);
		await expect(first).resolves.toBe('first result');
		await expect(second).resolves.toBe('second result');
		expect(secondProtocol.receive({ ticket: 2, value: 'duplicate' })).toBe(false);
		const timed = secondProtocol.request('wait', undefined);
		const rejection = expect(timed).rejects.toMatchObject({
			message: 'second protocol: wait',
			failure: { type: 'timeout', timeoutMs: 50 },
		});
		vi.advanceTimersByTime(50);
		await rejection;
		tracker.close('second protocol ended');
		expect(codex.isClosed).toBe(false);
		expect(codex.handleResponse({ id: 1, result: 'Codex result' })).toBe(true);
		await expect(codexPending).resolves.toBe('Codex result');
		expect(transportError).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});
