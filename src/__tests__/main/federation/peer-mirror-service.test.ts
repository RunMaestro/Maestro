/**
 * Tests for the desktop's peer mirror service: sequential connects, failures as peer state,
 * event pushes with turn coalescing, reconcile on remote edits, wake reload, reconnect, stop, and
 * `act()`, the input path to a mirrored agent, and `hostClient()`, the client Move to Host borrows
 * (FED-SSH-06).
 * The SSH forward and the host client are stood in for; nothing here dials.
 */

import * as os from 'os';
import { describe, expect, it, vi } from 'vitest';
import {
	MIRROR_ACT_RECONNECT_WAIT_MS,
	MIRROR_HOSTED_REPROBE_INTERVAL_MS,
	MIRROR_IDLE_REDIAL_MAX_MS,
	MIRROR_REPROBE_INTERVAL_MS,
	MIRROR_TURN_COALESCE_MS,
	MIRROR_UNANNOUNCED_HISTORY_TTL_MS,
	MIRROR_HISTORY_PUSH_MERGE_MS,
	PeerMirrorService,
	type PeerMirrorServiceDeps,
} from '../../../main/federation/peer-mirror-service';
import type { MirrorPush } from '../../../shared/maestro-lib/client/peer-mirror';
import { STREAM_FLUSH_INTERVAL_MS } from '../../../shared/streamFlushInterval';
import {
	SshForwardError,
	type SshForwardLease,
	type SshForwardState,
} from '../../../shared/maestro-lib/client/ssh-forward';
import type {
	ClientResult,
	ConnectionState,
	MaestroClient,
	MaestroEvent,
	QueuedTurn,
} from '../../../shared/maestro-lib/client/types';
import type { AgentRecord } from '../../../shared/maestro-lib/store/records';
import type { SshRemoteConfig } from '../../../shared/types';

const remoteOf = (id: string, overrides: Partial<SshRemoteConfig> = {}): SshRemoteConfig => ({
	id,
	name: id,
	host: `${id}.example.com`,
	port: 22,
	username: 'pedram',
	privateKeyPath: '',
	enabled: true,
	federation: true,
	...overrides,
});

const ENDPOINT = { port: 50123, remotePort: 41234, token: 't', cliSecret: 's', pid: 1 };
const agent = (id: string, tabs = ['t1']): AgentRecord => ({
	id,
	name: id,
	toolType: 'claude-code',
	aiTabs: tabs.map((tabId) => ({ id: tabId })),
});

/** Let every queued promise settle. */
async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

interface FakeHost {
	remoteId: string;
	lease: SshForwardLease & { release: ReturnType<typeof vi.fn>; restart: ReturnType<typeof vi.fn> };
	emitLease(state: SshForwardState): void;
	client: MaestroClient;
	emit(event: MaestroEvent): void;
	setState(state: ConnectionState): void;
	setAgents(agents: AgentRecord[]): void;
	connect: ReturnType<typeof vi.fn>;
	reconnect: ReturnType<typeof vi.fn>;
	list: ReturnType<typeof vi.fn>;
	transcript: ReturnType<typeof vi.fn>;
	/** `turns.queue.list`: answers what `setQueue` holds for the agent. */
	queueList: ReturnType<typeof vi.fn>;
	setQueue(agentId: string, items: QueuedTurn[]): void;
	/** `history.list`: one USER entry per call, its id counting the reads. */
	historyList: ReturnType<typeof vi.fn>;
	/** `history.remove` / `history.update`: an edit of the host's own History. */
	historyRemove: ReturnType<typeof vi.fn>;
	historyUpdate: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
	/** Resolve the forward's `ready()`; until then a connect waits. */
	open(): void;
	fail(error: Error): void;
}

function fakeHost(remoteId: string, options: { manualReady?: boolean } = {}): FakeHost {
	const leaseListeners = new Set<(state: SshForwardState) => void>();
	const eventListeners = new Set<(event: MaestroEvent) => void>();
	let state: ConnectionState = 'idle';
	let agents: AgentRecord[] = [agent(`${remoteId}-a1`)];
	let resolveReady!: (value: typeof ENDPOINT) => void;
	let rejectReady!: (error: Error) => void;
	const ready = options.manualReady
		? new Promise<typeof ENDPOINT>((resolve, reject) => {
				resolveReady = resolve;
				rejectReady = reject;
			})
		: Promise.resolve(ENDPOINT);
	const emit = (event: MaestroEvent) => eventListeners.forEach((l) => l(event));
	const lease = {
		remoteId,
		state: () => ({ status: 'up', endpoint: ENDPOINT }) as SshForwardState,
		ready: () => ready,
		onChange: (listener: (s: SshForwardState) => void) => {
			leaseListeners.add(listener);
			return () => leaseListeners.delete(listener);
		},
		restart: vi.fn(),
		release: vi.fn(async () => undefined),
	};
	const connect = vi.fn(async (): Promise<ClientResult<unknown>> => {
		state = 'connected';
		emit({ type: 'host.connected', host: { kind: 'headless', label: 'h' }, resumed: false });
		emit({ type: 'snapshot', agents, groups: [] });
		return { ok: true, value: {} };
	});
	const reconnect = vi.fn(async (): Promise<ClientResult<unknown>> => {
		state = 'connected';
		return { ok: true, value: {} };
	});
	const list = vi.fn(async () => ({ ok: true, value: agents }));
	const transcript = vi.fn(async () => ({
		ok: true,
		value: [{ id: 'e1', timestamp: 1, source: 'user', text: 'hi' }],
	}));
	const queues = new Map<string, QueuedTurn[]>();
	const queueList = vi.fn(async (agentId: string) => ({
		ok: true,
		value: queues.get(agentId) ?? [],
	}));
	let historyReads = 0;
	const historyList = vi.fn(async () => ({
		ok: true,
		value: [
			{ id: `h${++historyReads}`, type: 'USER', timestamp: 1, summary: 's', projectPath: '/p' },
		],
	}));
	const historyRemove = vi.fn(async () => ({ ok: true, value: { removed: true } }));
	const historyUpdate = vi.fn(async () => ({ ok: true, value: { updated: true } }));
	const close = vi.fn(async () => undefined);
	const client = {
		connection: { connect, reconnect, close, state: () => state },
		agents: { list },
		groups: { list: vi.fn(async () => ({ ok: true, value: [] })) },
		tabs: { transcript },
		turns: { queue: { list: queueList } },
		history: { list: historyList, remove: historyRemove, update: historyUpdate },
		events: {
			subscribe: (listener: (event: MaestroEvent) => void) => {
				eventListeners.add(listener);
				return () => eventListeners.delete(listener);
			},
		},
	} as unknown as MaestroClient;
	return {
		remoteId,
		lease: lease as unknown as FakeHost['lease'],
		emitLease: (s) => leaseListeners.forEach((l) => l(s)),
		client,
		emit,
		setState: (s) => (state = s),
		setAgents: (next) => (agents = next),
		connect,
		reconnect,
		list,
		transcript,
		queueList,
		setQueue: (agentId, items) => queues.set(agentId, items),
		historyList,
		historyRemove,
		historyUpdate,
		close,
		open: () => resolveReady(ENDPOINT),
		fail: (error) => rejectReady(error),
	};
}

function harness(
	remotes: SshRemoteConfig[],
	hosts: Record<string, FakeHost>,
	extra: Partial<PeerMirrorServiceDeps> = {}
) {
	const pushes: MirrorPush[] = [];
	const timers: Array<() => void> = [];
	let remotesNow = remotes;
	let onRemotesChange: (() => void) | undefined;
	const leaseFor = new Map<SshForwardLease, string>();
	const deps: PeerMirrorServiceDeps = {
		readRemotes: () => remotesNow,
		watchRemotes: (cb) => {
			onRemotesChange = cb;
			return () => (onRemotesChange = undefined);
		},
		acquireForward: vi.fn((remote: SshRemoteConfig) => {
			const host = hosts[remote.id];
			leaseFor.set(host.lease, remote.id);
			return host.lease;
		}),
		createClient: vi.fn(() => {
			// The client belongs to the remote whose forward was acquired last.
			const lastRemote = [...leaseFor.values()].pop() as string;
			return hosts[lastRemote].client;
		}),
		push: (payload) => pushes.push(payload),
		reset: vi.fn(),
		now: () => 1000,
		setTimer: (cb) => {
			timers.push(cb);
			return timers.length;
		},
		clearTimer: () => undefined,
		...extra,
	};
	const service = new PeerMirrorService(deps);
	return {
		service,
		deps,
		pushes,
		flushTimers: () => timers.splice(0).forEach((cb) => cb()),
		setRemotes: (next: SshRemoteConfig[]) => {
			remotesNow = next;
			onRemotesChange?.();
		},
		types: (peerId?: string) =>
			pushes.filter((p) => !peerId || p.peerId === peerId).map((p) => p.event.type),
	};
}

