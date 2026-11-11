import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	answerCodexServerRequest,
	CODEX_RPC_METHOD_NOT_FOUND,
} from '../../../main/codex-app-server/server-requests';
import {
	CodexAppServerRpc,
	CodexRpcRequestError,
	CodexRpcTransportError,
} from '../../../main/codex-app-server/rpc-client';

const request = (method: string, params: unknown = {}) => ({ id: 0, method, params });
const FULL = { grantApprovals: true };
const RESTRICTED = { grantApprovals: false };

describe('answerCodexServerRequest', () => {
	it.each([
		['item/commandExecution/requestApproval', { decision: 'accept' }, { decision: 'decline' }],
		['item/fileChange/requestApproval', { decision: 'accept' }, { decision: 'decline' }],
		['execCommandApproval', { decision: 'approved' }, { decision: 'denied' }],
		['applyPatchApproval', { decision: 'approved' }, { decision: 'denied' }],
		['item/tool/requestUserInput', { answers: {} }, { answers: {} }],
		['mcpServer/elicitation/request', { action: 'decline' }, { action: 'decline' }],
		['item/tool/call', { success: false, contentItems: [] }, { success: false, contentItems: [] }],
	])('%s', (method, granted, restricted) => {
		expect(answerCodexServerRequest(request(method), FULL)).toEqual({ result: granted });
		expect(answerCodexServerRequest(request(method), RESTRICTED)).toEqual({ result: restricted });
	});

	it('grants the requested permission profile for the turn only with full access', () => {
		const permissions = { network: { enabled: true } };
		expect(
			answerCodexServerRequest(request('item/permissions/requestApproval', { permissions }), FULL)
		).toEqual({ result: { permissions, scope: 'turn' } });
		expect(
			answerCodexServerRequest(
				request('item/permissions/requestApproval', { permissions }),
				RESTRICTED
			)
		).toEqual({ result: { permissions: {} } });
	});

	it.each(['account/chatgptAuthTokens/refresh', 'attestation/generate', 'something/new'])(
		'answers %s with a JSON-RPC error, never silence',
		(method) => {
			const answer = answerCodexServerRequest(request(method), FULL);
			expect(answer).toMatchObject({ error: { code: CODEX_RPC_METHOD_NOT_FOUND } });
		}
	);
});

