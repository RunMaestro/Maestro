/**
 * @file cue-control.test.ts
 * @description Tests for `cue enable|disable|activity`: name resolution
 * (refusing an ambiguous name), the toggle message, error-frame handling, and
 * `activity`'s read of `cue.db` when the desktop app is not running.
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
