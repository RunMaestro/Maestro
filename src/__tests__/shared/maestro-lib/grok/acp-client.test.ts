import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GrokAcpClient } from '../../../../shared/maestro-lib/grok/acp-client';
import {
	GrokAcpRequestError,
	GrokAcpTransportError,
	type AcpCall,
} from '../../../../shared/maestro-lib/grok/acp-protocol';

const secret = 'synthetic-private-payload';
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) + '\n');

describe('GrokAcpClient byte-stream transport', () => {
	let client: GrokAcpClient;
	const write = vi.fn<(frame: Uint8Array) => void>();
	const onClose = vi.fn();
	const onNotification = vi.fn();
	const sent = (index = -1): AcpCall =>
		JSON.parse(new TextDecoder().decode(write.mock.calls.at(index)![0]));
	const receive = (message: Record<string, unknown>) =>
		client.feedStdout(bytes({ jsonrpc: '2.0', ...message }));
	async function initialize(result: unknown = { protocolVersion: 1 }) {
		const pending = client.initialize();
		await Promise.resolve();
		receive({ id: sent().id, result });
		return pending;
	}

	beforeEach(() => {
		vi.useFakeTimers();
		write.mockReset();
		onClose.mockReset();
		onNotification.mockReset();
		client = new GrokAcpClient({ write, onClose, onNotification });
	});
	afterEach(() => {
		client.close();
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('negotiates once across reentry, retains extensions and sends no initialized notification', async () => {
		await expect(client.request('session/new')).rejects.toMatchObject({
			reason: 'not-initialized',
		});
		expect(() => client.notify('session/cancel')).toThrow(
			new GrokAcpTransportError('not-initialized')
		);
		const reentered: Promise<unknown>[] = [];
		write.mockImplementationOnce(() => {
			reentered.push(client.initialize());
		});
		const pending = client.initialize();
		expect(client.initialize()).toBe(pending);
		await Promise.resolve();
		expect(reentered).toEqual([pending]);
		expect(sent()).toEqual({
			jsonrpc: '2.0',
			id: expect.any(Number),
			method: 'initialize',
			params: { protocolVersion: 1, clientCapabilities: {} },
		});
		receive({ id: sent().id, result: { protocolVersion: 1, _meta: { future: true } } });
		await expect(pending).resolves.toEqual({
			protocolVersion: 1,
			agentCapabilities: {},
			authMethods: [],
			_meta: { future: true },
		});
		expect(client.initialize()).toBe(pending);
		expect(write).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('preserves valid advertised capabilities without inventing support for extensions', async () => {
		const result = {
			protocolVersion: 1,
			agentCapabilities: {
				loadSession: true,
				promptCapabilities: { image: false },
				mcpCapabilities: { http: true },
				sessionCapabilities: { resume: {}, close: null },
				future: { opaque: true },
			},
			authMethods: [{ id: 'synthetic-auth', name: 'Test account', description: null }],
			agentInfo: { name: 'fake-grok', version: 'fixture', title: null },
			_meta: null,
		};
		await expect(initialize(result)).resolves.toEqual(result);
		expect(client.isClosed).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([
		null,
		{},
		{ protocolVersion: 2 },
		{ protocolVersion: '1' },
		{ protocolVersion: 1, agentCapabilities: { loadSession: 'yes' } },
		{ protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: 1 } } },
		{ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: true } } },
		{ protocolVersion: 1, authMethods: [{ id: secret }] },
		{ protocolVersion: 1, agentInfo: { name: secret } },
	])('closes on incompatible initialization %j', async (result) => {
		await expect(initialize(result)).rejects.toEqual(
			new GrokAcpTransportError('negotiation-failed')
		);
		expect(client.isClosed).toBe(true);
		expect(onClose).toHaveBeenCalledExactlyOnceWith(
			new GrokAcpTransportError('negotiation-failed')
		);
		await expect(client.initialize()).rejects.toBe(onClose.mock.calls[0][0]);
		await expect(client.request('session/new')).rejects.toBe(onClose.mock.calls[0][0]);
		expect(write).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('correlates out-of-order replies and ignores string, unknown, duplicate and stale IDs', async () => {
		await initialize();
		const firstDone = vi.fn();
		const secondDone = vi.fn();
		const first = client.request('session/new').then(firstDone);
		const firstId = sent().id;
		const second = client.request('session/load').then(secondDone);
		const secondId = sent().id;
		receive({ id: String(firstId), result: 'wrong type' });
		receive({ id: 999, error: { code: -1, message: secret } });
		expect(vi.getTimerCount()).toBe(2);
		receive({ id: secondId, result: 'second' });
		receive({ id: secondId, error: { code: -1, message: secret } });
		await second;
		expect(firstDone).not.toHaveBeenCalled();
		expect(secondDone).toHaveBeenCalledExactlyOnceWith('second');
		expect(vi.getTimerCount()).toBe(1);
		receive({ id: firstId, result: 'first' });
		receive({ id: firstId, result: 'duplicate' });
		await first;
		client.close();
		receive({ id: firstId, result: 'stale' });
		vi.advanceTimersByTime(30_000);
		expect(firstDone).toHaveBeenCalledExactlyOnceWith('first');
		expect(secondDone).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('separates stderr from replies, forwards opaque notifications and refuses unknown methods', async () => {
		await initialize();
		const pending = client.request('session/new');
		const id = sent().id;
		const stderr = bytes({ jsonrpc: '2.0', id, result: secret });
		client.feedStderr(stderr);
		expect(client.stderrBytes).toBe(stderr.byteLength);
		expect(client.bufferedBytes).toBe(0);
		expect(vi.getTimerCount()).toBe(1);
		receive({ method: 'future/update', params: { opaque: [1, 2] } });
		expect(onNotification).toHaveBeenCalledExactlyOnceWith({
			jsonrpc: '2.0',
			method: 'future/update',
			params: { opaque: [1, 2] },
		});
		receive({ id: 'server-1', method: 'session/request_permission', params: { token: secret } });
		expect(sent()).toEqual({
			jsonrpc: '2.0',
			id: 'server-1',
			error: { code: -32601, message: 'Method not found' },
		});
		receive({ id, result: 'stdout' });
		await expect(pending).resolves.toBe('stdout');
	});

	it('times out only the expired request without replay and ignores its late response', async () => {
		await initialize();
		const failed = vi.fn();
		const expired = client.request(secret, { token: secret }, { timeoutMs: 10 }).catch(failed);
		const expiredId = sent().id;
		const survivor = client.request('session/load');
		const survivorId = sent().id;
		vi.advanceTimersByTime(9);
		expect(failed).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		await expired;
		expect(failed).toHaveBeenCalledExactlyOnceWith(new GrokAcpTransportError('timeout'));
		const error = failed.mock.calls[0][0];
		expect(String(error) + JSON.stringify(error)).not.toContain(secret);
		expect(vi.getTimerCount()).toBe(1);
		receive({ id: expiredId, result: 'late' });
		receive({ id: survivorId, result: 'survivor' });
		await expect(survivor).resolves.toBe('survivor');
		vi.advanceTimersByTime(30_000);
		expect(failed).toHaveBeenCalledTimes(1);
		expect(write).toHaveBeenCalledTimes(3);
		expect(onClose).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(['closed', 'incomplete-frame', 'malformed-frame', 'frame-too-large', 'write'] as const)(
		'rejects every pending request once on %s and releases buffered bytes/deadlines',
		async (reason) => {
			client = new GrokAcpClient({ write, onClose, maxFrameBytes: 256 });
			await initialize();
			const success = vi.fn();
			const failure = vi.fn();
			const pending = Promise.all(
				[client.request('session/new', { token: secret }), client.request('session/load')].map(
					(promise) => promise.then(success, failure)
				)
			);
			if (reason === 'malformed-frame') client.feedStdout(new TextEncoder().encode(secret + '\n'));
			else if (reason === 'frame-too-large') client.feedStdout(new Uint8Array(257).fill(120));
			else {
				if (reason === 'incomplete-frame')
					client.feedStdout(new TextEncoder().encode('{"secret":"' + secret));
				client.close(reason === 'write' ? 'write' : 'closed');
			}
			await pending;
			const error = onClose.mock.calls[0][0];
			expect(error).toEqual(new GrokAcpTransportError(reason));
			expect(String(error) + JSON.stringify(error)).not.toContain(secret);
			expect(failure).toHaveBeenCalledTimes(2);
			for (const [received] of failure.mock.calls) expect(received).toBe(error);
			expect(success).not.toHaveBeenCalled();
			expect(client.isClosed).toBe(true);
			expect(client.bufferedBytes).toBe(0);
			expect(vi.getTimerCount()).toBe(0);
			client.close('write');
			receive({ id: sent().id, result: 'late' });
			vi.advanceTimersByTime(30_000);
			await expect(client.request('session/new')).rejects.toBe(error);
			expect(() => client.notify('session/cancel')).toThrow(error);
			expect(onClose).toHaveBeenCalledTimes(1);
			expect(failure).toHaveBeenCalledTimes(2);
			expect(write).toHaveBeenCalledTimes(3);
		}
	);

	it('rejects a complete JSON reply without its terminating LF at EOF', async () => {
		await initialize();
		const pending = client.request('session/new');
		const frame = bytes({ jsonrpc: '2.0', id: sent().id, result: 'unfinished' });
		client.feedStdout(frame.subarray(0, -1));
		expect(client.bufferedBytes).toBe(frame.byteLength - 1);
		expect(vi.getTimerCount()).toBe(1);
		client.close();
		await expect(pending).rejects.toEqual(new GrokAcpTransportError('incomplete-frame'));
		expect(client.bufferedBytes).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(['timeout', 'disconnect'] as const)('cleans up a handshake on %s', async (cause) => {
		const failed = vi.fn();
		const pending = client.initialize().catch(failed);
		await Promise.resolve();
		if (cause === 'timeout') vi.advanceTimersByTime(30_000);
		else client.close();
		await pending;
		expect(failed).toHaveBeenCalledExactlyOnceWith(
			new GrokAcpTransportError(cause === 'timeout' ? 'timeout' : 'closed')
		);
		receive({ id: sent().id, result: { protocolVersion: 1 } });
		expect(client.isClosed).toBe(true);
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(write).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(['remote', 'writer'] as const)(
		'omits secret payloads and causes from %s errors',
		async (source) => {
			await initialize();
			if (source === 'writer')
				write.mockImplementationOnce(() => {
					throw new Error(secret);
				});
			const pending = client.request(secret, { token: secret });
			if (source === 'remote')
				receive({
					id: sent().id,
					error: { code: -32603, message: secret, data: { token: secret } },
				});
			const error = await pending.catch((value: unknown) => value);
			expect(error).toEqual(
				source === 'remote' ? new GrokAcpRequestError(-32603) : new GrokAcpTransportError('write')
			);
			expect(error).not.toHaveProperty('cause');
			expect(error).not.toHaveProperty('data');
			expect(String(error) + JSON.stringify(error)).not.toContain(secret);
			expect(vi.getTimerCount()).toBe(0);
			const retry = client.request('session/new');
			receive({ id: sent().id, result: 'explicit new request' });
			await expect(retry).resolves.toBe('explicit new request');
		}
	);

	it('refuses outbound multibyte overflow before writing and removes its deadline', async () => {
		client = new GrokAcpClient({ write, maxFrameBytes: 256 });
		await initialize();
		await expect(client.request('session/prompt', { text: '🌍'.repeat(60) })).rejects.toEqual(
			new GrokAcpTransportError('frame-too-large')
		);
		expect(write).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([0, -1, 0.5, NaN, Infinity, 2_147_483_648])(
		'refuses invalid deadlines %s without writing',
		async (timeoutMs) => {
			expect(() => new GrokAcpClient({ write, requestTimeoutMs: timeoutMs })).toThrow(
				new GrokAcpTransportError('invalid-timeout')
			);
			await initialize();
			await expect(client.request('session/new', undefined, { timeoutMs })).rejects.toEqual(
				new GrokAcpTransportError('invalid-timeout')
			);
			expect(write).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(0);
		}
	);
});
