/**
 * Bridge handshake / session-binding tests. Exercises the per-connection sessionId
 * binding that fixes PR #948's privacy blocker (focus-bound scope leak).
 *
 * We don't actually open a Unix socket here - we drive `dispatch` directly via
 * the test-only export and use a plain object as the connection key (the bridge's
 * connection state is keyed via WeakMap, which accepts any object).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
	app: {
		getPath: () => '/tmp/coworking-test-userdata',
	},
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../main/coworking/coworking-tools', () => {
	return {
		listTerminals: vi.fn((sessionId: string) => ({
			terminals: [{ id: 'term:1', cwd: '/x', title: `for ${sessionId}` }],
		})),
		readTerminal: vi.fn(async (sessionId: string, args: { id: string }) => ({
			id: args.id,
			content: `body for ${sessionId}/${args.id}`,
			truncated: false,
			totalLines: 1,
		})),
	};
});

import { __testing } from '../../../main/coworking/coworking-bridge';
import * as tools from '../../../main/coworking/coworking-tools';
import type { Socket } from 'net';

function newConn(): Socket {
	// WeakMap keys must be objects; a plain `{}` is sufficient for dispatch().
	return {} as unknown as Socket;
}

describe('coworking-bridge dispatch (handshake + session binding)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__testing.setResolveSessionFromPid(null);
	});

	it('rejects listTerminals before hello', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });

		const resp = await __testing.dispatch(conn, { id: 1, method: 'listTerminals' });
		expect(resp.error).toBeDefined();
		expect(resp.error?.code).toBe(-32002);
		expect(tools.listTerminals).not.toHaveBeenCalled();
	});

	it('rejects readTerminal before hello', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });

		const resp = await __testing.dispatch(conn, {
			id: 1,
			method: 'readTerminal',
			params: { id: 'term:1' },
		});
		expect(resp.error).toBeDefined();
		expect(resp.error?.code).toBe(-32002);
		expect(tools.readTerminal).not.toHaveBeenCalled();
	});

	it('hello with sessionId binds the connection', async () => {
		const conn = newConn();
		const state = { sessionId: null as string | null };
		__testing.connections.set(conn, state);

		const helloResp = await __testing.dispatch(conn, {
			id: 1,
			method: 'hello',
			params: { sessionId: 'sess-A' },
		});
		expect(helloResp.error).toBeUndefined();
		expect(helloResp.result).toEqual({ ok: true });
		expect(state.sessionId).toBe('sess-A');
	});

	it('hello rejects when neither sessionId nor ppid is provided', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });

		const r1 = await __testing.dispatch(conn, { id: 1, method: 'hello' });
		expect(r1.error?.code).toBe(-32602);

		const r2 = await __testing.dispatch(conn, {
			id: 2,
			method: 'hello',
			params: { sessionId: '' },
		});
		expect(r2.error?.code).toBe(-32602);

		const r3 = await __testing.dispatch(conn, {
			id: 3,
			method: 'hello',
			params: { ppid: 0 },
		});
		expect(r3.error?.code).toBe(-32602);
	});

	it('hello with ppid resolves session via the registered resolver', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		const resolver = vi.fn(async (pid: number) => (pid === 4242 ? 'sess-via-pid' : null));
		__testing.setResolveSessionFromPid(resolver);

		const resp = await __testing.dispatch(conn, {
			id: 1,
			method: 'hello',
			params: { ppid: 4242 },
		});
		expect(resp.error).toBeUndefined();
		expect(resp.result).toEqual({ ok: true });
		expect(resolver).toHaveBeenCalledWith(4242);
		expect(__testing.connections.get(conn)?.sessionId).toBe('sess-via-pid');
	});

	it('hello with ppid rejects when resolver returns null', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		__testing.setResolveSessionFromPid(async () => null);

		const resp = await __testing.dispatch(conn, {
			id: 1,
			method: 'hello',
			params: { ppid: 99999 },
		});
		expect(resp.error?.code).toBe(-32602);
		expect(resp.error?.message).toMatch(/peer PID/i);
		expect(__testing.connections.get(conn)?.sessionId).toBeNull();
	});

	it('hello with ppid but no resolver wired rejects', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		__testing.setResolveSessionFromPid(null);

		const resp = await __testing.dispatch(conn, {
			id: 1,
			method: 'hello',
			params: { ppid: 100 },
		});
		expect(resp.error?.code).toBe(-32602);
		expect(resp.error?.message).toMatch(/resolver not configured/i);
	});

	it('hello with sessionId + a ppid that resolves to the SAME session binds it', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		const resolver = vi.fn(async () => 'sess-explicit');
		__testing.setResolveSessionFromPid(resolver);

		const resp = await __testing.dispatch(conn, {
			id: 1,
			method: 'hello',
			params: { sessionId: 'sess-explicit', ppid: 4242 },
		});
		expect(resp.error).toBeUndefined();
		expect(__testing.connections.get(conn)?.sessionId).toBe('sess-explicit');
		expect(resolver).toHaveBeenCalledWith(4242);
	});

	it('hello with sessionId + a ppid the resolver cannot map (null) still trusts sessionId', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		const resolver = vi.fn(async () => null);
		__testing.setResolveSessionFromPid(resolver);

		const resp = await __testing.dispatch(conn, {
			id: 1,
			method: 'hello',
			params: { sessionId: 'sess-explicit', ppid: 4242 },
		});
		// A null (can't-determine) result is NOT a mismatch: env-propagating
		// agents whose PIDs aren't tracked must not regress.
		expect(resp.error).toBeUndefined();
		expect(__testing.connections.get(conn)?.sessionId).toBe('sess-explicit');
		expect(resolver).toHaveBeenCalledWith(4242);
	});

	it('hello rejects when the ppid resolves to a DIFFERENT session than the claimed sessionId', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		const resolver = vi.fn(async () => 'sess-from-pid');
		__testing.setResolveSessionFromPid(resolver);

		const resp = await __testing.dispatch(conn, {
			id: 1,
			method: 'hello',
			params: { sessionId: 'sess-explicit', ppid: 4242 },
		});
		expect(resp.error?.code).toBe(-32602);
		expect(resp.error?.message).toMatch(/does not match caller process/i);
		expect(__testing.connections.get(conn)?.sessionId).toBeNull();
	});

	it('hello with sessionId and NO resolver wired trusts sessionId (env-only agents)', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		__testing.setResolveSessionFromPid(null);

		const resp = await __testing.dispatch(conn, {
			id: 1,
			method: 'hello',
			params: { sessionId: 'sess-explicit', ppid: 4242 },
		});
		expect(resp.error).toBeUndefined();
		expect(__testing.connections.get(conn)?.sessionId).toBe('sess-explicit');
	});

	it('after hello, listTerminals is dispatched with the bound sessionId', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });

		await __testing.dispatch(conn, {
			id: 1,
			method: 'hello',
			params: { sessionId: 'sess-A' },
		});
		const resp = await __testing.dispatch(conn, { id: 2, method: 'listTerminals' });
		expect(resp.error).toBeUndefined();
		expect(tools.listTerminals).toHaveBeenCalledWith('sess-A');
	});

	it('after hello, readTerminal is dispatched with the bound sessionId', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });

		await __testing.dispatch(conn, {
			id: 1,
			method: 'hello',
			params: { sessionId: 'sess-B' },
		});
		const resp = await __testing.dispatch(conn, {
			id: 2,
			method: 'readTerminal',
			params: { id: 'term:7' },
		});
		expect(resp.error).toBeUndefined();
		expect(tools.readTerminal).toHaveBeenCalledWith('sess-B', { id: 'term:7', lines: undefined });
	});

	it('two connections with different sessionIds do not bleed (privacy regression)', async () => {
		const connA = newConn();
		const connB = newConn();
		__testing.connections.set(connA, { sessionId: null });
		__testing.connections.set(connB, { sessionId: null });

		await __testing.dispatch(connA, {
			id: 1,
			method: 'hello',
			params: { sessionId: 'sess-A' },
		});
		await __testing.dispatch(connB, {
			id: 1,
			method: 'hello',
			params: { sessionId: 'sess-B' },
		});

		await __testing.dispatch(connA, { id: 2, method: 'listTerminals' });
		await __testing.dispatch(connB, { id: 2, method: 'listTerminals' });

		expect(tools.listTerminals).toHaveBeenNthCalledWith(1, 'sess-A');
		expect(tools.listTerminals).toHaveBeenNthCalledWith(2, 'sess-B');
	});

	it('readTerminal with missing id returns invalid-params error', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await __testing.dispatch(conn, {
			id: 1,
			method: 'hello',
			params: { sessionId: 'sess-A' },
		});

		const resp = await __testing.dispatch(conn, { id: 2, method: 'readTerminal', params: {} });
		expect(resp.error?.code).toBe(-32602);
	});

	it('unknown method returns -32601 even after hello', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await __testing.dispatch(conn, {
			id: 1,
			method: 'hello',
			params: { sessionId: 'sess-A' },
		});

		const resp = await __testing.dispatch(conn, {
			id: 2,
			method: 'wat' as 'hello',
		});
		expect(resp.error?.code).toBe(-32601);
	});
});