describe('CodexAppServerRpc', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	function rpc() {
		const lines: Array<Record<string, unknown>> = [];
		const client = new CodexAppServerRpc((line) => lines.push(JSON.parse(line)));
		return { client, lines };
	}

	it('correlates out-of-order responses without accepting unknown, string or duplicate IDs', async () => {
		const { client, lines } = rpc();
		const first = client.request('initialize', { a: 1 }, { timeoutMs: 100 });
		const second = client.request('thread/start', undefined, { timeoutMs: 200 });
		expect(lines).toEqual([
			{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { a: 1 } },
			{ jsonrpc: '2.0', id: 2, method: 'thread/start' },
		]);
		expect(client.handleResponse({ id: 99, result: {} })).toBe(false);
		expect(client.handleResponse({ id: '1', result: {} })).toBe(false);
		expect(client.handleResponse({ id: '2', error: { code: -1, message: 'wrong ID' } })).toBe(
			false
		);
		expect(vi.getTimerCount()).toBe(2);
		expect(client.handleResponse({ id: 2, result: { ok: 2 } })).toBe(true);
		expect(vi.getTimerCount()).toBe(1);
		expect(client.handleResponse({ id: 2, result: { ok: 'duplicate' } })).toBe(false);
		expect(client.handleResponse({ id: 2, error: { code: -1, message: 'late' } })).toBe(false);
		expect(client.handleResponse({ id: 1, result: { ok: 1 } })).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(200);
		await expect(first).resolves.toEqual({ ok: 1 });
		await expect(second).resolves.toEqual({ ok: 2 });
		expect(client.handleResponse({ id: 1, result: {} })).toBe(false);
	});

	it('preserves the public server error fields and clears its deadline', async () => {
		const { client } = rpc();
		const data = { turnId: 'turn-1', retryable: false };
		const pending = client.request('turn/steer', undefined, { timeoutMs: 100 });
		expect(
			client.handleResponse({
				id: 1,
				error: { code: -32600, message: 'no active turn to steer', data },
			})
		).toBe(true);
		const error = await pending.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(CodexRpcRequestError);
		expect(error).toMatchObject({
			name: 'CodexRpcRequestError',
			method: 'turn/steer',
			message: 'turn/steer failed: no active turn to steer',
			code: -32600,
		});
		expect((error as CodexRpcRequestError).data).toBe(data);
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(100);
		expect(client.handleResponse({ id: 1, result: 'late success' })).toBe(false);
		expect(client.handleResponse({ id: 1, error: { code: -1, message: 'duplicate' } })).toBe(false);
	});

	it('expires at the deadline and ignores late replies without closing or reusing IDs', async () => {
		const { client, lines } = rpc();
		const slow = client.request('initialize', undefined, { timeoutMs: 100 });
		const failure = slow.catch((error: unknown) => error);
		vi.advanceTimersByTime(99);
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(1);
		expect(await failure).toBeInstanceOf(CodexRpcTransportError);
		expect(await failure).toMatchObject({
			name: 'CodexRpcTransportError',
			method: 'initialize',
			message: 'initialize: no response after 100ms',
		});
		expect(vi.getTimerCount()).toBe(0);
		expect(client.isClosed).toBe(false);
		const next = client.request('thread/start', undefined, { timeoutMs: 100 });
		expect(lines.map((line) => line.id)).toEqual([1, 2]);
		expect(client.handleResponse({ id: 1, result: 'stale' })).toBe(false);
		expect(client.handleResponse({ id: 1, error: { code: -1, message: 'stale' } })).toBe(false);
		expect(vi.getTimerCount()).toBe(1);
		expect(client.handleResponse({ id: 2, result: 'current' })).toBe(true);
		await expect(next).resolves.toBe('current');
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(['app-server exited', ''])(
		'closes pending requests once with the first reason %j and preserves completed responses',
		async (reason) => {
			const { client, lines } = rpc();
			expect(client.isClosed).toBe(false);
			const completed = client.request('initialize', undefined, { timeoutMs: 100 });
			client.handleResponse({ id: 1, result: 'ready' });
			const pending = client.request('turn/start', undefined, { timeoutMs: 100 });
			const untimed = client.request('thread/read');
			const failures = Promise.all([
				pending.catch((error: unknown) => error),
				untimed.catch((error: unknown) => error),
			]);
			client.close(reason);
			client.close('replacement reason');
			expect(client.isClosed).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
			vi.advanceTimersByTime(100);
			const errors = await failures;
			for (const [index, method] of ['turn/start', 'thread/read'].entries()) {
				expect(errors[index]).toBeInstanceOf(CodexRpcTransportError);
				expect(errors[index]).toMatchObject({
					name: 'CodexRpcTransportError',
					method,
					message: `${method}: ${reason}`,
				});
			}
			await expect(completed).resolves.toBe('ready');
			expect(client.handleResponse({ id: 2, result: 'late' })).toBe(false);
			expect(client.handleResponse({ id: 3, error: { code: -1, message: 'late' } })).toBe(false);
			const refused = client.request('turn/interrupt', undefined, { timeoutMs: 100 });
			await expect(refused).rejects.toBeInstanceOf(CodexRpcTransportError);
			await expect(refused).rejects.toMatchObject({
				method: 'turn/interrupt',
				message: `turn/interrupt: ${reason}`,
			});
			expect(lines).toHaveLength(3);
			expect(vi.getTimerCount()).toBe(0);
		}
	);

	it.each([
		[new Error('closed'), 'Error: closed'],
		['closed', 'closed'],
	])('rejects synchronous write failure %j and clears its deadline', async (cause, detail) => {
		const writer = vi.fn().mockImplementationOnce(() => {
			throw cause;
		});
		const client = new CodexAppServerRpc(writer);
		const failed = client.request('initialize', undefined, { timeoutMs: 100 });
		await expect(failed).rejects.toBeInstanceOf(CodexRpcTransportError);
		await expect(failed).rejects.toMatchObject({
			name: 'CodexRpcTransportError',
			method: 'initialize',
			message: `initialize: write failed: ${detail}`,
		});
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(100);
		expect(client.handleResponse({ id: 1, result: 'late' })).toBe(false);
		expect(client.isClosed).toBe(false);
		const next = client.request('thread/start');
		expect(JSON.parse(writer.mock.calls[1][0])).toEqual({
			jsonrpc: '2.0',
			id: 2,
			method: 'thread/start',
		});
		client.handleResponse({ id: 2, result: null });
		await expect(next).resolves.toBeNull();
	});

	it('keeps notification and server-answer envelopes independent of request IDs and close', async () => {
		const { client, lines } = rpc();
		client.notify('initialized');
		client.notify('custom/event', null);
		client.respond(0, { result: { decision: 'decline' } });
		const pending = client.request('initialize');
		client.handleResponse({ id: 1, result: undefined });
		await expect(pending).resolves.toBeUndefined();
		client.close('done');
		client.notify('custom/event', { value: 1 });
		client.respond('server-request', { error: { code: -32601, message: 'unsupported' } });
		expect(lines).toEqual([
			{ jsonrpc: '2.0', method: 'initialized' },
			{ jsonrpc: '2.0', method: 'custom/event', params: null },
			{ jsonrpc: '2.0', id: 0, result: { decision: 'decline' } },
			{ jsonrpc: '2.0', id: 1, method: 'initialize' },
			{ jsonrpc: '2.0', method: 'custom/event', params: { value: 1 } },
			{ jsonrpc: '2.0', id: 'server-request', error: { code: -32601, message: 'unsupported' } },
		]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('continues to throw the original writer error synchronously for notifications and answers', () => {
		const failure = new Error('stdin gone');
		const client = new CodexAppServerRpc(() => {
			throw failure;
		});
		for (const closed of [false, true]) {
			if (closed) client.close('done');
			for (const write of [
				() => client.notify('initialized'),
				() => client.respond('server-request', { result: null }),
			]) {
				const attempt = vi.fn(write);
				expect(attempt).toThrow(failure);
				expect(attempt.mock.results[0].value).toBe(failure);
			}
		}
		expect(vi.getTimerCount()).toBe(0);
	});
});
