/**
 * Bridge dispatch tests for the browser tools: read methods, param validation,
 * and the per-agent interaction permission gate (a hand-configured MCP client
 * must not be able to bypass the UI toggle).
 *
 * Like coworking-bridge.test.ts we drive `dispatch` directly via the test-only
 * export. coworking-tools is mocked, but coworking-registry is real so the
 * interaction-permission gate exercises the actual registry state.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('electron', () => ({
	app: { getPath: () => '/tmp/coworking-test-userdata' },
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../main/coworking/coworking-tools', () => ({
	listTerminals: vi.fn(),
	readTerminal: vi.fn(),
	listBrowsers: vi.fn(() => ({
		browsers: [
			{
				id: 'browser:1',
				url: 'https://e',
				title: 'E',
				canGoBack: false,
				canGoForward: false,
				isLoading: false,
			},
		],
	})),
	getBrowserUrl: vi.fn((_sessionId: string, args: { id: string }) => ({
		id: args.id,
		url: 'https://e',
		title: 'E',
	})),
	readBrowser: vi.fn(
		async (_sessionId: string, args: { id: string; format?: string; maxChars?: number }) => ({
			id: args.id,
			url: 'https://e',
			title: 'E',
			format: args.format ?? 'text',
			content: 'PAGE',
			truncated: false,
			totalChars: 4,
		})
	),
	browserInteract: vi.fn(async (_sessionId: string, args: { op: { kind: string } }) => ({
		ok: true,
		content: 'did ' + args.op.kind,
	})),
}));

import { __testing } from '../../../main/coworking/coworking-bridge';
import * as tools from '../../../main/coworking/coworking-tools';
import { coworkingRegistry } from '../../../main/coworking/coworking-registry';
import type { Socket } from 'net';
import {
	setBrowserAuditSink,
	type BrowserAuditEntry,
} from '../../../main/coworking/coworking-audit';

function newConn(): Socket {
	return {} as unknown as Socket;
}

async function helloAs(conn: Socket, sessionId: string): Promise<void> {
	await __testing.dispatch(conn, { id: 1, method: 'hello', params: { sessionId } });
}

describe('coworking-bridge browser dispatch', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__testing.setResolveSessionFromPid(null);
		coworkingRegistry.reset();
	});

	it('listBrowsers after hello dispatches with the bound sessionId', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await helloAs(conn, 'sess-A');
		const resp = await __testing.dispatch(conn, { id: 2, method: 'listBrowsers' });
		expect(resp.error).toBeUndefined();
		expect(tools.listBrowsers).toHaveBeenCalledWith('sess-A');
	});

	it('listBrowsers is rejected before hello', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		const resp = await __testing.dispatch(conn, { id: 1, method: 'listBrowsers' });
		expect(resp.error?.code).toBe(-32002);
		expect(tools.listBrowsers).not.toHaveBeenCalled();
	});

	it('getBrowserUrl requires an id', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await helloAs(conn, 'sess-A');
		const resp = await __testing.dispatch(conn, { id: 2, method: 'getBrowserUrl', params: {} });
		expect(resp.error?.code).toBe(-32602);
	});

	it('readBrowser rejects an invalid format and a non-positive maxChars', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await helloAs(conn, 'sess-A');
		const badFormat = await __testing.dispatch(conn, {
			id: 2,
			method: 'readBrowser',
			params: { id: 'browser:1', format: 'pdf' },
		});
		expect(badFormat.error?.code).toBe(-32602);
		const badMax = await __testing.dispatch(conn, {
			id: 3,
			method: 'readBrowser',
			params: { id: 'browser:1', maxChars: 0 },
		});
		expect(badMax.error?.code).toBe(-32602);
	});

	it('readBrowser dispatches with valid params', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await helloAs(conn, 'sess-A');
		const resp = await __testing.dispatch(conn, {
			id: 2,
			method: 'readBrowser',
			params: { id: 'browser:1', format: 'html', maxChars: 100 },
		});
		expect(resp.error).toBeUndefined();
		expect(tools.readBrowser).toHaveBeenCalledWith('sess-A', {
			id: 'browser:1',
			format: 'html',
			maxChars: 100,
		});
	});

	it('browserInteract is rejected when interaction is not enabled for the session', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await helloAs(conn, 'sess-A');
		const resp = await __testing.dispatch(conn, {
			id: 2,
			method: 'browserInteract',
			params: { id: 'browser:1', op: { kind: 'reload' } },
		});
		expect(resp.error?.code).toBe(-32002);
		expect(tools.browserInteract).not.toHaveBeenCalled();
	});

	it('browserInteract dispatches when interaction is enabled for the session', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await helloAs(conn, 'sess-A');
		coworkingRegistry.syncSessionBrowsers('sess-A', [], true);
		const resp = await __testing.dispatch(conn, {
			id: 2,
			method: 'browserInteract',
			params: { id: 'browser:1', op: { kind: 'reload' } },
		});
		expect(resp.error).toBeUndefined();
		expect(tools.browserInteract).toHaveBeenCalledWith('sess-A', {
			id: 'browser:1',
			op: { kind: 'reload' },
		});
	});

	it('browserInteract rejects the read op (reads must use read_browser)', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await helloAs(conn, 'sess-A');
		coworkingRegistry.syncSessionBrowsers('sess-A', [], true);
		const resp = await __testing.dispatch(conn, {
			id: 2,
			method: 'browserInteract',
			params: { id: 'browser:1', op: { kind: 'read', format: 'text' } },
		});
		expect(resp.error?.code).toBe(-32602);
		expect(tools.browserInteract).not.toHaveBeenCalled();
	});

	it('browserInteract accepts navigate with a url and rejects it without one', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await helloAs(conn, 'sess-A');
		coworkingRegistry.syncSessionBrowsers('sess-A', [], true);
		const ok = await __testing.dispatch(conn, {
			id: 2,
			method: 'browserInteract',
			params: { id: 'browser:1', op: { kind: 'navigate', url: 'https://x.com' } },
		});
		expect(ok.error).toBeUndefined();
		expect(tools.browserInteract).toHaveBeenCalledWith('sess-A', {
			id: 'browser:1',
			op: { kind: 'navigate', url: 'https://x.com' },
		});
		const bad = await __testing.dispatch(conn, {
			id: 3,
			method: 'browserInteract',
			params: { id: 'browser:1', op: { kind: 'navigate' } },
		});
		expect(bad.error?.code).toBe(-32602);
	});
});

describe('coworking-bridge browser audit', () => {
	let entries: BrowserAuditEntry[];

	beforeEach(() => {
		vi.clearAllMocks();
		__testing.setResolveSessionFromPid(null);
		coworkingRegistry.reset();
		entries = [];
		setBrowserAuditSink((e) => entries.push(e));
	});

	afterEach(() => {
		setBrowserAuditSink(null);
	});

	it('records an ok entry with agentType for a read tool', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await helloAs(conn, 'sess-A');
		coworkingRegistry.syncSessionBrowsers('sess-A', [], false, 'claude-code');
		await __testing.dispatch(conn, { id: 2, method: 'listBrowsers' });
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			sessionId: 'sess-A',
			agentType: 'claude-code',
			tool: 'list_browsers',
			status: 'ok',
		});
		expect(typeof entries[0].ts).toBe('number');
	});

	it('records a denied entry when interaction is not enabled', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await helloAs(conn, 'sess-A');
		const resp = await __testing.dispatch(conn, {
			id: 2,
			method: 'browserInteract',
			params: { id: 'browser:1', op: { kind: 'reload' } },
		});
		expect(resp.error?.code).toBe(-32002);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ tool: 'browser_interact', status: 'denied' });
	});

	it('records ok with opKind + redacted detail for an allowed interaction op', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await helloAs(conn, 'sess-A');
		coworkingRegistry.syncSessionBrowsers('sess-A', [], true, 'codex');
		await __testing.dispatch(conn, {
			id: 2,
			method: 'browserInteract',
			params: { id: 'browser:1', op: { kind: 'navigate', url: 'https://x.com' } },
		});
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			tool: 'browser_interact',
			opKind: 'navigate',
			status: 'ok',
			agentType: 'codex',
		});
		expect(entries[0].detail).toContain('https://x.com');
	});

	it('records an error entry when the tool throws', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await helloAs(conn, 'sess-A');
		vi.mocked(tools.readBrowser).mockRejectedValueOnce(new Error('boom'));
		await __testing.dispatch(conn, { id: 2, method: 'readBrowser', params: { id: 'browser:1' } });
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ tool: 'read_browser', status: 'error' });
	});
});
