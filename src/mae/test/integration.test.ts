// End-to-end: drive the maestro-bridge extension against the reference ingest
// server over real HTTP, exercising the scoped-token handshake, session
// tracking, read tools, and dispatch-equivalent refusal.

import { afterEach, describe, expect, test } from 'bun:test';
import maestroBridge from '../extension/maestro-bridge.extension';
import { BRIDGE_ENV } from '../protocol';
import { startReferenceServer } from '../reference-server';
import { fireEvent, getTool, makeCtx, makeMockPi, tokenOf } from './mock-pi';

function clearBridgeEnv(): void {
	delete process.env[BRIDGE_ENV.url];
	delete process.env[BRIDGE_ENV.token];
	delete process.env[BRIDGE_ENV.runId];
	delete process.env[BRIDGE_ENV.mapPath];
	delete process.env[BRIDGE_ENV.maestroSessionId];
}

afterEach(clearBridgeEnv);

async function issue(url: string, secret: string, runId: string): Promise<string> {
	const res = await fetch(`${url}/v1/sessions/issue`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ secret, runId, cwd: '/repo' }),
	});
	return tokenOf(await res.json());
}

describe('session tracking end-to-end', () => {
	test('a TUI run registers, streams lifecycle, and ends; read tools work', async () => {
		const server = await startReferenceServer({
			seedSessions: [{ id: 's1', title: 'Build mae', status: 'running', projectPath: '/repo' }],
			seedPlaybooks: [{ id: 'p1', name: 'Ship' }],
		});
		try {
			const token = await issue(server.url, server.secret, 'run-1');
			expect(token).not.toBe('');
			process.env[BRIDGE_ENV.url] = server.url;
			process.env[BRIDGE_ENV.token] = token;
			process.env[BRIDGE_ENV.runId] = 'run-1';

			const mock = makeMockPi();
			maestroBridge(mock.pi);
			const ctx = makeCtx({ cwd: '/repo', sessionFile: '/sessions/run-1.jsonl' });

			await fireEvent(mock, 'session_start', {}, ctx);
			await fireEvent(mock, 'turn_start', {}, ctx);
			await fireEvent(mock, 'message_end', { role: 'assistant', usage: { totalTokens: 42 } }, ctx);
			await fireEvent(mock, 'tool_execution_end', { toolName: 'read', status: 'ok' }, ctx);
			await fireEvent(mock, 'turn_end', {}, ctx);

			// Tools are called DURING the live session (token still valid).
			const sessionsOut = await getTool(mock, 'maestro_sessions').execute(
				'c',
				{},
				undefined,
				undefined,
				ctx
			);
			expect(sessionsOut.content[0].text).toContain('Build mae');

			const notifyOut = await getTool(mock, 'maestro_notify').execute(
				'c',
				{ title: 'Done', message: 'build green' },
				undefined,
				undefined,
				ctx
			);
			expect(notifyOut.content[0].text).toContain('Notification sent');
			expect(server.store.notifications.length).toBe(1);

			const eventsBefore = server.store.events.length;
			const dispatchOut = await getTool(mock, 'maestro_dispatch').execute(
				'c',
				{},
				undefined,
				undefined,
				ctx
			);
			expect(dispatchOut.content[0].text).toContain('Phase 4');
			expect(server.store.events.length).toBe(eventsBefore);

			// Session ends -> the run token is revoked.
			await fireEvent(mock, 'session_shutdown', {}, ctx);

			const registered = server.store.sessions.get('/sessions/run-1.jsonl');
			expect(registered).toBeDefined();
			expect(registered?.maestroSessionId).toBeDefined();

			const kinds = server.store.events.map((event) => event.kind);
			expect(kinds).toContain('turn_start');
			expect(kinds).toContain('message');
			expect(kinds).toContain('tool');
			expect(kinds).toContain('turn_end');
			expect(server.store.ended.has('/sessions/run-1.jsonl')).toBe(true);

			// After end, the revoked token is rejected by the bridge.
			const afterEnd = await getTool(mock, 'maestro_sessions').execute(
				'c',
				{},
				undefined,
				undefined,
				ctx
			);
			expect(afterEnd.content[0].text.toLowerCase()).toContain('maestro bridge');
		} finally {
			await server.close();
		}
	});
});

describe('server-side guards', () => {
	test('dispatch-equivalent verbs are refused server-side (403)', async () => {
		const server = await startReferenceServer();
		try {
			const token = await issue(server.url, server.secret, 'r');
			const res = await fetch(`${server.url}/v1/bridge`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
				body: JSON.stringify({ verb: 'agent.dispatch', params: {} }),
			});
			expect(res.status).toBe(403);
			const body: unknown = await res.json();
			expect(body && typeof body === 'object' && 'ok' in body ? body.ok : undefined).toBe(false);
		} finally {
			await server.close();
		}
	});

	test('an invalid token is unauthorized (401)', async () => {
		const server = await startReferenceServer();
		try {
			const res = await fetch(`${server.url}/v1/bridge`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
				body: JSON.stringify({ verb: 'sessions.list' }),
			});
			expect(res.status).toBe(401);
		} finally {
			await server.close();
		}
	});

	test('a bad bootstrap secret is rejected at issue (401)', async () => {
		const server = await startReferenceServer();
		try {
			const res = await fetch(`${server.url}/v1/sessions/issue`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ secret: 'wrong', runId: 'r', cwd: '/repo' }),
			});
			expect(res.status).toBe(401);
		} finally {
			await server.close();
		}
	});
});
