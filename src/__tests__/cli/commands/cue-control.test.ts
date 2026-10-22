/**
 * @file cue-control.test.ts
 * @description Tests for `cue enable|disable|gate|screen|activity`: name
 * resolution (refusing an ambiguous name), the toggle, gate and screen
 * messages, error-frame handling, and activity's offline database read.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));
vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn((id: string) => id),
	readActiveAgentId: vi.fn(),
	readSessions: vi.fn(() => [{ id: 'a1', name: 'One' }]),
}));
vi.mock('../../../main/cue/cue-db', () => ({
	readRecentCueEventsReadOnly: vi.fn(),
	initCueDb: vi.fn(),
}));
// The real lock would read the developer's own data directory.
vi.mock('../../../main/cue/cue-engine-lock', () => ({
	readCueEngineLock: vi.fn(() => null),
}));

import {
	cueActivity,
	cueDisable,
	cueEnable,
	cueGate,
	cueScreen,
	resolveSubscription,
} from '../../../cli/commands/cue-control';
import { CommandTimeoutError, withMaestroClient } from '../../../cli/services/maestro-client';
import { MaestroNotRunningError } from '../../../cli/services/maestro-not-running';
import { SqliteUnavailableError } from '../../../cli/utils/native-sqlite';
import { initCueDb, readRecentCueEventsReadOnly } from '../../../main/cue/cue-db';
import type { CueEventRecord } from '../../../main/cue/cue-db';
import { readCueEngineLock } from '../../../main/cue/cue-engine-lock';
import { resolveCliPath } from '../../../cli/utils/parse';

const subs = [
	{
		id: 'a1::p::nightly',
		name: 'nightly',
		eventType: 'time.scheduled',
		sessionId: 'a1',
		sessionName: 'One',
		enabled: true,
	},
	{
		id: 'a2::p::nightly',
		name: 'nightly',
		eventType: 'time.scheduled',
		sessionId: 'a2',
		sessionName: 'Two',
		enabled: true,
	},
	{
		id: 'a1::p::on-pr',
		name: 'on-pr',
		eventType: 'github.pull_request',
		sessionId: 'a1',
		sessionName: 'One',
		enabled: false,
	},
];

function mockBridge(responses: Record<string, unknown>) {
	const sent: Record<string, unknown>[] = [];
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
				sent.push(payload);
				return Promise.resolve(responses[payload.type as string]);
			}),
		} as never)
	);
	return sent;
}

describe('resolveSubscription', () => {
	it('matches a full id, a unique name, or a name narrowed by agent', () => {
		expect(resolveSubscription(subs, 'a2::p::nightly').sessionId).toBe('a2');
		expect(resolveSubscription(subs, 'on-pr').id).toBe('a1::p::on-pr');
		expect(resolveSubscription(subs, 'nightly', 'a2').id).toBe('a2::p::nightly');
	});

	it('refuses a name several agents share, and an unknown name', () => {
		expect(() => resolveSubscription(subs, 'nightly')).toThrow(/names 2 subscriptions/);
		expect(() => resolveSubscription(subs, 'nope')).toThrow(/No Cue subscription/);
	});
});

describe('cue enable/disable/activity', () => {
	let exitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('enable sends the resolved id with enabled:true', async () => {
		const sent = mockBridge({
			get_cue_subscriptions: { subscriptions: subs },
			toggle_cue_subscription: { type: 'toggle_cue_subscription_result', success: true },
		});
		await cueEnable('on-pr', {});
		expect(sent[1]).toEqual({
			type: 'toggle_cue_subscription',
			subscriptionId: 'a1::p::on-pr',
			enabled: true,
		});
	});

	it('disable exits non-zero when the engine reports failure', async () => {
		mockBridge({
			get_cue_subscriptions: { subscriptions: subs },
			toggle_cue_subscription: { type: 'toggle_cue_subscription_result', success: false },
		});
		await expect(cueDisable('on-pr', {})).rejects.toThrow('__exit__');
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it('activity passes agent and limit, and fails on an error frame', async () => {
		const sent = mockBridge({ get_cue_activity: { type: 'cue_activity', entries: [] } });
		await cueActivity({ agent: 'a1', limit: '5' });
		expect(sent[0]).toEqual({ type: 'get_cue_activity', sessionId: 'a1', limit: 5 });

		mockBridge({ get_cue_activity: { type: 'error', message: 'Cue activity not available' } });
		await expect(cueActivity({})).rejects.toThrow('__exit__');
	});

	it('activity prints why a gate skipped an event', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		mockBridge({
			get_cue_activity: {
				type: 'cue_activity',
				entries: [
					{
						id: 'r1',
						subscriptionId: 'a1::p::on-pr',
						subscriptionName: 'on-pr',
						eventType: 'github.issue',
						sessionId: 'a1',
						timestamp: Date.parse('2026-10-11T12:00:00Z'),
						status: 'gated',
						result: 'The comment is praise and asks for nothing.',
						duration: 40,
					},
					{
						id: 'r2',
						subscriptionId: 'a1::p::on-pr',
						subscriptionName: 'on-pr',
						eventType: 'github.issue',
						sessionId: 'a1',
						timestamp: Date.parse('2026-10-11T12:01:00Z'),
						status: 'completed',
						result: 'Opened a fix.',
						duration: 9000,
					},
				],
			},
		});

		await cueActivity({});

		const lines = logSpy.mock.calls.map((call) => String(call[0]));
		expect(lines[0]).toMatch(/gated\s+on-pr\s+\[github\.issue\]/);
		expect(lines[0]).toContain('- The comment is praise and asks for nothing.');
		// A run's output is not echoed on the one-line form.
		expect(lines[1]).toMatch(/completed\s+on-pr/);
		expect(lines[1]).not.toContain('Opened a fix.');
	});

	it('activity prints a blocked run with the reason the screen refused it', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		mockBridge({
			get_cue_activity: {
				type: 'cue_activity',
				entries: [
					{
						id: 'r1',
						subscriptionId: 'a1::p::on-pr',
						subscriptionName: 'on-pr',
						eventType: 'github.issue',
						sessionId: 'a1',
						timestamp: Date.parse('2026-10-11T12:00:00Z'),
						status: 'blocked',
						result: 'The new comments ({{CUE_NEW_COMMENTS}}) scored 0.97.',
						duration: 40,
					},
				],
			},
		});

		await cueActivity({});

		const line = String(logSpy.mock.calls[0][0]);
		expect(line).toMatch(/blocked\s+on-pr\s+\[github\.issue\]/);
		expect(line).toContain('- The new comments ({{CUE_NEW_COMMENTS}}) scored 0.97.');
	});

	it('activity rejects a bad --limit before connecting', async () => {
		const sent = mockBridge({});
		await expect(cueActivity({ limit: 'lots' })).rejects.toThrow('__exit__');
		expect(sent).toHaveLength(0);
	});

	describe('activity when the desktop app is not running', () => {
		const at = (seconds: number) => Date.parse('2026-05-11T07:00:00.000Z') + seconds * 1000;
		/** Rows as `getRecentCueEvents` returns them: newest first. */
		const records = [
			{ id: 'r4', sessionId: 'a2', status: 'completed', createdAt: at(4), completedAt: at(5) },
			{ id: 'r3', sessionId: 'a1', status: 'stopped', createdAt: at(3), completedAt: at(4) },
			{ id: 'r2', sessionId: 'a1', status: 'timeout', createdAt: at(2), completedAt: at(3) },
			{ id: 'r1', sessionId: 'a1', status: 'running', createdAt: at(1), completedAt: null },
		].map(
			(r) =>
				({
					...r,
					type: 'time.scheduled',
					triggerName: 't',
					subscriptionName: `sub-${r.id}`,
					payload: null,
				}) as CueEventRecord
		);

		function appNotRunning() {
			vi.mocked(withMaestroClient).mockRejectedValue(
				new MaestroNotRunningError('no-discovery-file')
			);
		}

		function printed(): string {
			return vi
				.mocked(console.log)
				.mock.calls.map((c) => String(c[0]))
				.join('\n');
		}

		it('reads cue.db read-only, newest first, filtered before the limit', async () => {
			appNotRunning();
			vi.mocked(readRecentCueEventsReadOnly).mockReturnValue({
				ok: true,
				records,
				source: 'snapshot',
			});

			await cueActivity({ agent: 'a1', limit: '2', json: true });

			expect(readRecentCueEventsReadOnly).toHaveBeenCalledWith(1000);
			expect(initCueDb).not.toHaveBeenCalled();
			const entries = JSON.parse(printed());
			expect(entries.map((e: { id: string }) => e.id)).toEqual(['r3', 'r2']);
			expect(entries[0]).toEqual({
				id: 'r3',
				subscriptionId: 'a1::sub-r3::sub-r3',
				subscriptionName: 'sub-r3',
				eventType: 'time.scheduled',
				sessionId: 'a1',
				timestamp: at(3),
				status: 'failed',
				duration: 1000,
			});
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('prints the same lines as the app, with a note on stderr', async () => {
			appNotRunning();
			vi.mocked(readRecentCueEventsReadOnly).mockReturnValue({
				ok: true,
				records,
				source: 'live',
			});

			await cueActivity({});

			const lines = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(lines).toHaveLength(4);
			expect(lines[0]).toContain('completed  sub-r4  [time.scheduled]  1.0s');
			// An orphaned running row is reported as failed, as the app does.
			expect(lines[3]).toContain('failed     sub-r1  [time.scheduled]  0.0s');
			expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Read from cue.db'));
		});

		describe('a row still marked running', () => {
			function liveEngine() {
				vi.mocked(readCueEngineLock).mockReturnValueOnce({
					pid: 4242,
					mode: 'standalone',
					startedAt: new Date(at(0)).toISOString(),
				});
			}

			it('stays running beside a live engine, with no duration in --json', async () => {
				appNotRunning();
				liveEngine();
				vi.mocked(readRecentCueEventsReadOnly).mockReturnValue({
					ok: true,
					records,
					source: 'live',
				});

				await cueActivity({ json: true });

				const r1 = JSON.parse(printed()).find((e: { id: string }) => e.id === 'r1');
				expect(r1).toEqual({
					id: 'r1',
					subscriptionId: 'a1::sub-r1::sub-r1',
					subscriptionName: 'sub-r1',
					eventType: 'time.scheduled',
					sessionId: 'a1',
					timestamp: at(1),
					status: 'running',
				});
			});

			it('prints how long it has run so far beside a live engine', async () => {
				appNotRunning();
				liveEngine();
				vi.mocked(readRecentCueEventsReadOnly).mockReturnValue({
					ok: true,
					records,
					source: 'live',
				});
				vi.spyOn(Date, 'now').mockReturnValue(at(13.5));

				await cueActivity({});

				const lines = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
				expect(lines[3]).toContain('running    sub-r1  [time.scheduled]  12.5s so far');
			});

			it('reads as failed with no live engine, even when the sidecars are there', async () => {
				appNotRunning();
				vi.mocked(readRecentCueEventsReadOnly).mockReturnValue({
					ok: true,
					records,
					source: 'live',
				});

				await cueActivity({ json: true });

				const r1 = JSON.parse(printed()).find((e: { id: string }) => e.id === 'r1');
				expect(r1).toMatchObject({ status: 'failed', duration: 0 });
			});

			it('reads the lock before the database', async () => {
				appNotRunning();
				vi.mocked(readRecentCueEventsReadOnly).mockReturnValue({
					ok: true,
					records,
					source: 'live',
				});

				await cueActivity({ json: true });

				const lockCall = vi.mocked(readCueEngineLock).mock.invocationCallOrder.at(-1)!;
				const dbCall = vi.mocked(readRecentCueEventsReadOnly).mock.invocationCallOrder.at(-1)!;
				expect(lockCall).toBeLessThan(dbCall);
			});
		});

		it('fails non-zero with the reason when cue.db cannot be read', async () => {
			appNotRunning();
			vi.mocked(readRecentCueEventsReadOnly).mockReturnValue({
				ok: false,
				reason: '/data/cue.db does not exist',
			});

			await expect(cueActivity({ json: true })).rejects.toThrow('__exit__');
			expect(exitSpy).toHaveBeenCalledWith(1);
			expect(JSON.parse(printed())).toEqual({
				success: false,
				error:
					'The desktop app is not running and Cue run history could not be read: /data/cue.db does not exist',
			});
		});

		it('fails non-zero with the loader message when SQLite is unavailable', async () => {
			appNotRunning();
			vi.mocked(readRecentCueEventsReadOnly).mockImplementation(() => {
				throw new SqliteUnavailableError('better-sqlite3 cannot load here', []);
			});

			await expect(cueActivity({})).rejects.toThrow('__exit__');
			expect(exitSpy).toHaveBeenCalledWith(1);
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining('better-sqlite3 cannot load here')
			);
		});

		it('does not fall back on any other bridge failure', async () => {
			vi.mocked(withMaestroClient).mockRejectedValue(new CommandTimeoutError('cue_activity'));

			await expect(cueActivity({})).rejects.toThrow('__exit__');
			expect(readRecentCueEventsReadOnly).not.toHaveBeenCalled();
		});

		it('points the read at --data-dir, as the cue engine verbs do', async () => {
			const saved = process.env.MAESTRO_USER_DATA;
			appNotRunning();
			vi.mocked(readRecentCueEventsReadOnly).mockImplementation(() => {
				// The reader resolves cue.db from MAESTRO_USER_DATA when given no path.
				// The flag is resolved like any CLI path, so Windows adds a drive letter.
				expect(process.env.MAESTRO_USER_DATA).toBe(resolveCliPath('/var/lib/maestro/data'));
				return { ok: true, records: [], source: 'snapshot' };
			});
			// The engine lock resolves from the same variable, so "is an engine
			// live?" is asked of the directory whose cue.db is read.
			vi.mocked(readCueEngineLock).mockImplementationOnce((dataDir?: string) => {
				expect(dataDir).toBeUndefined();
				expect(process.env.MAESTRO_USER_DATA).toBe(resolveCliPath('/var/lib/maestro/data'));
				return null;
			});
			try {
				await cueActivity({ dataDir: '/var/lib/maestro/data' });
				expect(readRecentCueEventsReadOnly).toHaveBeenCalledTimes(1);
				expect(readCueEngineLock).toHaveBeenCalledTimes(1);
			} finally {
				if (saved === undefined) delete process.env.MAESTRO_USER_DATA;
				else process.env.MAESTRO_USER_DATA = saved;
			}
		});

		it('does not read cue.db when the app answers', async () => {
			mockBridge({ get_cue_activity: { type: 'cue_activity', entries: [] } });

			await cueActivity({});

			expect(readRecentCueEventsReadOnly).not.toHaveBeenCalled();
			expect(printed()).toBe('No Cue activity.');
		});
	});
});

