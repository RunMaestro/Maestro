/**
 * The launch job that brings every moved agent home (`runComeHome()`): online first, a host that
 * does not answer is retried then returned offline, a running host turn is waited out, an agent
 * already home is not touched, one agent at a time.
 */

import { describe, expect, it, vi } from 'vitest';
import {
	createComeHomeRunner,
	HOST_COPY_RETRY_MS,
	hostCopiesLeft,
	movedAgents,
	onlineSkipReason,
	runComeHome,
	type ComeHomeDeps,
} from '../../../main/federation/come-home';
import type { SshRemoteConfig } from '../../../shared/types';
import type { DesktopReturnAnswer } from '../../../main/federation/lift';
import type { ReturnRunOptions } from '../../../shared/maestro-lib/agents/lift-return';
import type { AgentRecord } from '../../../shared/maestro-lib/store/records';

const MOVED_AT = 1_700_000_000_000;
const REMOTE = { id: 'remote-1', name: 'build-box', enabled: true } as SshRemoteConfig;

function agent(id: string, moved = true, logsAt: number[] = []): AgentRecord {
	return {
		id,
		name: `Agent ${id}`,
		toolType: 'claude-code',
		cwd: '/home/me',
		state: 'idle',
		sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		aiTabs: [{ id: `${id}-tab`, name: 'Main', logs: logsAt.map((timestamp) => ({ timestamp })) }],
		...(moved ? { liftedTo: { peer: 'build-box', agentId: `host-${id}`, at: MOVED_AT } } : {}),
	} as unknown as AgentRecord;
}

function ok(): DesktopReturnAnswer {
	return {
		ok: true,
		result: {
			agent: { id: 'x', name: 'x' },
			from: 'build-box:host-x',
			tabs: 1,
			newTabs: 0,
			hostCopyRemoved: true,
		},
	};
}

function refused(code: string, error = code): DesktopReturnAnswer {
	return { ok: false, code, error };
}

/**
 * A store the fake return writes to, so "home" is asserted on the stored records. Like the real
 * return: an offline return leaves the host copy marked (`hostCopyLeft`), an online one clears it,
 * and a home record with a marker can be returned again (to finish), but not offline.
 */
function world(
	agents: AgentRecord[],
	answer: (id: string, options: ReturnRunOptions, call: number) => DesktopReturnAnswer
) {
	const store = new Map(agents.map((a) => [a.id, a]));
	const calls: Array<{ id: string; options: ReturnRunOptions }> = [];
	const deps: ComeHomeDeps = {
		readAgents: () => [...store.values()],
		readRemotes: () => [REMOTE],
		hostingEnabled: () => false,
		returnAgent: vi.fn(async (id: string, options: ReturnRunOptions) => {
			calls.push({ id, options });
			const current = store.get(id);
			const pointer = current?.liftedTo;
			if (!pointer && (!current?.hostCopyLeft || options.offline)) {
				return refused('RETURN_NOT_HOSTED');
			}
			const result = answer(id, options, calls.filter((c) => c.id === id).length);
			if (result.ok && current) {
				const {
					liftedTo: _gone,
					hostCopyLeft: _left,
					...home
				} = current as AgentRecord & { liftedTo?: unknown };
				store.set(id, {
					...home,
					hostedOptOut: true,
					...(options.offline && pointer
						? { hostCopyLeft: { ...pointer, fetched: false, returnedAt: MOVED_AT + 1 } }
						: {}),
				} as AgentRecord);
			}
			return result;
		}),
		sleep: vi.fn(async () => {}),
		now: () => MOVED_AT + 1,
	};
	return { deps, store, calls };
}