describe('PeerMirrorService', () => {
	it('probes every remote except one that opted out, strictly one after another', async () => {
		const a = fakeHost('a', { manualReady: true });
		const b = fakeHost('b', { manualReady: true });
		const off = fakeHost('off');
		const h = harness(
			[
				remoteOf('a'),
				remoteOf('off', { federation: false }),
				remoteOf('b', { federation: undefined }),
			],
			{
				a,
				b,
				off,
			}
		);
		h.service.start();
		await settle();
		// a is dialing; b has not been touched yet.
		expect(h.deps.acquireForward).toHaveBeenCalledTimes(1);
		expect(h.service.peers().map((p) => [p.peerId, p.connection])).toEqual([
			['a', 'connecting'],
			['b', 'connecting'],
		]);
		a.open();
		await settle();
		expect(h.deps.acquireForward).toHaveBeenCalledTimes(2);
		b.open();
		await settle();
		expect(h.service.peers()).toEqual([
			expect.objectContaining({ peerId: 'a', connection: 'connected', agentCount: 1 }),
			expect.objectContaining({ peerId: 'b', connection: 'connected', agentCount: 1 }),
		]);
		expect(h.deps.acquireForward).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'off' }));
	});

	it('answers isRemoteConnected only while the peer on that remote is connected', async () => {
		const a = fakeHost('a', { manualReady: true });
		const h = harness([remoteOf('a')], { a });
		expect(h.service.isRemoteConnected('a')).toBe(false);
		h.service.start();
		await settle();
		expect(h.service.isRemoteConnected('a')).toBe(false);
		a.open();
		await settle();
		expect(h.service.isRemoteConnected('a')).toBe(true);
		expect(h.service.isRemoteConnected('unknown')).toBe(false);
		h.setRemotes([]);
		await settle();
		expect(h.service.isRemoteConnected('a')).toBe(false);
	});

	it('asks the host on a remote for its projects token usage only while that host is connected', async () => {
		const a = fakeHost('a', { manualReady: true });
		const usage = { projects: [{ status: 'unsupported', breakdowns: [], complete: false }] };
		const projectTokens = vi.fn(async () => ({ ok: true, value: usage }));
		(a.client as unknown as { usage: unknown }).usage = { projectTokens };
		const h = harness([remoteOf('a')], { a });
		const projects = [{ provider: 'codex', projectPath: '/srv/app' }];
		h.service.start();
		await settle();
		expect(await h.service.projectTokenUsage('a', projects, 500)).toBeUndefined();
		a.open();
		await settle();
		expect(await h.service.projectTokenUsage('a', projects, 500)).toEqual(usage);
		expect(projectTokens).toHaveBeenCalledWith(projects, { timeoutMs: 500 });
		expect(await h.service.projectTokenUsage('unknown', projects, 500)).toBeUndefined();
		projectTokens.mockResolvedValueOnce({
			ok: false,
			error: { code: 'unsupported', message: 'old', method: 'usage.projectTokens' },
		} as never);
		expect(await h.service.projectTokenUsage('a', projects, 500)).toBeUndefined();
	});

	it('records a host that is down as the peer state with the fix line, and keeps going', async () => {
		const a = fakeHost('a', { manualReady: true });
		const b = fakeHost('b');
		const h = harness([remoteOf('a'), remoteOf('b')], { a, b });
		h.service.start();
		await settle();
		a.fail(new SshForwardError('not-running', 'no host'));
		await settle();
		const [down, up] = h.service.peers();
		expect(down.connection).toBe('host-down');
		expect(down.error).toContain('maestro-cli remote-host start a');
		expect(a.lease.release).toHaveBeenCalled();
		expect(up.connection).toBe('connected');
	});

	it('pushes agent changes at once and coalesces turn chunks per tab', async () => {
		const a = fakeHost('a');
		const h = harness([remoteOf('a')], { a });
		h.service.start();
		await settle();
		h.pushes.length = 0;
		a.emit({
			type: 'turn',
			agentId: 'a-a1',
			tabId: 't1',
			event: { kind: 'text', at: 1, text: 'He' },
		});
		a.emit({
			type: 'turn',
			agentId: 'a-a1',
			tabId: 't1',
			event: { kind: 'text', at: 2, text: 'y' },
		});
		expect(h.pushes).toEqual([]);
		h.flushTimers();
		expect(h.pushes).toEqual([
			{
				peerId: 'a',
				event: {
					type: 'turn',
					agentId: 'a-a1',
					tabId: 't1',
					event: { kind: 'text', at: 1, text: 'Hey' },
				},
			},
		]);
		// The cadence a local tab flushes its output at (R34).
		expect(MIRROR_TURN_COALESCE_MS).toBe(STREAM_FLUSH_INTERVAL_MS);

		// A non-turn push flushes the buffered turn first, so order holds.
		h.pushes.length = 0;
		a.emit({
			type: 'turn',
			agentId: 'a-a1',
			tabId: 't1',
			event: { kind: 'text', at: 3, text: '!' },
		});
		a.emit({ type: 'agent.removed', agentId: 'a-a1' });
		expect(h.pushes.map((p) => p.event.type)).toEqual(['turn', 'agent.removed', 'peer.state']);
		expect(h.service.snapshot().peers[0].agents).toEqual([]);
	});

	// Parity R34: a hosted reply rendered four times as often as a local one (pushes every 50 ms
	// against a local flush every 200 ms), so its tab made more React commits per turn. The same
	// streamed reply now reaches a window as many times as a local tab flushes its output.
	it('pushes a streaming reply as often as a local tab flushes its output (R34)', async () => {
		vi.useFakeTimers();
		try {
			const a = fakeHost('a');
			const h = harness([remoteOf('a')], { a }, { setTimer: (cb, ms) => setTimeout(cb, ms) });
			h.service.start();
			await settle();
			h.pushes.length = 0;
			// A 4 s reply, one chunk every 10 ms.
			const streamMs = 4_000;
			for (let at = 0; at < streamMs; at += 10) {
				a.emit({
					type: 'turn',
					agentId: 'a-a1',
					tabId: 't1',
					event: { kind: 'text', at, text: 'x' },
				});
				vi.advanceTimersByTime(10);
			}
			const turnPushes = h.pushes.filter((p) => p.event.type === 'turn');
			// The flushes a local tab's output batch makes over the same 4 s.
			expect(turnPushes).toHaveLength(streamMs / STREAM_FLUSH_INTERVAL_MS);
			const text = turnPushes
				.map((p) =>
					p.event.type === 'turn' && p.event.event.kind === 'text' ? p.event.event.text : ''
				)
				.join('');
			expect(text).toBe('x'.repeat(streamMs / 10));
		} finally {
			vi.useRealTimers();
		}
	});

	it('keeps the last known agents when the host or the forward drops', async () => {
		const a = fakeHost('a');
		const h = harness([remoteOf('a')], { a });
		h.service.start();
		await settle();
		a.emit({ type: 'host.lost', reason: 'socket closed' });
		expect(h.service.peers()[0]).toMatchObject({ connection: 'lost', agentCount: 1 });
		a.emitLease({
			status: 'down',
			error: new Error('ssh exited'),
			attempt: 1,
			retryInMs: 1000,
		});
		expect(h.service.peers()[0]).toMatchObject({ connection: 'lost', error: 'ssh exited' });
		expect(h.service.snapshot().peers[0].agents).toHaveLength(1);
	});

	it('reads a transcript lazily, serves a second read from cache, and re-reads a stale tab', async () => {
		const a = fakeHost('a');
		const h = harness([remoteOf('a')], { a });
		h.service.start();
		await settle();
		const key = 'a-a1\u0000t1';
		// Nothing was held before the first attach, so nothing is stale yet: the first read is lazy.
		expect(h.service.snapshot().peers[0].staleTabs[key]).toBeUndefined();
		const first = await h.service.transcript('a', 'a-a1', 't1');
		expect(first).toHaveLength(1);
		expect(a.transcript).toHaveBeenCalledWith('a-a1', 't1', { tail: 500 });
		expect(h.service.snapshot().peers[0].staleTabs[key]).toBeUndefined();
		await h.service.transcript('a', 'a-a1', 't1');
		expect(a.transcript).toHaveBeenCalledTimes(1);
		// A finished turn makes the tab stale again, so the next read goes to the host.
		a.emit({
			type: 'turn',
			agentId: 'a-a1',
			tabId: 't1',
			event: { kind: 'outcome', at: 5, outcome: 'completed' as never, exitCode: 0 },
		});
		expect(h.service.snapshot().peers[0].staleTabs[key]).toBe(true);
		await h.service.transcript('a', 'a-a1', 't1');
		expect(a.transcript).toHaveBeenCalledTimes(2);
		expect(h.service.snapshot().peers[0].staleTabs[key]).toBeUndefined();
	});

	it('refuses a transcript read for a peer that is not attached', async () => {
		const a = fakeHost('a', { manualReady: true });
		const h = harness([remoteOf('a')], { a });
		h.service.start();
		await settle();
		a.fail(new SshForwardError('not-installed', 'Install maestro-cli.'));
		await settle();
		await expect(h.service.transcript('a', 'x', 'y')).rejects.toThrow(/not connected/);
		await expect(h.service.transcript('nope', 'x', 'y')).rejects.toThrow(/Not a mirrored peer/);
	});

	it('wake reload reconnects when needed, reloads the agents, marks tabs stale, and dedupes', async () => {
		const a = fakeHost('a');
		const h = harness([remoteOf('a')], { a });
		h.service.start();
		await settle();
		a.setState('reconnecting');
		a.setAgents([agent('a-a1'), agent('a-a2')]);
		h.service.reloadAfterWake();
		h.service.reloadAfterWake();
		await settle();
		expect(a.reconnect).toHaveBeenCalledTimes(1);
		expect(a.list).toHaveBeenCalledTimes(1);
		expect(h.service.peers()[0]).toMatchObject({ connection: 'connected', agentCount: 2 });
		expect(Object.keys(h.service.snapshot().peers[0].staleTabs)).toHaveLength(2);
		expect(h.types('a')).toContain('peer.stale');
	});

	it('reconnect restarts a downed forward and answers with the peer state', async () => {
		const a = fakeHost('a');
		const h = harness([remoteOf('a')], { a });
		h.service.start();
		await settle();
		(a.lease as unknown as { state: () => SshForwardState }).state = () => ({ status: 'stopped' });
		const result = await h.service.reconnect('a');
		expect(a.lease.restart).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({ ok: true, peer: { peerId: 'a', connection: 'connected' } });
		expect(await h.service.reconnect('nope')).toMatchObject({ ok: false });
	});

	// Parity R16: a host nothing here is hosted on redials slowly while it stays down; one that runs
	// an agent of this machine keeps the forward's own pace, and an explicit act dials at once.
	describe('redial pace (R16)', () => {
		const withCeiling = (host: FakeHost) => {
			const setBackoffCeiling = vi.fn();
			(host.lease as unknown as Record<string, unknown>).setBackoffCeiling = setBackoffCeiling;
			return setBackoffCeiling;
		};

		it('slows the redial of a host nothing here is hosted on, and keeps the pace of one that is', async () => {
			const a = fakeHost('a');
			const b = fakeHost('b');
			const ceilingA = withCeiling(a);
			const ceilingB = withCeiling(b);
			const h = harness(
				[remoteOf('a'), remoteOf('b')],
				{ a, b },
				{
					hostsAgents: (peerId) => peerId === 'b',
				}
			);
			h.service.start();
			await settle();
			expect(ceilingA).toHaveBeenLastCalledWith(MIRROR_IDLE_REDIAL_MAX_MS);
			expect(ceilingB).toHaveBeenLastCalledWith(undefined);
		});

		it('takes the pace again when what this machine hosts changes', async () => {
			const a = fakeHost('a');
			const ceiling = withCeiling(a);
			let hosted = false;
			const h = harness([remoteOf('a')], { a }, { hostsAgents: () => hosted });
			h.service.start();
			await settle();
			expect(ceiling).toHaveBeenLastCalledWith(MIRROR_IDLE_REDIAL_MAX_MS);
			hosted = true;
			h.service.noteHostedAgentsChanged();
			expect(ceiling).toHaveBeenLastCalledWith(undefined);
			hosted = false;
			h.service.noteHostedAgentsChanged();
			expect(ceiling).toHaveBeenLastCalledWith(MIRROR_IDLE_REDIAL_MAX_MS);
		});

		it('leaves the pace alone without the predicate', async () => {
			const a = fakeHost('a');
			const ceiling = withCeiling(a);
			const h = harness([remoteOf('a')], { a });
			h.service.start();
			await settle();
			h.service.noteHostedAgentsChanged();
			expect(ceiling).not.toHaveBeenCalled();
		});
	});

	it('drops a remote that is deleted or opted out, and mirrors a newly opted-in one', async () => {
		const a = fakeHost('a');
		const b = fakeHost('b');
		const h = harness([remoteOf('a')], { a, b });
		h.service.start();
		await settle();
		h.setRemotes([remoteOf('a', { federation: false }), remoteOf('b')]);
		await settle();
		expect(h.types('a')).toContain('peer.removed');
		expect(a.close).toHaveBeenCalled();
		expect(a.lease.release).toHaveBeenCalled();
		expect(h.service.peers().map((p) => p.peerId)).toEqual(['b']);
		// Late events from the dropped client change nothing.
		a.emit({ type: 'agent.added', agent: agent('ghost') });
		expect(h.service.snapshot().peers.map((p) => p.peerId)).toEqual(['b']);
	});

	it('stop closes every client, drops every forward, forgets everything, and resets the windows', async () => {
		const a = fakeHost('a');
		const h = harness([remoteOf('a')], { a });
		h.service.start();
		await settle();
		await h.service.stop();
		expect(a.close).toHaveBeenCalled();
		expect(a.lease.release).toHaveBeenCalled();
		expect(h.deps.reset).toHaveBeenCalledTimes(1);
		expect(h.service.peers()).toEqual([]);
		// Stopped for good: a later start or wake does nothing.
		h.service.start();
		h.service.reloadAfterWake();
		await settle();
		expect(h.deps.acquireForward).toHaveBeenCalledTimes(1);
	});

	describe('host queues', () => {
		const waiting = (itemId: string, text = itemId): QueuedTurn => ({
			itemId,
			tabId: 't1',
			queuedAt: 1,
			kind: 'message',
			text,
			paused: false,
		});

		it('reads every agent queue once after the first attach', async () => {
			const a = fakeHost('a');
			a.setQueue('a-a1', [waiting('q1')]);
			const h = harness([remoteOf('a')], { a });
			h.service.start();
			await settle();
			// The snapshot inside connect() does not read too: the attach reads once.
			expect(a.queueList).toHaveBeenCalledTimes(1);
			expect(a.queueList).toHaveBeenCalledWith('a-a1');
			expect(h.service.snapshot().peers[0].queues).toEqual({ 'a-a1': [waiting('q1')] });
			expect(h.types('a')).toContain('agent.queue');
		});

		it('reads the queues again on a wake reload', async () => {
			const a = fakeHost('a');
			const h = harness([remoteOf('a')], { a });
			h.service.start();
			await settle();
			expect(h.service.snapshot().peers[0].queues).toEqual({});
			a.setAgents([agent('a-a1'), agent('a-a2')]);
			a.setQueue('a-a2', [waiting('q2')]);
			h.service.reloadAfterWake();
			await settle();
			expect(a.queueList).toHaveBeenCalledWith('a-a2');
			expect(h.service.snapshot().peers[0].queues).toEqual({ 'a-a2': [waiting('q2')] });
		});

		it('reads the queues again on a resync snapshot while attached', async () => {
			const a = fakeHost('a');
			const h = harness([remoteOf('a')], { a });
			h.service.start();
			await settle();
			a.setQueue('a-a1', [waiting('q1')]);
			a.emit({ type: 'snapshot', agents: [agent('a-a1')], groups: [] });
			await settle();
			expect(a.queueList).toHaveBeenCalledTimes(2);
			expect(h.service.snapshot().peers[0].queues).toEqual({ 'a-a1': [waiting('q1')] });
		});

		it('takes a queue.changed at once and drops an older read that lands after it', async () => {
			const a = fakeHost('a');
			const h = harness([remoteOf('a')], { a });
			h.service.start();
			await settle();
			let answer!: (value: { ok: true; value: QueuedTurn[] }) => void;
			a.queueList.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
			// A resync starts a read; the host's event lands while it is out.
			a.emit({ type: 'snapshot', agents: [agent('a-a1')], groups: [] });
			a.emit({ type: 'queue.changed', agentId: 'a-a1', items: [waiting('new')] });
			expect(h.service.snapshot().peers[0].queues).toEqual({ 'a-a1': [waiting('new')] });
			answer({ ok: true, value: [waiting('old')] });
			await settle();
			expect(h.service.snapshot().peers[0].queues).toEqual({ 'a-a1': [waiting('new')] });
		});

		it('counts a whole read whose answer a newer queue.changed replaced, as the gap it covered (M19)', async () => {
			const a = fakeHost('a');
			const h = harness([remoteOf('a')], { a });
			h.service.start();
			await settle();
			// A host that names exits: A (with an @mention) and B wait.
			a.emit({
				type: 'queue.changed',
				agentId: 'a-a1',
				items: [waiting('A'), waiting('B')],
				namesExits: true,
			});
			expect(h.service.snapshot().peers[0].queueReads?.['a-a1']).toBeUndefined();
			// The link drops; A starts unseen. The reconnect reads the queue whole, and while that
			// read is out B starts too: that change names only B.
			let answer!: (value: { ok: true; value: QueuedTurn[] }) => void;
			a.queueList.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
			a.emit({ type: 'snapshot', agents: [agent('a-a1')], groups: [] });
			a.emit({
				type: 'queue.changed',
				agentId: 'a-a1',
				items: [],
				exit: { itemId: 'B', exit: 'started' },
				namesExits: true,
			});
			h.pushes.splice(0);
			answer({ ok: true, value: [waiting('B')] });
			await settle();
			const peer = h.service.snapshot().peers[0];
			// The newer list stands, B's named start is kept, and the read is counted.
			expect(peer.queues).toEqual({});
			expect(peer.queueExits?.['a-a1']).toEqual([{ itemId: 'B', exit: 'started' }]);
			expect(peer.queueReads?.['a-a1']).toBe(1);
			// Every window counts it too: the push is a whole read (no `namesExits`).
			expect(h.pushes.map((p) => p.event)).toEqual([
				{ type: 'agent.queue', agentId: 'a-a1', items: [] },
			]);
		});

		it("gives an item a raced change said kept its images the read's images (M26, Greptile on #2160)", async () => {
			const a = fakeHost('a');
			const h = harness([remoteOf('a')], { a });
			h.service.start();
			await settle();
			let answer!: (value: { ok: true; value: QueuedTurn[] }) => void;
			a.queueList.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
			// A resync reads the queue; a desktop host's change lands meanwhile, sending no images for
			// an item it sent them for before this mirror attached.
			a.emit({ type: 'snapshot', agents: [agent('a-a1')], groups: [] });
			a.emit({
				type: 'queue.changed',
				agentId: 'a-a1',
				items: [{ ...waiting('img'), imagesKept: true }, waiting('new')],
				namesExits: true,
			});
			const images = ['data:image/png;base64,AAAA'];
			answer({ ok: true, value: [{ ...waiting('img'), images }] });
			await settle();
			expect(h.service.snapshot().peers[0].queues).toEqual({
				'a-a1': [{ ...waiting('img'), images }, waiting('new')],
			});
		});

		it('keeps what it held when a read fails', async () => {
			const a = fakeHost('a');
			a.setQueue('a-a1', [waiting('q1')]);
			const h = harness([remoteOf('a')], { a });
			h.service.start();
			await settle();
			a.queueList.mockResolvedValueOnce({
				ok: false,
				error: { code: 'host-lost', message: 'dropped', method: 'turns.queue.list' },
			} as never);
			a.emit({ type: 'snapshot', agents: [agent('a-a1')], groups: [] });
			await settle();
			expect(h.service.snapshot().peers[0].queues).toEqual({ 'a-a1': [waiting('q1')] });
		});
	});

	describe('history', () => {
		const ended = (host: FakeHost, agentId = 'a-a1', tabId = 't1') =>
			host.emit({
				type: 'turn',
				agentId,
				tabId,
				event: { kind: 'outcome', at: 5, outcome: 'completed' as never, exitCode: 0 },
			});

		it('reads an agent History once and serves the next read from the cache', async () => {
			const a = fakeHost('a');
			const h = harness([remoteOf('a')], { a });
			h.service.start();
			await settle();
			const first = await h.service.history('a', 'a-a1');
			expect(first.map((e) => e.id)).toEqual(['h1']);
			expect(a.historyList).toHaveBeenCalledWith('a-a1');
			expect((await h.service.history('a', 'a-a1')).map((e) => e.id)).toEqual(['h1']);
			expect(a.historyList).toHaveBeenCalledTimes(1);
		});

		// Parity round 3, N4: a turn sent from this machine carries its name on the host; here it
		// reads as a local entry (no host pill), as a local or SSH agent's own entry does.
		it("reads an entry stamped with this machine's name as local, and keeps another machine's", async () => {
			const a = fakeHost('a');
			a.historyList.mockResolvedValueOnce({
				ok: true,
				value: [
					{
						id: 'mine',
						type: 'USER',
						timestamp: 2,
						summary: 's',
						projectPath: '/p',
						hostname: 'laptop.local',
					},
					{
						id: 'theirs',
						type: 'USER',
						timestamp: 1,
						summary: 's',
						projectPath: '/p',
						hostname: 'desk.local',
					},
				],
			});
			const h = harness([remoteOf('a')], { a });
			h.deps.originHost = 'laptop.local';
			h.service.start();
			await settle();
			const entries = await h.service.history('a', 'a-a1');
			expect(entries.map((e) => [e.id, e.hostname])).toEqual([
				['mine', undefined],
				['theirs', 'desk.local'],
			]);
			expect('hostname' in entries[0]).toBe(false);
		});

		it('keeps a cache per agent and drops only the agent whose turn ended', async () => {
			const a = fakeHost('a');
			a.setAgents([agent('a-a1'), agent('a-a2')]);
			const h = harness([remoteOf('a')], { a });
			h.service.start();
			await settle();
			await h.service.history('a', 'a-a1');
			await h.service.history('a', 'a-a2');
			expect(a.historyList).toHaveBeenCalledTimes(2);
			ended(a, 'a-a1');
			await h.service.history('a', 'a-a1');
			await h.service.history('a', 'a-a2');
			expect(a.historyList).toHaveBeenCalledTimes(3);
			expect(a.historyList).toHaveBeenLastCalledWith('a-a1');
		});

		// L31: the host writes a turn's synopsis entry AFTER the turn's end, so the read the turn's
		// end let through fills the cache without it. The host says it wrote (`history.changed`).
		it("serves an entry the host writes after the turn's end on the next read, and tells the windows", async () => {
			const a = fakeHost('a');
			a.setAgents([agent('a-a1'), agent('a-a2')]);
			const h = harness([remoteOf('a')], { a });
			h.service.start();
			await settle();
			await h.service.history('a', 'a-a1');
			await h.service.history('a', 'a-a2');
			ended(a, 'a-a1');
			// The watch's first read after the end: the host has not written the synopsis yet.
			expect((await h.service.history('a', 'a-a1')).map((e) => e.id)).toEqual(['h3']);
			expect((await h.service.history('a', 'a-a1')).map((e) => e.id)).toEqual(['h3']);
			a.emit({ type: 'history.changed', agentId: 'a-a1' });
			// The windows hear of it once the merge wait is out (L34).
			h.flushTimers();
			expect(h.pushes.at(-1)).toEqual({
				peerId: 'a',
				event: { type: 'agent.history', agentId: 'a-a1' },
			});
			expect((await h.service.history('a', 'a-a1')).map((e) => e.id)).toEqual(['h4']);
			// Only that agent's list was dropped.
			expect((await h.service.history('a', 'a-a2')).map((e) => e.id)).toEqual(['h2']);
			expect(a.historyList).toHaveBeenCalledTimes(4);
			// An agent the peer does not have is no push.
			a.emit({ type: 'history.changed', agentId: 'nope' });
			h.flushTimers();
			expect(h.pushes.at(-1)?.event.type).toBe('agent.history');
			expect(h.pushes.filter((p) => p.event.type === 'agent.history')).toHaveLength(1);
		});

		// L34: a desktop host sends one write as `history:entryAdded` plus the 2 to 4 `fs.watch`
		// events macOS fires for it; each push made an open History panel read the whole list again.
		it('merges the History writes of one agent within the merge wait into one push', async () => {
			const timers: Array<{ cb: () => void; ms: number }> = [];
			const a = fakeHost('a');
			a.setAgents([agent('a-a1'), agent('a-a2')]);
			const h = harness(
				[remoteOf('a')],
				{ a },
				{
					setTimer: (cb, ms) => {
						timers.push({ cb, ms });
						return timers.length;
					},
				}
			);
			const fire = () => timers.splice(0).forEach(({ cb }) => cb());
			const historyPushes = () => h.pushes.filter((p) => p.event.type === 'agent.history');
			h.service.start();
			await settle();
			fire();
			await h.service.history('a', 'a-a1');
			for (let i = 0; i < 4; i++) a.emit({ type: 'history.changed', agentId: 'a-a1' });
			a.emit({ type: 'history.changed', agentId: 'a-a2' });
			expect(historyPushes()).toEqual([]);
			// One wait per agent, of the merge length.
			expect(timers.map((t) => t.ms)).toEqual([
				MIRROR_HISTORY_PUSH_MERGE_MS,
				MIRROR_HISTORY_PUSH_MERGE_MS,
			]);
			// Each write already dropped the list: a read inside the burst is fresh.
			expect((await h.service.history('a', 'a-a1')).map((e) => e.id)).toEqual(['h2']);
			fire();
			expect(historyPushes()).toEqual([
				{ peerId: 'a', event: { type: 'agent.history', agentId: 'a-a1' } },
				{ peerId: 'a', event: { type: 'agent.history', agentId: 'a-a2' } },
			]);
			// The list read inside the burst is dropped as the push leaves: the panel reads the end.
			expect((await h.service.history('a', 'a-a1')).map((e) => e.id)).toEqual(['h3']);
			expect(a.historyList).toHaveBeenCalledTimes(3);
			// A write after the push is a push of its own.
			a.emit({ type: 'history.changed', agentId: 'a-a1' });
			fire();
			expect(historyPushes()).toHaveLength(3);
		});

		// CodeRabbit on #2176: a push still waiting after a resync would tell the windows the build
		// it reached announces its writes, which an older build never does.
		it('drops a History push still waiting when the peer goes stale, and merges the next write anew', async () => {
			const timers: Array<() => void> = [];
			const clearTimer = vi.fn();
			const a = fakeHost('a');
			const h = harness(
				[remoteOf('a')],
				{ a },
				{
					setTimer: (cb) => {
						timers.push(cb);
						return timers.length;
					},
					clearTimer,
				}
			);
			const historyPushes = () => h.pushes.filter((p) => p.event.type === 'agent.history');
			h.service.start();
			await settle();
			timers.splice(0);
			a.emit({ type: 'history.changed', agentId: 'a-a1' });
			expect(timers).toHaveLength(1);
			h.service.reloadAfterWake();
			await settle();
			expect(h.types('a')).toContain('peer.stale');
			expect(clearTimer).toHaveBeenCalledWith(1);
			// Even a timer that runs anyway sends nothing.
			const waiting = timers.splice(0);
			waiting.forEach((cb) => cb());
			expect(historyPushes()).toEqual([]);
			a.emit({ type: 'history.changed', agentId: 'a-a1' });
			timers.splice(0).forEach((cb) => cb());
			expect(historyPushes()).toEqual([
				{ peerId: 'a', event: { type: 'agent.history', agentId: 'a-a1' } },
			]);
		});

		it('sends no merged History push for a peer dropped or a service stopped during the wait', async () => {
			const a = fakeHost('a');
			const b = fakeHost('b');
			const clearTimer = vi.fn();
			const h = harness([remoteOf('a'), remoteOf('b')], { a, b }, { clearTimer });
			h.service.start();
			await settle();
			h.flushTimers();
			a.emit({ type: 'history.changed', agentId: 'a-a1' });
			h.setRemotes([remoteOf('b')]);
			await settle();
			b.emit({ type: 'history.changed', agentId: 'b-a1' });
			await h.service.stop();
			h.flushTimers();
			expect(h.pushes.filter((p) => p.event.type === 'agent.history')).toEqual([]);
			// Both waits were cleared, not left to run.
			expect(clearTimer).toHaveBeenCalledTimes(2);
		});

		it('keeps a read from an older host that never says it wrote only briefly', async () => {
			let now = 1000;
			const a = fakeHost('a');
			const h = harness([remoteOf('a')], { a }, { now: () => now });
			h.service.start();
			await settle();
			await h.service.history('a', 'a-a1');
			now += MIRROR_UNANNOUNCED_HISTORY_TTL_MS - 1;
			expect((await h.service.history('a', 'a-a1')).map((e) => e.id)).toEqual(['h1']);
			now += 1;
			// The synopsis this host wrote after the turn's end, and never announced.
			expect((await h.service.history('a', 'a-a1')).map((e) => e.id)).toEqual(['h2']);
			expect(a.historyList).toHaveBeenCalledTimes(2);
		});

		it('keeps a read from a host that says it wrote until it says so again, and forgets that on a resync', async () => {
			let now = 1000;
			const a = fakeHost('a');
			const h = harness([remoteOf('a')], { a }, { now: () => now });
			h.service.start();
			await settle();
			a.emit({ type: 'history.changed', agentId: 'a-a1' });
			await h.service.history('a', 'a-a1');
			now += MIRROR_UNANNOUNCED_HISTORY_TTL_MS * 10;
			expect((await h.service.history('a', 'a-a1')).map((e) => e.id)).toEqual(['h1']);
			expect(a.historyList).toHaveBeenCalledTimes(1);
			// A connection that could not resume may have reached an older build: brief again.
			a.emit({ type: 'host.connected', host: { kind: 'headless', label: 'h' }, resumed: false });
			await h.service.history('a', 'a-a1');
			now += MIRROR_UNANNOUNCED_HISTORY_TTL_MS;
			await h.service.history('a', 'a-a1');
			expect(a.historyList).toHaveBeenCalledTimes(3);
		});

		it('drops an agent cache when the agent is removed', async () => {
			const a = fakeHost('a');
			const h = harness([remoteOf('a')], { a });
			h.service.start();
			await settle();
			await h.service.history('a', 'a-a1');
			a.emit({ type: 'agent.removed', agentId: 'a-a1' });
			await h.service.history('a', 'a-a1');
			expect(a.historyList).toHaveBeenCalledTimes(2);
		});

		it('drops the whole peer cache on a wake reload (peer.stale) and a resync snapshot', async () => {
			const a = fakeHost('a');
			a.setAgents([agent('a-a1'), agent('a-a2')]);
			const h = harness([remoteOf('a')], { a });
			h.service.start();
			await settle();
			await h.service.history('a', 'a-a1');
			await h.service.history('a', 'a-a2');
			h.service.reloadAfterWake();
			await settle();
			await h.service.history('a', 'a-a1');
			await h.service.history('a', 'a-a2');
			expect(a.historyList).toHaveBeenCalledTimes(4);
			a.emit({ type: 'snapshot', agents: [agent('a-a1'), agent('a-a2')], groups: [] });
			await settle();
			await h.service.history('a', 'a-a1');
			expect(a.historyList).toHaveBeenCalledTimes(5);
		});

		it('deletes and validates on the host, then reads the agent History again', async () => {
			const a = fakeHost('a');
			const h = harness([remoteOf('a')], { a });
			h.service.start();
			await settle();
			await h.service.history('a', 'a-a1');
			expect(await h.service.historyRemove('a', 'a-a1', 'h1')).toBe(true);
			expect(a.historyRemove).toHaveBeenCalledWith('a-a1', 'h1');
			expect(await h.service.historyUpdate('a', 'a-a1', 'h2', { validated: true })).toBe(true);
			expect(a.historyUpdate).toHaveBeenCalledWith('a-a1', 'h2', { validated: true });
			await h.service.history('a', 'a-a1');
			expect(a.historyList).toHaveBeenCalledTimes(2);
		});

		it('throws a refused edit with the peer named', async () => {
			const a = fakeHost('a');
			const h = harness([remoteOf('a')], { a });
			h.service.start();
			await settle();
			a.historyRemove.mockResolvedValueOnce({
				ok: false,
				error: { code: 'host-lost', message: 'Taken over.', method: 'history.remove' },
			} as never);
			await expect(h.service.historyRemove('a', 'a-a1', 'h1')).rejects.toThrow(
				'Peer "a": Taken over.'
			);
			await expect(
				h.service.historyUpdate('b', 'a-a1', 'h1', { validated: true })
			).rejects.toThrow();
		});

		it('does not keep a failed read: the next read asks the host again', async () => {
			const a = fakeHost('a');
			const h = harness([remoteOf('a')], { a });
			h.service.start();
			await settle();
			a.historyList.mockResolvedValueOnce({
				ok: false,
				error: { code: 'failed', message: 'no disk', method: 'history.list' },
			} as never);
			await expect(h.service.history('a', 'a-a1')).rejects.toThrow('Peer "a": no disk');
			await settle();
			expect((await h.service.history('a', 'a-a1')).map((e) => e.id)).toEqual(['h1']);
			expect(a.historyList).toHaveBeenCalledTimes(2);
		});

		it('forgets the cache when a remote is dropped and when the service stops', async () => {
			const a = fakeHost('a');
			const h = harness([remoteOf('a')], { a });
			h.service.start();
			await settle();
			await h.service.history('a', 'a-a1');
			h.setRemotes([remoteOf('a', { federation: false })]);
			await settle();
			await expect(h.service.history('a', 'a-a1')).rejects.toThrow(/Not a mirrored peer/);
			h.setRemotes([remoteOf('a')]);
			await settle();
			await h.service.history('a', 'a-a1');
			expect(a.historyList).toHaveBeenCalledTimes(2);
			await h.service.stop();
			await expect(h.service.history('a', 'a-a1')).rejects.toThrow(/Not a mirrored peer/);
		});

		it('refuses a peer that is not attached, naming it', async () => {
			const a = fakeHost('a', { manualReady: true });
			const h = harness([remoteOf('a')], { a });
			h.service.start();
			await settle();
			a.fail(new SshForwardError('not-installed', 'Install maestro-cli.'));
			await settle();
			await expect(h.service.history('a', 'a-a1')).rejects.toThrow(/Peer "a" is not connected/);
			expect(a.historyList).not.toHaveBeenCalled();
		});
	});

	describe('act', () => {
		/** Give the fake client the input calls `runPeerAgentAction()` makes. */
		function withInput(host: FakeHost) {
			const turns = {
				send: vi.fn(async () => ({ ok: true, value: { status: 'started' } })),
				interrupt: vi.fn(async () => ({ ok: true, value: { stopped: true } })),
				queue: {
					list: host.queueList,
					remove: vi.fn(async () => ({ ok: true, value: { removed: true } })),
					setPaused: vi.fn(async (_agentId: string, _itemId: string, paused: boolean) => ({
						ok: true,
						value: { found: true, paused },
					})),
				},
			};
			const tabs = host.client.tabs as unknown as Record<string, unknown>;
			tabs.create = vi.fn(async () => ({ ok: true, value: { tabId: 't-new' } }));
			tabs.rename = vi.fn(async () => ({ ok: true, value: undefined }));
			tabs.star = vi.fn(async () => ({ ok: true, value: undefined }));
			(host.client as unknown as Record<string, unknown>).turns = turns;
			return { turns, tabs };
		}

		// Parity R16 and R18: an act (an auto-retry's send too) on a peer whose forward waits out a
		// backoff dials at once and waits for that dial, as for a reconnect in progress.
		describe('on a peer whose forward is down (R16, R18)', () => {
			const down: SshForwardState = {
				status: 'down',
				error: new Error('ssh: connect refused'),
				attempt: 3,
				retryInMs: 240_000,
			};
			async function downedPeer() {
				const a = fakeHost('a');
				const h = harness([remoteOf('a')], { a }, { hostsAgents: () => false });
				const { turns } = withInput(a);
				h.service.start();
				await settle();
				(a.lease as unknown as { state: () => SshForwardState }).state = () => down;
				a.setState('disconnected' as ConnectionState);
				a.emitLease(down);
				expect(h.service.peers()[0].connection).toBe('lost');
				return { a, h, turns };
			}

			it('dials at once and sends once the dial attaches', async () => {
				const { a, h, turns } = await downedPeer();
				const answer = await h.service.act('a', 'a-a1', {
					kind: 'send',
					tabId: 't1',
					text: 'hi',
				} as never);
				expect(a.lease.restart).toHaveBeenCalledTimes(1);
				expect(a.reconnect).toHaveBeenCalled();
				expect(turns.send).toHaveBeenCalledTimes(1);
				expect(answer).toMatchObject({ ok: true });
				expect(h.service.peers()[0].connection).toBe('connected');
			});

			it('refuses with what the dial found when it fails, and sends nothing', async () => {
				const { a, h, turns } = await downedPeer();
				a.reconnect.mockResolvedValueOnce({
					ok: false,
					error: { code: 'not-running', message: 'No maestro-cli host is running.' },
				});
				const answer = await h.service.act('a', 'a-a1', {
					kind: 'send',
					tabId: 't1',
					text: 'hi',
				} as never);
				expect(a.lease.restart).toHaveBeenCalledTimes(1);
				expect(turns.send).not.toHaveBeenCalled();
				expect(answer).toMatchObject({ ok: false, notSent: true });
				expect((answer as { error: string }).error).toContain('No maestro-cli host is running.');
			});
		});

		it('runs each action on the held client of a connected peer', async () => {
			const a = fakeHost('a');
			const h = harness([remoteOf('a')], { a });
			const { turns, tabs } = withInput(a);
			h.service.start();
			await settle();

			expect(
				await h.service.act('a', 'a-a1', { kind: 'send', tabId: 't1', text: 'hello' })
			).toEqual({ ok: true, result: { kind: 'send', receipt: { status: 'started' } } });
			// The send names this machine, so the host's History entry says whose work it was.
			expect(turns.send).toHaveBeenCalledWith('a-a1', 't1', {
				text: 'hello',
				originHost: os.hostname(),
			});

			expect(await h.service.act('a', 'a-a1', { kind: 'new-tab' })).toEqual({
				ok: true,
				result: { kind: 'new-tab', tabId: 't-new' },
			});
			await h.service.act('a', 'a-a1', { kind: 'rename-tab', tabId: 't1', name: 'Plan' });
			expect(tabs.rename).toHaveBeenCalledWith('a-a1', 't1', 'Plan');
			await h.service.act('a', 'a-a1', { kind: 'star-tab', tabId: 't1', starred: true });
			expect(tabs.star).toHaveBeenCalledWith('a-a1', 't1', true);
			await h.service.act('a', 'a-a1', { kind: 'interrupt', tabId: 't1' });
			expect(turns.interrupt).toHaveBeenCalledWith('a-a1', 't1');
			// Input never dials: still the one forward from the connect.
			expect(h.deps.acquireForward).toHaveBeenCalledTimes(1);
		});

		it('removes, holds, and resumes a waiting message on the host', async () => {
			const a = fakeHost('a');
			const h = harness([remoteOf('a')], { a });
			const { turns } = withInput(a);
			h.service.start();
			await settle();
			expect(await h.service.act('a', 'a-a1', { kind: 'remove-queued', itemId: 'q1' })).toEqual({
				ok: true,
				result: { kind: 'remove-queued', itemId: 'q1', removed: true },
			});
			expect(turns.queue.remove).toHaveBeenCalledWith('a-a1', 'q1');
			expect(
				await h.service.act('a', 'a-a1', { kind: 'pause-queued', itemId: 'q2', paused: true })
			).toEqual({
				ok: true,
				result: { kind: 'pause-queued', itemId: 'q2', found: true, paused: true },
			});
			expect(turns.queue.setPaused).toHaveBeenCalledWith('a-a1', 'q2', true);
		});

		it('stamps a send with the injected originHost when one is given', async () => {
			const a = fakeHost('a');
			const h = harness([remoteOf('a')], { a });
			h.deps.originHost = 'laptop.local';
			const { turns } = withInput(a);
			h.service.start();
			await settle();
			await h.service.act('a', 'a-a1', { kind: 'send', tabId: 't1', text: 'hi' });
			expect(turns.send).toHaveBeenCalledWith('a-a1', 't1', {
				text: 'hi',
				originHost: 'laptop.local',
			});
		});

		it('refuses at once while the peer is not connected, and never queues the send', async () => {
			const a = fakeHost('a');
			const h = harness([remoteOf('a')], { a });
			const { turns } = withInput(a);
			h.service.start();
			await settle();
			a.emit({ type: 'host.lost', reason: 'socket closed' });
			const answer = await h.service.act('a', 'a-a1', { kind: 'send', tabId: 't1', text: 'hi' });
			// `notSent`: refused before the client saw it, so a caller may keep it for a retry.
			expect(answer).toMatchObject({ ok: false, code: 'host-unavailable', notSent: true });
			expect(answer.ok ? '' : answer.error).toContain('Nothing was sent');
			// Back up: the refused message is not delivered late.
			a.emit({ type: 'host.connected', host: { kind: 'headless', label: 'h' }, resumed: true });
			await settle();
			expect(turns.send).not.toHaveBeenCalled();
		});

		/** The host came back after discovery found none: the client is reconnecting, the old error kept. */
		function reconnectingAfterNoHost(a: FakeHost): void {
			a.emitLease({
				status: 'down',
				error: new SshForwardError('not-running', 'No maestro-cli host is running on a.'),
				attempt: 1,
				retryInMs: 1000,
			});
			a.emit({ type: 'host.reconnecting', attempt: 1, delayMs: 15_000 });
		}

		it('waits for a reconnect in progress and sends once the host is back (R3)', async () => {
			const a = fakeHost('a');
			const h = harness([remoteOf('a')], { a });
			const { turns } = withInput(a);
			h.service.start();
			await settle();
			reconnectingAfterNoHost(a);
			expect(h.service.peers()[0].connection).toBe('reconnecting');
			a.reconnect.mockImplementationOnce(async () => {
				a.setState('connected');
				a.emit({ type: 'host.connected', host: { kind: 'headless', label: 'h' }, resumed: true });
				return { ok: true, value: {} };
			});
			const answer = await h.service.act('a', 'a-a1', { kind: 'send', tabId: 't1', text: 'hi' });
			expect(answer).toEqual({
				ok: true,
				result: { kind: 'send', receipt: { status: 'started' } },
			});
			// Asked to try at once, not at the client's next backoff step; sent exactly once.
			expect(a.reconnect).toHaveBeenCalledTimes(1);
			expect(turns.send).toHaveBeenCalledTimes(1);
		});

		it('says the reconnect is still under way, never the old no-host error, when the wait runs out (R3)', async () => {
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			try {
				const a = fakeHost('a');
				const h = harness([remoteOf('a')], { a });
				const { turns } = withInput(a);
				h.service.start();
				await settle();
				reconnectingAfterNoHost(a);
				a.reconnect.mockImplementationOnce(() => new Promise(() => undefined));
				const pending = h.service.act('a', 'a-a1', { kind: 'send', tabId: 't1', text: 'hi' });
				await settle();
				vi.advanceTimersByTime(MIRROR_ACT_RECONNECT_WAIT_MS);
				const answer = await pending;
				expect(answer).toMatchObject({ ok: false, code: 'host-unavailable', notSent: true });
				const error = answer.ok ? '' : answer.error;
				expect(error).toBe('Still reconnecting to peer "a". Nothing was sent.');
				expect(error).not.toContain('No maestro-cli host is running');
				expect(turns.send).not.toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
			}
		});

		it('gives what discovery found when the reconnect tried for the send fails (R3)', async () => {
			const a = fakeHost('a');
			const h = harness([remoteOf('a')], { a });
			const { turns } = withInput(a);
			h.service.start();
			await settle();
			reconnectingAfterNoHost(a);
			a.reconnect.mockResolvedValueOnce({
				ok: false,
				error: {
					code: 'host-unavailable',
					message: 'No maestro-cli host is running on a.',
					method: 'connection.reconnect',
				},
			} as never);
			const answer = await h.service.act('a', 'a-a1', { kind: 'send', tabId: 't1', text: 'hi' });
			expect(answer).toMatchObject({ ok: false, code: 'host-unavailable', notSent: true });
			expect(answer.ok ? '' : answer.error).toBe(
				'Could not reconnect to peer "a". Nothing was sent. No maestro-cli host is running on a.'
			);
			expect(turns.send).not.toHaveBeenCalled();
		});

		// Parity R68: a host that starts after the first probe (discovery found none) is found by the
		// next explicit act, not by the slow re-probe; the acts in a burst share one probe.
		describe('on a remote whose discovery found no host (R68)', () => {
			/** A peer whose first probe found no host; `start()` makes the host answer from now on. */
			async function noHostPeer(extra: Partial<PeerMirrorServiceDeps> = {}) {
				const a = fakeHost('a', { manualReady: true });
				const h = harness([remoteOf('a')], { a }, { reprobeIntervalMs: 0, ...extra });
				const { turns } = withInput(a);
				h.service.start();
				await settle();
				a.fail(new SshForwardError('not-running', 'no host'));
				await settle();
				expect(h.service.peers()[0].connection).toBe('host-down');
				expect(h.deps.acquireForward).toHaveBeenCalledTimes(1);
				let answer!: (endpoint: typeof ENDPOINT) => void;
				const started = new Promise<typeof ENDPOINT>((resolve) => (answer = resolve));
				(a.lease as unknown as { ready: () => Promise<typeof ENDPOINT> }).ready = () => started;
				return { a, h, turns, start: () => answer(ENDPOINT) };
			}

			it('finds a host started after the first probe on the next send, and sends', async () => {
				const { h, turns, start } = await noHostPeer();
				const pending = h.service.act('a', 'a-a1', { kind: 'send', tabId: 't1', text: 'hi' });
				await settle();
				// The send ran discovery again at once and waits for it, never failing ahead of it.
				expect(h.deps.acquireForward).toHaveBeenCalledTimes(2);
				expect(h.service.peers()[0].connection).toBe('connecting');
				start();
				expect(await pending).toMatchObject({ ok: true });
				expect(turns.send).toHaveBeenCalledTimes(1);
				expect(h.service.peers()[0].connection).toBe('connected');
			});

			it("finds it on Try now: the kept message's resend probes again, as each auto-retry does", async () => {
				const { a, h, turns } = await noHostPeer();
				const lease = a.lease as unknown as { ready: () => Promise<typeof ENDPOINT> };
				lease.ready = () => Promise.reject(new SshForwardError('not-running', 'no host'));
				const first = await h.service.act('a', 'a-a1', { kind: 'send', tabId: 't1', text: 'hi' });
				expect(first).toMatchObject({ ok: false, notSent: true });
				// The host starts; the retry card's Try now sends the kept message again.
				lease.ready = () => Promise.resolve(ENDPOINT);
				const tryNow = await h.service.act('a', 'a-a1', { kind: 'send', tabId: 't1', text: 'hi' });
				expect(tryNow).toMatchObject({ ok: true });
				expect(turns.send).toHaveBeenCalledTimes(1);
				expect(h.deps.acquireForward).toHaveBeenCalledTimes(3);
			});

			it('shares one probe among ten sends in a burst and a Check Now beside them', async () => {
				const { h, turns, start } = await noHostPeer();
				const sends = Array.from({ length: 10 }, (_, i) =>
					h.service.act('a', 'a-a1', { kind: 'send', tabId: 't1', text: `m${i}` })
				);
				const checked = h.service.reconnect('a');
				await settle();
				expect(h.deps.acquireForward).toHaveBeenCalledTimes(2);
				start();
				const answers = await Promise.all(sends);
				expect(answers.every((answer) => answer.ok)).toBe(true);
				expect(await checked).toMatchObject({ ok: true });
				expect(turns.send).toHaveBeenCalledTimes(10);
				expect(h.deps.acquireForward).toHaveBeenCalledTimes(2);
			});

			it('says what the probe found when the host is still not there, and probes again on the next act', async () => {
				const { a, h, turns } = await noHostPeer();
				(a.lease as unknown as { ready: () => Promise<typeof ENDPOINT> }).ready = () =>
					Promise.reject(new SshForwardError('not-running', 'no host'));
				const answer = await h.service.act('a', 'a-a1', { kind: 'send', tabId: 't1', text: 'hi' });
				expect(answer).toMatchObject({ ok: false, code: 'host-unavailable', notSent: true });
				expect(answer.ok ? '' : answer.error).toMatch(
					/^Not connected to peer "a" \(host-down\)\. Nothing was sent\./
				);
				expect(h.deps.acquireForward).toHaveBeenCalledTimes(2);
				await h.service.act('a', 'a-a1', { kind: 'new-tab' });
				expect(h.deps.acquireForward).toHaveBeenCalledTimes(3);
				expect(turns.send).not.toHaveBeenCalled();
			});

			it('probes again for Move to Host (ensureLink) and lends the client it found', async () => {
				const { a, h, start } = await noHostPeer();
				const reached = h.service.ensureLink('a');
				await settle();
				start();
				await reached;
				expect(h.service.hostClient('a').client).toBe(a.client);
				expect(h.deps.acquireForward).toHaveBeenCalledTimes(2);
			});
		});

		it('names an unknown peer or agent, and passes a host failure through with the peer', async () => {
			const a = fakeHost('a');
			const h = harness([remoteOf('a')], { a });
			const { turns } = withInput(a);
			h.service.start();
			await settle();
			expect(await h.service.act('nope', 'x', { kind: 'new-tab' })).toMatchObject({ ok: false });
			expect(await h.service.act('a', 'ghost', { kind: 'new-tab' })).toEqual({
				ok: false,
				error: 'Peer "a" has no agent ghost.',
			});
			turns.send.mockResolvedValueOnce({
				ok: false,
				error: { code: 'host-lost', message: 'dropped', method: 'turns.send', unknown: true },
			} as never);
			const lost = await h.service.act('a', 'a-a1', { kind: 'send', tabId: 't1', text: 'x' });
			expect(lost).toMatchObject({ ok: false, unknown: true, code: 'host-lost' });
			expect(lost.ok ? '' : lost.error).toContain('The connection to peer "a" dropped');
		});
	});

	describe('opportunistic probing', () => {
		it('probes a remote with no host again on the slow re-probe, and leaves a connected one alone', async () => {
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			try {
				const a = fakeHost('a', { manualReady: true });
				const b = fakeHost('b');
				const h = harness([remoteOf('a'), remoteOf('b')], { a, b }, { reprobeIntervalMs: 1000 });
				h.service.start();
				await settle();
				a.fail(new SshForwardError('not-installed', 'Install maestro-cli.'));
				await settle();
				expect(h.service.peers().map((p) => p.connection)).toEqual(['not-installed', 'connected']);
				expect(h.deps.acquireForward).toHaveBeenCalledTimes(2);

				vi.advanceTimersByTime(1000);
				await settle();
				// Only the remote with no host was dialed again.
				expect(h.deps.acquireForward).toHaveBeenCalledTimes(3);
				expect(vi.mocked(h.deps.acquireForward).mock.calls[2][0].id).toBe('a');

				await h.service.stop();
				vi.advanceTimersByTime(5000);
				await settle();
				expect(h.deps.acquireForward).toHaveBeenCalledTimes(3);
			} finally {
				vi.useRealTimers();
			}
		});

		it('probes a remote with no host every 30 s while an agent here is hosted on it, and one that hosts nothing at the slow pace (R68)', async () => {
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			try {
				const a = fakeHost('a', { manualReady: true });
				const b = fakeHost('b', { manualReady: true });
				const h = harness(
					[remoteOf('a'), remoteOf('b')],
					{ a, b },
					{
						hostsAgents: (peerId) => peerId === 'a',
					}
				);
				h.service.start();
				await settle();
				a.fail(new SshForwardError('not-running', 'no host'));
				await settle();
				b.fail(new SshForwardError('not-running', 'no host'));
				await settle();
				expect(h.service.peers().map((p) => p.connection)).toEqual(['host-down', 'host-down']);
				const dialed = () =>
					vi.mocked(h.deps.acquireForward).mock.calls.map(([remote]) => remote.id);
				expect(dialed()).toEqual(['a', 'b']);

				vi.advanceTimersByTime(MIRROR_HOSTED_REPROBE_INTERVAL_MS);
				await settle();
				// Only the remote that hosts an agent of this machine was probed again.
				expect(dialed()).toEqual(['a', 'b', 'a']);
				vi.advanceTimersByTime(MIRROR_HOSTED_REPROBE_INTERVAL_MS);
				await settle();
				expect(dialed()).toEqual(['a', 'b', 'a', 'a']);

				vi.advanceTimersByTime(MIRROR_REPROBE_INTERVAL_MS - 2 * MIRROR_HOSTED_REPROBE_INTERVAL_MS);
				await settle();
				// The slow re-probe takes the remote that hosts nothing here (and the hosted one again).
				expect(dialed().filter((id) => id === 'b')).toHaveLength(2);
				await h.service.stop();
			} finally {
				vi.useRealTimers();
			}
		});

		it('runs an exclusive task after the dials queued before it, never beside one', async () => {
			const a = fakeHost('a', { manualReady: true });
			const h = harness([remoteOf('a')], { a }, { reprobeIntervalMs: 0 });
			h.service.start();
			const order: string[] = [];
			const task = h.service.exclusive(async () => {
				order.push(`task while ${h.service.peers()[0].connection}`);
				return 42;
			});
			await settle();
			expect(order).toEqual([]);
			a.open();
			expect(await task).toBe(42);
			expect(order).toEqual(['task while connected']);
			// A failing task does not wedge the queue.
			await expect(
				h.service.exclusive(async () => Promise.reject(new Error('boom')))
			).rejects.toThrow('boom');
			expect(await h.service.exclusive(async () => 'next')).toBe('next');
		});

		it('reconnects by SSH remote id, and names a remote it does not mirror', async () => {
			const a = fakeHost('a');
			const h = harness([remoteOf('a')], { a }, { reprobeIntervalMs: 0 });
			h.service.start();
			await settle();
			expect(await h.service.reconnectRemote('a')).toMatchObject({ ok: true });
			expect(await h.service.reconnectRemote('nope')).toEqual({
				ok: false,
				error: 'SSH remote nope is not a Federation peer.',
			});
		});
	});

	describe('hostClient', () => {
		it('lends the held client of a connected peer without dialing again', async () => {
			const a = fakeHost('a');
			const h = harness([remoteOf('a')], { a });
			h.service.start();
			await settle();
			const borrowed = h.service.hostClient('a');
			expect(borrowed.peer).toBe('a');
			expect(borrowed.client).toBe(a.client);
			expect(h.deps.acquireForward).toHaveBeenCalledTimes(1);
		});

		it('refuses a peer that is not connected, and a remote that is not mirrored', async () => {
			const a = fakeHost('a');
			const h = harness([remoteOf('a')], { a });
			h.service.start();
			await settle();
			a.emit({ type: 'host.lost', reason: 'socket closed' });
			expect(() => h.service.hostClient('a')).toThrow(/Not connected to peer "a".*Nothing moved/);
			expect(() => h.service.hostClient('ghost')).toThrow(/not a mirrored Federation peer/);
		});
	});
});
