import { describe, expect, test } from 'bun:test';
import { type BridgeCore, type BridgeHandlers, createBridgeCore } from '../bridge-core';

function fakeHandlers(): { handlers: BridgeHandlers; calls: Record<string, number> } {
	const calls: Record<string, number> = {};
	const bump = (key: string): void => {
		calls[key] = (calls[key] ?? 0) + 1;
	};
	const handlers: BridgeHandlers = {
		listSessions: async () => {
			bump('listSessions');
			return [{ id: 's1', title: 'T', status: 'idle', projectPath: '/r' }];
		},
		listPlaybooks: async () => {
			bump('listPlaybooks');
			return [{ id: 'p1', name: 'P' }];
		},
		observeCues: async () => {
			bump('observeCues');
			return [{ name: 'c1' }];
		},
		toast: async () => {
			bump('toast');
		},
		registerSession: async () => {
			bump('registerSession');
		},
		recordEvent: async () => {
			bump('recordEvent');
		},
		endSession: async () => {
			bump('endSession');
		},
	};
	return { handlers, calls };
}

function issueToken(core: BridgeCore, runId = 'run-1'): string {
	const res = core.issue({ secret: 'sek', runId, cwd: '/r' });
	expect(res.status).toBe(200);
	const body = res.body;
	if (body && typeof body === 'object' && 'token' in body && typeof body.token === 'string') {
		return body.token;
	}
	throw new Error('issue did not return a token');
}

const auth = (token: string): string => `Bearer ${token}`;

describe('bridge-core issue', () => {
	test('mints on the right secret, rejects a bad/invalid secret', () => {
		const { handlers } = fakeHandlers();
		const core = createBridgeCore({ secret: 'sek', handlers });
		expect(core.issue({ secret: 'sek', runId: 'r', cwd: '/r' }).status).toBe(200);
		expect(core.issue({ secret: 'WRONG', runId: 'r', cwd: '/r' }).status).toBe(401);
		expect(core.issue({ nope: true }).status).toBe(401);
	});

	test('token expires per TTL (injected clock)', async () => {
		let nowMs = 1000;
		const { handlers } = fakeHandlers();
		const core = createBridgeCore({ secret: 'sek', handlers, now: () => nowMs, tokenTtlMs: 100 });
		const token = issueToken(core);
		nowMs = 1050;
		expect((await core.handle(auth(token), { verb: 'sessions.list' })).status).toBe(200);
		nowMs = 2000;
		expect((await core.handle(auth(token), { verb: 'sessions.list' })).status).toBe(401);
	});
});

describe('bridge-core handle', () => {
	test('rejects missing/invalid token', async () => {
		const { handlers } = fakeHandlers();
		const core = createBridgeCore({ secret: 'sek', handlers });
		expect((await core.handle(undefined, { verb: 'sessions.list' })).status).toBe(401);
		expect((await core.handle('Bearer nope', { verb: 'sessions.list' })).status).toBe(401);
	});

	test('dispatches live read verbs to handlers', async () => {
		const { handlers, calls } = fakeHandlers();
		const core = createBridgeCore({ secret: 'sek', handlers });
		const token = issueToken(core);
		expect((await core.handle(auth(token), { verb: 'sessions.list' })).status).toBe(200);
		expect((await core.handle(auth(token), { verb: 'playbook.list' })).status).toBe(200);
		expect((await core.handle(auth(token), { verb: 'cue.observe' })).status).toBe(200);
		expect(calls.listSessions).toBe(1);
		expect(calls.listPlaybooks).toBe(1);
		expect(calls.observeCues).toBe(1);
	});

	test('refuses dispatch-equivalent verbs (403) before any handler runs', async () => {
		const { handlers, calls } = fakeHandlers();
		const core = createBridgeCore({ secret: 'sek', handlers });
		const token = issueToken(core);
		const res = await core.handle(auth(token), { verb: 'agent.dispatch', params: {} });
		expect(res.status).toBe(403);
		expect(Object.keys(calls).length).toBe(0);
	});

	test('unknown verb is 400', async () => {
		const { handlers } = fakeHandlers();
		const core = createBridgeCore({ secret: 'sek', handlers });
		const token = issueToken(core);
		expect((await core.handle(auth(token), { verb: 'bogus.verb' })).status).toBe(400);
	});

	test('a token cannot touch another run (runId binding)', async () => {
		const { handlers, calls } = fakeHandlers();
		const core = createBridgeCore({ secret: 'sek', handlers });
		const token = issueToken(core, 'run-A');
		const reg = (runId: string) =>
			core.handle(auth(token), {
				verb: 'session.register',
				params: { runId, ompSessionId: 'o', cwd: '/r', engine: 'omp', startedAt: 1 },
			});
		expect((await reg('run-A')).status).toBe(200);
		expect((await reg('run-B')).status).toBe(403);
		expect(calls.registerSession).toBe(1);
	});

	test('session.end revokes the run token', async () => {
		const { handlers } = fakeHandlers();
		const core = createBridgeCore({ secret: 'sek', handlers });
		const token = issueToken(core, 'run-1');
		expect(core.activeTokenCount()).toBe(1);
		const end = await core.handle(auth(token), {
			verb: 'session.end',
			params: { runId: 'run-1', ompSessionId: 'o', at: 1, status: 'completed' },
		});
		expect(end.status).toBe(200);
		expect(core.activeTokenCount()).toBe(0);
		expect((await core.handle(auth(token), { verb: 'sessions.list' })).status).toBe(401);
	});

	test('rate limit returns 429 past the window cap', async () => {
		const { handlers } = fakeHandlers();
		const core = createBridgeCore({
			secret: 'sek',
			handlers,
			rate: { windowMs: 10_000, maxPerWindow: 3, maxConcurrent: 8 },
		});
		const token = issueToken(core);
		for (let i = 0; i < 3; i++) {
			expect((await core.handle(auth(token), { verb: 'sessions.list' })).status).toBe(200);
		}
		expect((await core.handle(auth(token), { verb: 'sessions.list' })).status).toBe(429);
	});

	test('a throwing handler maps to 500', async () => {
		const { handlers } = fakeHandlers();
		handlers.listSessions = async () => {
			throw new Error('boom');
		};
		const core = createBridgeCore({ secret: 'sek', handlers });
		const token = issueToken(core);
		expect((await core.handle(auth(token), { verb: 'sessions.list' })).status).toBe(500);
	});

	test('revokeRun drops the run token', async () => {
		const { handlers } = fakeHandlers();
		const core = createBridgeCore({ secret: 'sek', handlers });
		const token = issueToken(core, 'run-x');
		core.revokeRun('run-x');
		expect((await core.handle(auth(token), { verb: 'sessions.list' })).status).toBe(401);
	});
});