describe('cue gate', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;

	const gated = [
		...subs,
		{
			id: 'a1::p::triage',
			name: 'triage',
			eventType: 'github.issue',
			sessionId: 'a1',
			sessionName: 'One',
			enabled: true,
			gate: 'the comment reports a bug',
			gateOnUnavailable: 'skip' as const,
		},
	];
	const ready = {
		type: 'local_models_task_readiness_result',
		success: true,
		readiness: [{ taskId: 'cue-gate', state: 'ready', detail: 'Runs on Qwen.' }],
	};
	const off = {
		type: 'local_models_task_readiness_result',
		success: true,
		readiness: [
			{
				taskId: 'cue-gate',
				state: 'off',
				detail: 'Cue gate is off.',
				suggestedAction: 'Assign it a local model or an endpoint in Settings > Local Models.',
			},
		],
	};
	const written = (updated: string[]) => ({
		type: 'set_cue_subscription_gate_result',
		success: true,
		updated,
	});
	const printed = () => logSpy.mock.calls.map((call) => String(call[0]));

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('shows a gate and its policy without writing anything', async () => {
		const sent = mockBridge({ get_cue_subscriptions: { subscriptions: gated } });
		await cueGate('triage', {});
		expect(sent.map((frame) => frame.type)).toEqual(['get_cue_subscriptions']);
		expect(printed()).toEqual([
			'triage (One)',
			'  gate: the comment reports a bug',
			'  if no model can answer: skip the event',
		]);
	});

	it('says so when a subscription has no gate, and reads back as JSON', async () => {
		mockBridge({ get_cue_subscriptions: { subscriptions: gated } });
		await cueGate('on-pr', {});
		expect(printed()[0]).toBe('on-pr (One) has no gate. Every event starts a run.');

		logSpy.mockClear();
		await cueGate('on-pr', { json: true });
		expect(JSON.parse(printed()[0])).toEqual({
			subscriptionId: 'a1::p::on-pr',
			name: 'on-pr',
			gate: null,
			gateOnUnavailable: null,
		});

		logSpy.mockClear();
		await cueGate('triage', { json: true });
		expect(JSON.parse(printed()[0])).toMatchObject({
			gate: 'the comment reports a bug',
			gateOnUnavailable: 'skip',
		});
	});

	it('sets a trimmed condition with the default policy and names every subscription changed', async () => {
		const sent = mockBridge({
			get_cue_subscriptions: { subscriptions: gated },
			set_cue_subscription_gate: written(['on-pr', 'on-pr-cmd-a']),
			local_models_task_readiness: ready,
		});
		await cueGate('on-pr', { set: '  the PR changes source code  ' });
		expect(sent[1]).toEqual({
			type: 'set_cue_subscription_gate',
			subscriptionId: 'a1::p::on-pr',
			gate: 'the PR changes source code',
			gateOnUnavailable: 'run',
		});
		expect(printed()).toEqual([
			'Gate set on on-pr, on-pr-cmd-a (One): the PR changes source code',
			'  if no model can answer: start the run and warn',
		]);
	});

	it('warns when the gate was written but no model will check it', async () => {
		mockBridge({
			get_cue_subscriptions: { subscriptions: gated },
			set_cue_subscription_gate: written(['on-pr']),
			local_models_task_readiness: off,
		});
		await cueGate('on-pr', { set: 'the PR changes source code' });
		expect(printed()[2]).toBe(
			'Note: Cue gate is off. Assign it a local model or an endpoint in Settings > Local Models. Until it can answer, every event starts a run unchecked.'
		);

		// The consequence follows the policy that was written.
		logSpy.mockClear();
		await cueGate('on-pr', { set: 'the PR changes source code', onUnavailable: 'skip' });
		expect(printed()[2]).toMatch(/Until it can answer, every event is skipped\.$/);
	});

	it('does not fail a good write when readiness cannot be read', async () => {
		mockBridge({
			get_cue_subscriptions: { subscriptions: gated },
			set_cue_subscription_gate: written(['on-pr']),
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({
				sendCommand: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
					if (payload.type === 'local_models_task_readiness') {
						return Promise.reject(new Error('timed out'));
					}
					if (payload.type === 'get_cue_subscriptions') {
						return Promise.resolve({ subscriptions: gated });
					}
					return Promise.resolve(written(['on-pr']));
				}),
			} as never)
		);
		await cueGate('on-pr', { set: 'the PR changes source code' });
		expect(printed()).toHaveLength(2);
	});

	it('keeps the half that was not passed: a new condition keeps the policy, a new policy the condition', async () => {
		const sent = mockBridge({
			get_cue_subscriptions: { subscriptions: gated },
			set_cue_subscription_gate: written(['triage']),
			local_models_task_readiness: ready,
		});
		await cueGate('triage', { set: 'the comment asks for a change' });
		expect(sent[1]).toMatchObject({
			gate: 'the comment asks for a change',
			gateOnUnavailable: 'skip',
		});

		sent.length = 0;
		await cueGate('triage', { onUnavailable: 'run' });
		expect(sent[1]).toMatchObject({
			gate: 'the comment reports a bug',
			gateOnUnavailable: 'run',
		});
	});

	it('refuses a policy for a subscription that has no gate', async () => {
		const sent = mockBridge({ get_cue_subscriptions: { subscriptions: gated } });
		await expect(cueGate('on-pr', { onUnavailable: 'skip' })).rejects.toThrow('__exit__');
		expect(sent.map((frame) => frame.type)).toEqual(['get_cue_subscriptions']);
		expect(String(errorSpy.mock.calls[0][0])).toContain('has no gate to set a policy on');
	});

	it('removes a gate with a null condition and no policy', async () => {
		const sent = mockBridge({
			get_cue_subscriptions: { subscriptions: gated },
			set_cue_subscription_gate: written(['triage']),
		});
		await cueGate('triage', { clear: true });
		expect(sent[1]).toEqual({
			type: 'set_cue_subscription_gate',
			subscriptionId: 'a1::p::triage',
			gate: null,
		});
		expect(printed()).toEqual(['Removed the gate from triage (One).']);
	});

	it('reports a JSON result for a write, with no readiness lookup', async () => {
		const sent = mockBridge({
			get_cue_subscriptions: { subscriptions: gated },
			set_cue_subscription_gate: written(['on-pr']),
			local_models_task_readiness: off,
		});
		await cueGate('on-pr', { set: 'the PR changes source code', json: true });
		expect(sent.map((frame) => frame.type)).toEqual([
			'get_cue_subscriptions',
			'set_cue_subscription_gate',
		]);
		expect(JSON.parse(printed()[0])).toEqual({
			success: true,
			subscriptionId: 'a1::p::on-pr',
			updated: ['on-pr'],
			gate: 'the PR changes source code',
			gateOnUnavailable: 'run',
		});
	});

	it('refuses bad flags before connecting', async () => {
		const sent = mockBridge({});
		await expect(cueGate('on-pr', { set: '   ' })).rejects.toThrow('__exit__');
		await expect(cueGate('on-pr', { set: 'x'.repeat(1001) })).rejects.toThrow('__exit__');
		await expect(cueGate('on-pr', { onUnavailable: 'maybe' })).rejects.toThrow('__exit__');
		await expect(cueGate('on-pr', { clear: true, set: 'a bug' })).rejects.toThrow('__exit__');
		expect(sent).toHaveLength(0);
	});

	it('exits non-zero when the engine refuses the write or the bridge answers with an error', async () => {
		mockBridge({
			get_cue_subscriptions: { subscriptions: gated },
			set_cue_subscription_gate: {
				type: 'set_cue_subscription_gate_result',
				success: false,
				error: 'Could not write the gate.',
			},
		});
		await expect(cueGate('on-pr', { set: 'a bug' })).rejects.toThrow('__exit__');
		expect(String(errorSpy.mock.calls[0][0])).toContain('Could not write the gate.');

		mockBridge({
			get_cue_subscriptions: { subscriptions: gated },
			set_cue_subscription_gate: { type: 'error', message: 'Cue gate editing is not available' },
		});
		await expect(cueGate('on-pr', { clear: true })).rejects.toThrow('__exit__');
	});
});