describe('runComeHome', () => {
	it('returns every moved agent online, one at a time, and leaves each a plain SSH agent', async () => {
		const { deps, store, calls } = world([agent('a'), agent('b'), agent('c', false)], ok);
		const report = await runComeHome(deps);
		expect(report.agents.map((o) => [o.id, o.result])).toEqual([
			['a', 'online'],
			['b', 'online'],
		]);
		expect(calls.map((c) => c.id)).toEqual(['a', 'b']);
		expect(movedAgents([...store.values()])).toEqual([]);
		expect(deps.sleep).not.toHaveBeenCalled();
	});

	it('does nothing while hosting is on', async () => {
		const { deps } = world([agent('a')], ok);
		deps.hostingEnabled = () => true;
		const report = await runComeHome(deps);
		expect(report.agents).toEqual([]);
		expect(deps.returnAgent).not.toHaveBeenCalled();
	});

	it('with no moved agent, makes no return call at all', async () => {
		const { deps } = world([agent('a', false)], ok);
		await runComeHome(deps);
		expect(deps.returnAgent).not.toHaveBeenCalled();
	});

	it('a host that does not answer: a fixed number of tries, then offline, with what is missing', async () => {
		const { deps, store, calls } = world(
			[agent('a', true, [MOVED_AT - 5, MOVED_AT + 9])],
			(_id, options) => (options.offline ? ok() : refused('PEER_NOT_CONNECTED', 'host-down'))
		);
		const report = await runComeHome(deps, { onlineAttempts: 3, retryWaitMs: 7 });
		expect(calls.map((c) => c.options.offline === true)).toEqual([false, false, false, true]);
		expect(deps.sleep).toHaveBeenCalledTimes(2);
		expect(deps.sleep).toHaveBeenCalledWith(7);
		expect(report.agents[0]).toMatchObject({
			id: 'a',
			result: 'offline',
			missing: {
				peer: 'build-box',
				hostAgentId: 'host-a',
				movedAt: MOVED_AT,
				lastLocalRowAt: MOVED_AT + 9,
			},
		});
		expect(report.agents[0].notices.join(' ')).toContain('host-down');
		expect(store.get('a')?.liftedTo).toBeUndefined();
	});

	it('a remote opted out during a retry wait is not dialed again: offline, and the notice says why', async () => {
		const { deps, calls } = world([agent('a')], (_id, options) =>
			options.offline ? ok() : refused('PEER_NOT_CONNECTED', 'host-down')
		);
		let remote: SshRemoteConfig = REMOTE;
		deps.readRemotes = () => [remote];
		deps.sleep = vi.fn(async () => {
			remote = { ...REMOTE, federation: false } as SshRemoteConfig;
		});
		const report = await runComeHome(deps, { onlineAttempts: 3, retryWaitMs: 7 });
		expect(calls.map((c) => c.options.offline === true)).toEqual([false, true]);
		expect(report.agents[0].result).toBe('offline');
		expect(report.agents[0].notices.join(' ')).toContain('opted out of Federation');
	});

	it('hosting turned on during a wait: no further return call, the agent stays where it is', async () => {
		const { deps, store, calls } = world([agent('a')], () => refused('RETURN_BUSY'));
		let hosting = false;
		deps.hostingEnabled = () => hosting;
		deps.sleep = vi.fn(async () => {
			hosting = true;
		});
		const report = await runComeHome(deps, { busyWaitMs: 5, busyMaxWaitMs: 1_000 });
		expect(calls).toHaveLength(1);
		expect(report.agents).toEqual([]);
		expect(store.get('a')?.liftedTo).toBeDefined();
	});

	it('a host that answers on the second try comes back online', async () => {
		const { deps } = world([agent('a')], (_id, _o, call) =>
			call === 1 ? refused('RETURN_HOST_FAILED') : ok()
		);
		const report = await runComeHome(deps);
		expect(report.agents[0].result).toBe('online');
	});

	it('host down, then up at the next launch: offline now, the host copy finished the second time', async () => {
		let hostUp = false;
		const { deps, store, calls } = world([agent('a')], (_id, options) =>
			options.offline || hostUp ? ok() : refused('PEER_NOT_CONNECTED')
		);
		const first = await runComeHome(deps, { onlineAttempts: 2 });
		expect(first.agents[0].result).toBe('offline');
		// The offline return in this run is not dialed again in the same run.
		expect(calls.map((c) => c.options.offline === true)).toEqual([false, false, true]);
		expect(store.get('a')?.hostCopyLeft).toMatchObject({ agentId: 'host-a', fetched: false });

		hostUp = true;
		const second = await runComeHome(deps);
		expect(calls.slice(3)).toEqual([{ id: 'a', options: {} }]);
		expect(second.agents[0]).toMatchObject({ id: 'a', result: 'online' });
		expect(second.agents[0].notices.join(' ')).toContain('old copy on build-box is removed');
		expect(store.get('a')?.hostCopyLeft).toBeUndefined();
		expect(store.get('a')?.liftedTo).toBeUndefined();

		// Nothing left: a third launch makes no call.
		const third = await runComeHome(deps);
		expect(third.agents).toEqual([]);
		expect(calls).toHaveLength(4);
	});

	it('a host copy left behind: one try per launch, silent while the host is down, never offline', async () => {
		const home = {
			...agent('a', false),
			hostCopyLeft: {
				peer: 'build-box',
				agentId: 'host-a',
				at: MOVED_AT,
				fetched: true,
				returnedAt: MOVED_AT,
			},
		} as AgentRecord;
		const { deps, store, calls } = world([home], () => refused('PEER_NOT_CONNECTED'));
		const report = await runComeHome(deps);
		expect(calls).toEqual([{ id: 'a', options: {} }]);
		expect(deps.sleep).not.toHaveBeenCalled();
		expect(report.agents).toEqual([]);
		expect(store.get('a')?.hostCopyLeft).toBeDefined();
	});

	it('a host copy left behind is not dialed once it is older than the retry window, or on a remote that may not be dialed', async () => {
		const left = (returnedAt: number) =>
			({
				...agent('a', false),
				hostCopyLeft: { peer: 'build-box', agentId: 'host-a', at: 1, fetched: true, returnedAt },
			}) as AgentRecord;
		const now = MOVED_AT + 1;
		expect(hostCopiesLeft([left(now - HOST_COPY_RETRY_MS)], now)).toEqual([]);
		expect(hostCopiesLeft([left(now - 1)], now)).toHaveLength(1);

		const { deps } = world([left(now - 1)], ok);
		deps.readRemotes = () => [{ ...REMOTE, federation: false } as SshRemoteConfig];
		const report = await runComeHome(deps);
		expect(deps.returnAgent).not.toHaveBeenCalled();
		expect(report.agents).toEqual([]);
	});

	it('waits out a turn running on the host, never interrupting it, then returns the agent', async () => {
		const { deps } = world([agent('a')], (_id, _o, call) =>
			call <= 2 ? refused('RETURN_BUSY') : ok()
		);
		const report = await runComeHome(deps, { busyWaitMs: 11 });
		expect(report.agents[0]).toMatchObject({ result: 'online', waitedForHostTurn: true });
		expect(deps.sleep).toHaveBeenCalledWith(11);
	});

	it('a host turn that runs past the limit leaves the agent moved for the next launch', async () => {
		const { deps, store } = world([agent('a')], () => refused('RETURN_BUSY'));
		const report = await runComeHome(deps, { busyWaitMs: 10, busyMaxWaitMs: 30 });
		expect(report.agents[0]).toMatchObject({ result: 'failed', waitedForHostTurn: true });
		expect(store.get('a')?.liftedTo).toBeDefined();
	});

	it('a refusal no retry can fix is reported and the job moves on', async () => {
		const { deps } = world([agent('a'), agent('b')], (id) =>
			id === 'a' ? refused('RETURN_NO_SSH', 'no remote') : ok()
		);
		const report = await runComeHome(deps);
		expect(report.agents.map((o) => [o.id, o.result])).toEqual([
			['a', 'failed'],
			['b', 'online'],
		]);
		expect(report.agents[0].notices).toEqual(['no remote']);
	});

	it('an agent moved back by the user meanwhile is skipped', async () => {
		const { deps, store } = world([agent('a'), agent('b')], ok);
		const original = deps.returnAgent;
		deps.returnAgent = vi.fn(async (id: string, options: ReturnRunOptions) => {
			if (id === 'a') store.set('b', agent('b', false));
			return original(id, options);
		});
		const report = await runComeHome(deps);
		expect(report.agents.map((o) => o.id)).toEqual(['a']);
	});

	it.each([
		['deleted', [] as SshRemoteConfig[], 'no longer configured'],
		['disabled', [{ ...REMOTE, enabled: false }], 'is disabled'],
		['opted out of Federation', [{ ...REMOTE, federation: false }], 'opted out of Federation'],
	])(
		'a remote that is %s is not dialed: the agent comes home offline and the notice says why',
		async (_label, remotes, reason) => {
			const { deps, store, calls } = world([agent('a')], ok);
			deps.readRemotes = () => remotes;
			const report = await runComeHome(deps);
			expect(calls).toEqual([{ id: 'a', options: { offline: true } }]);
			expect(report.agents[0].result).toBe('offline');
			expect(report.agents[0].notices.join(' ')).toContain(reason);
			expect(movedAgents([...store.values()])).toEqual([]);
			expect(deps.sleep).not.toHaveBeenCalled();
		}
	);
});

describe('onlineSkipReason', () => {
	it('lets an enabled Federation remote be dialed', () => {
		expect(onlineSkipReason(agent('a'), [REMOTE])).toBeUndefined();
	});
});

describe('createComeHomeRunner', () => {
	it('runs one job at a time: a second call joins the run in flight, a later call runs again', async () => {
		let release: () => void = () => {};
		const { deps } = world([agent('a')], ok);
		deps.returnAgent = vi.fn(
			() =>
				new Promise<DesktopReturnAnswer>((resolve) => {
					release = () => resolve(refused('RETURN_NOT_HOSTED'));
				})
		);
		const runner = createComeHomeRunner(deps);
		expect(runner.lastReport()).toBeNull();
		const first = runner.run();
		const second = runner.run();
		expect(second).toBe(first);
		await vi.waitFor(() => expect(deps.returnAgent).toHaveBeenCalledTimes(1));
		release();
		const report = await first;
		expect(runner.lastReport()).toBe(report);
		const third = runner.run();
		expect(third).not.toBe(first);
		await vi.waitFor(() => expect(deps.returnAgent).toHaveBeenCalledTimes(2));
		release();
		await third;
	});
});
