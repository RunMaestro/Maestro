import { describe, it, expect, vi, afterEach } from 'vitest';
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
	afterEach(() => {
		vi.useRealTimers();
	});

	function rpc() {
		const lines: Array<Record<string, unknown>> = [];
		const client = new CodexAppServerRpc((line) => lines.push(JSON.parse(line)));
		return { client, lines };
	}

	it('numbers requests and resolves them from their responses', async () => {
		const { client, lines } = rpc();
		const first = client.request('initialize', { a: 1 });
		const second = client.request('thread/start');
		expect(lines).toEqual([
			{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { a: 1 } },
			{ jsonrpc: '2.0', id: 2, method: 'thread/start' },
		]);
		expect(client.handleResponse({ id: 2, result: { ok: 2 } })).toBe(true);
		expect(client.handleResponse({ id: 1, result: { ok: 1 } })).toBe(true);
		await expect(first).resolves.toEqual({ ok: 1 });
		await expect(second).resolves.toEqual({ ok: 2 });
		expect(client.handleResponse({ id: 1, result: {} })).toBe(false);
	});

	it('rejects with the server error code', async () => {
		const { client } = rpc();
		const pending = client.request('turn/steer');
		client.handleResponse({ id: 1, error: { code: -32600, message: 'no active turn to steer' } });
		const error = await pending.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(CodexRpcRequestError);
		expect((error as CodexRpcRequestError).code).toBe(-32600);
	});

	it('times out, fails on close, and refuses after close', async () => {
		vi.useFakeTimers();
		const { client } = rpc();
		const slow = client.request('initialize', undefined, { timeoutMs: 100 });
		vi.advanceTimersByTime(100);
		await expect(slow).rejects.toBeInstanceOf(CodexRpcTransportError);

		const orphan = client.request('turn/start');
		client.close('app-server exited');
		await expect(orphan).rejects.toThrow('app-server exited');
		await expect(client.request('turn/interrupt')).rejects.toBeInstanceOf(CodexRpcTransportError);
	});

	it('rejects when stdin cannot be written', async () => {
		const client = new CodexAppServerRpc(() => {
			throw new Error('closed');
		});
		await expect(client.request('initialize')).rejects.toBeInstanceOf(CodexRpcTransportError);
	});

	it('writes notifications and answers to server requests', () => {
		const { client, lines } = rpc();
		client.notify('initialized');
		client.respond(0, { result: { decision: 'decline' } });
		expect(lines).toEqual([
			{ jsonrpc: '2.0', method: 'initialized' },
			{ jsonrpc: '2.0', id: 0, result: { decision: 'decline' } },
		]);
	});
});