describe('cue screen', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;

	const screened = [
		...subs,
		{
			id: 'a1::p::triage',
			name: 'triage',
			eventType: 'github.issue',
			sessionId: 'a1',
			sessionName: 'One',
			enabled: true,
			screenInjection: true,
			injectionThreshold: 0.6,
		},
	];
	const ready = {
		type: 'local_models_task_readiness_result',
		success: true,
		readiness: [{ taskId: 'injection-screen', state: 'ready', detail: 'Runs on Prompt Guard.' }],
	};
	const off = {
		type: 'local_models_task_readiness_result',
		success: true,
		readiness: [
			{
				taskId: 'injection-screen',
				state: 'off',
				detail: 'Prompt-injection screen is off.',
				suggestedAction: 'Assign it a classifier model in Settings > Local Models.',
			},
		],
	};
	const written = (updated: string[]) => ({
		type: 'set_cue_subscription_injection_screen_result',
		success: true,
		updated,
	});
	const printed = () => logSpy.mock.calls.map((call) => String(call[0]));

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('shows the screen without writing anything', async () => {
		const sent = mockBridge({ get_cue_subscriptions: { subscriptions: screened } });
		await cueScreen('triage', {});
		expect(sent.map((frame) => frame.type)).toEqual(['get_cue_subscriptions']);
		expect(printed()).toEqual([
			'triage (One)',
			'  injection screen: on (untrusted text is always screened)',
			'  blocks at a score of: 0.6',
		]);
	});

	it('reads the default back as auto at 0.8, and as JSON', async () => {
		mockBridge({ get_cue_subscriptions: { subscriptions: screened } });
		await cueScreen('on-pr', {});
		expect(printed()).toEqual([
			'on-pr (One)',
			'  injection screen: auto (commands that use untrusted text are screened)',
			'  blocks at a score of: 0.8',
		]);

		logSpy.mockClear();
		await cueScreen('on-pr', { json: true });
		expect(JSON.parse(printed()[0])).toEqual({
			subscriptionId: 'a1::p::on-pr',
			name: 'on-pr',
			mode: 'auto',
			threshold: 0.8,
		});
	});

	it('sets a mode, keeps the threshold the screen had, and names every subscription changed', async () => {
		const sent = mockBridge({
			get_cue_subscriptions: { subscriptions: screened },
			set_cue_subscription_injection_screen: written(['triage', 'triage-cmd-a']),
			local_models_task_readiness: ready,
		});
		await cueScreen('triage', { mode: 'auto' });
		expect(sent[1]).toEqual({
			type: 'set_cue_subscription_injection_screen',
			subscriptionId: 'a1::p::triage',
			mode: 'auto',
			threshold: 0.6,
		});
		expect(printed()).toEqual([
			'Injection screen on triage, triage-cmd-a (One): auto (commands that use untrusted text are screened)',
			'  blocks at a score of: 0.6',
		]);
	});

	it('changes only the threshold when only --threshold is passed', async () => {
		const sent = mockBridge({
			get_cue_subscriptions: { subscriptions: screened },
			set_cue_subscription_injection_screen: written(['triage']),
			local_models_task_readiness: ready,
		});
		await cueScreen('triage', { threshold: '0.9' });
		expect(sent[1]).toMatchObject({ mode: 'on', threshold: 0.9 });
	});

	it('sends no threshold when the screen is turned off', async () => {
		const sent = mockBridge({
			get_cue_subscriptions: { subscriptions: screened },
			set_cue_subscription_injection_screen: written(['triage']),
		});
		await cueScreen('triage', { mode: 'off' });
		expect(sent[1]).toEqual({
			type: 'set_cue_subscription_injection_screen',
			subscriptionId: 'a1::p::triage',
			mode: 'off',
		});
		// Nothing will be screened, so readiness is not asked.
		expect(sent).toHaveLength(2);
		expect(printed()).toEqual(['Injection screen on triage (One): off (never screened)']);
	});

	it('warns when the screen was written but no classifier will run it', async () => {
		mockBridge({
			get_cue_subscriptions: { subscriptions: screened },
			set_cue_subscription_injection_screen: written(['on-pr']),
			local_models_task_readiness: off,
		});
		await cueScreen('on-pr', { mode: 'on' });
		expect(printed()[2]).toBe(
			'Note: Prompt-injection screen is off. Assign it a classifier model in Settings > Local Models. Until it can run, a screened command is blocked and a screened prompt starts unscreened with a warning.'
		);
	});

	it('prints JSON for a write, without a readiness round trip', async () => {
		const sent = mockBridge({
			get_cue_subscriptions: { subscriptions: screened },
			set_cue_subscription_injection_screen: written(['on-pr']),
		});
		await cueScreen('on-pr', { mode: 'on', threshold: '0.5', json: true });
		expect(sent).toHaveLength(2);
		expect(JSON.parse(printed()[0])).toEqual({
			success: true,
			subscriptionId: 'a1::p::on-pr',
			updated: ['on-pr'],
			mode: 'on',
			threshold: 0.5,
		});
	});

	it('refuses bad flags before connecting', async () => {
		const sent = mockBridge({});
		await expect(cueScreen('on-pr', { mode: 'sometimes' })).rejects.toThrow('__exit__');
		await expect(cueScreen('on-pr', { threshold: '0' })).rejects.toThrow('__exit__');
		await expect(cueScreen('on-pr', { threshold: 'high' })).rejects.toThrow('__exit__');
		await expect(cueScreen('on-pr', { mode: 'off', threshold: '0.5' })).rejects.toThrow('__exit__');
		expect(sent).toHaveLength(0);
	});

	it('refuses a threshold on a screen that is off, instead of writing one that does nothing', async () => {
		const sent = mockBridge({
			get_cue_subscriptions: {
				subscriptions: [{ ...screened[3], screenInjection: false, injectionThreshold: undefined }],
			},
		});
		await expect(cueScreen('triage', { threshold: '0.5' })).rejects.toThrow('__exit__');
		expect(sent.map((frame) => frame.type)).toEqual(['get_cue_subscriptions']);
		expect(String(errorSpy.mock.calls[0][0])).toContain('has its screen off');
	});

	it('exits non-zero when the engine refuses the write or the bridge answers with an error', async () => {
		mockBridge({
			get_cue_subscriptions: { subscriptions: screened },
			set_cue_subscription_injection_screen: {
				type: 'set_cue_subscription_injection_screen_result',
				success: false,
				error: 'Could not write the screen.',
			},
		});
		await expect(cueScreen('on-pr', { mode: 'on' })).rejects.toThrow('__exit__');
		expect(String(errorSpy.mock.calls[0][0])).toContain('Could not write the screen.');

		mockBridge({
			get_cue_subscriptions: { subscriptions: screened },
			set_cue_subscription_injection_screen: {
				type: 'error',
				message: 'Cue injection screen editing is not available',
			},
		});
		await expect(cueScreen('on-pr', { mode: 'off' })).rejects.toThrow('__exit__');
	});
});
