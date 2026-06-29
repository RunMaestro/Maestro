import { describe, expect, test } from 'bun:test';
import { createBridgeClient, type FetchLike } from '../bridge-client';
import { BRIDGE_ENV } from '../protocol';

describe('bridge client', () => {
	test('refuses dispatch verbs without contacting the server', async () => {
		let called = false;
		const fetchImpl: FetchLike = async () => {
			called = true;
			return { json: async () => ({}) };
		};
		const client = createBridgeClient(
			{ [BRIDGE_ENV.url]: 'http://x', [BRIDGE_ENV.token]: 't' },
			fetchImpl
		);
		const res = await client.call('agent.dispatch', {});
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error.code).toBe('phase4_required');
		expect(called).toBe(false);
	});

	test('reports app unavailable when env is missing', async () => {
		const client = createBridgeClient({});
		expect(client.enabled).toBe(false);
		const res = await client.call('sessions.list');
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error.code).toBe('app_unavailable');
	});

	test('posts to the scoped endpoint with the bearer token and parses ok', async () => {
		let captured: { input: string; headers: Record<string, string>; body: string } | undefined;
		const fetchImpl: FetchLike = async (input, init) => {
			captured = { input, headers: init.headers, body: init.body };
			return { json: async () => ({ ok: true, result: [{ id: 's1' }] }) };
		};
		const client = createBridgeClient(
			{ [BRIDGE_ENV.url]: 'http://host', [BRIDGE_ENV.token]: 'tok' },
			fetchImpl
		);
		const res = await client.call('sessions.list', { a: 1 });
		expect(res.ok).toBe(true);
		expect(captured).toBeDefined();
		if (captured) {
			expect(captured.input).toBe('http://host/v1/bridge');
			expect(captured.headers.authorization).toBe('Bearer tok');
			expect(JSON.parse(captured.body)).toEqual({ verb: 'sessions.list', params: { a: 1 } });
		}
	});

	test('maps a thrown fetch to app_unavailable', async () => {
		const fetchImpl: FetchLike = async () => {
			throw new Error('boom');
		};
		const client = createBridgeClient(
			{ [BRIDGE_ENV.url]: 'http://host', [BRIDGE_ENV.token]: 'tok' },
			fetchImpl
		);
		const res = await client.call('sessions.list');
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error.code).toBe('app_unavailable');
	});
});
