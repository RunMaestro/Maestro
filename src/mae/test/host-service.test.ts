import { describe, expect, test } from 'bun:test';
import type { SessionRegisterParams } from '../protocol';
import { type MaeHostDeps, createMaeHandlers } from '../host-service';

function fakeDeps(): {
	deps: MaeHostDeps;
	rec: { toasts: string[]; registered: string[]; events: number; ended: number };
} {
	const rec = { toasts: [] as string[], registered: [] as string[], events: 0, ended: 0 };
	const deps: MaeHostDeps = {
		getStoredSessions: async () => [
			{ id: 's1', name: 'Build', toolType: 'pi', ompSessionId: '/s/a.jsonl', state: 'busy' },
		],
		getPlaybookFiles: async () => [{ playbooks: [{ id: 'p1', name: 'Ship' }] }],
		getCueGraph: () => [{ subscriptions: [{ name: 'nightly' }] }],
		getCueActivity: () => [{ subscriptionName: 'nightly', finishedAt: 99 }],
		showToast: (title) => {
			rec.toasts.push(title);
		},
		onSessionRegister: (p) => {
			rec.registered.push(p.ompSessionId);
		},
		onSessionEvent: () => {
			rec.events += 1;
		},
		onSessionEnd: () => {
			rec.ended += 1;
		},
	};
	return { deps, rec };
}

describe('createMaeHandlers', () => {
	test('maps read verbs through the mappers', async () => {
		const { deps } = fakeDeps();
		const handlers = createMaeHandlers(deps);
		const sessions = await handlers.listSessions();
		expect(sessions[0]).toEqual({
			id: 's1',
			title: 'Build',
			status: 'busy',
			projectPath: '',
			engine: 'omp',
			ompSessionId: '/s/a.jsonl',
		});
		expect((await handlers.listPlaybooks())[0]).toEqual({ id: 'p1', name: 'Ship' });
		expect(await handlers.observeCues()).toEqual([{ name: 'nightly', lastFiredAt: 99 }]);
	});

	test('routes effects + ingest to the injected callbacks', async () => {
		const { deps, rec } = fakeDeps();
		const handlers = createMaeHandlers(deps);
		await handlers.toast({ title: 'Done', message: 'green' });
		const reg: SessionRegisterParams = {
			runId: 'r',
			ompSessionId: '/s/a.jsonl',
			cwd: '/r',
			engine: 'omp',
			startedAt: 1,
		};
		await handlers.registerSession(reg);
		await handlers.recordEvent({
			runId: 'r',
			ompSessionId: '/s/a.jsonl',
			kind: 'turn_start',
			at: 2,
		});
		await handlers.endSession({
			runId: 'r',
			ompSessionId: '/s/a.jsonl',
			at: 3,
			status: 'completed',
		});
		expect(rec.toasts).toEqual(['Done']);
		expect(rec.registered).toEqual(['/s/a.jsonl']);
		expect(rec.events).toBe(1);
		expect(rec.ended).toBe(1);
	});
});
