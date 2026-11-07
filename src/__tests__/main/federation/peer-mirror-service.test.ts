/**
 * Tests for the desktop's peer mirror service: sequential connects, failures as peer state,
 * event pushes with turn coalescing, reconcile on remote edits, wake reload, reconnect, stop, and
 * `act()`, the input path to a mirrored agent, and `hostClient()`, the client Move to Host borrows
 * (FED-SSH-06).
 * The SSH forward and the host client are stood in for; nothing here dials.
 */

import { describe, expect, it, vi } from 'vitest';
import {
	MIRROR_TURN_COALESCE_MS,
	PeerMirrorService,
	type PeerMirrorServiceDeps,
} from '../../../main/federation/peer-mirror-service';
import type { MirrorPush } from '../../../shared/maestro-lib/client/peer-mirror';
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
	const close = vi.fn(async () => undefined);
	const client = {
		connection: { connect, reconnect, close, state: () => state },
		agents: { list },
		groups: { list: vi.fn(async () => ({ ok: true, value: [] })) },
		tabs: { transcript },
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
		close,
		open: () => resolveReady(ENDPOINT),
		fail: (error) => rejectReady(error),
	};
}

function harness(remotes: SshRemoteConfig[], hosts: Record<string, FakeHost>) {
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
	it('mirrors only opted-in remotes and connects them strictly one after another', async () => {
		const a = fakeHost('a', { manualReady: true });
		const b = fakeHost('b', { manualReady: true });
		const off = fakeHost('off');
		const h = harness([remoteOf('a'), remoteOf('off', { federation: false }), remoteOf('b')], {
			a,
			b,
			off,
		});
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
		expect(MIRROR_TURN_COALESCE_MS).toBe(50);

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

	describe('act', () => {
		/** Give the fake client the input calls `runPeerAgentAction()` makes. */
		function withInput(host: FakeHost) {
			const turns = {
				send: vi.fn(async () => ({ ok: true, value: { status: 'started' } })),
				interrupt: vi.fn(async () => ({ ok: true, value: { stopped: true } })),
			};
			const tabs = host.client.tabs as unknown as Record<string, unknown>;
			tabs.create = vi.fn(async () => ({ ok: true, value: { tabId: 't-new' } }));
			tabs.rename = vi.fn(async () => ({ ok: true, value: undefined }));
			tabs.star = vi.fn(async () => ({ ok: true, value: undefined }));
			(host.client as unknown as Record<string, unknown>).turns = turns;
			return { turns, tabs };
		}

		it('runs each action on the held client of a connected peer', async () => {
			const a = fakeHost('a');
			const h = harness([remoteOf('a')], { a });
			const { turns, tabs } = withInput(a);
			h.service.start();
			await settle();

			expect(
				await h.service.act('a', 'a-a1', { kind: 'send', tabId: 't1', text: 'hello' })
			).toEqual({ ok: true, result: { kind: 'send', receipt: { status: 'started' } } });
			expect(turns.send).toHaveBeenCalledWith('a-a1', 't1', { text: 'hello' });

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

		it('refuses at once while the peer is not connected, and never queues the send', async () => {
			const a = fakeHost('a');
			const h = harness([remoteOf('a')], { a });
			const { turns } = withInput(a);
			h.service.start();
			await settle();
			a.emit({ type: 'host.lost', reason: 'socket closed' });
			const answer = await h.service.act('a', 'a-a1', { kind: 'send', tabId: 't1', text: 'hi' });
			expect(answer).toMatchObject({ ok: false });
			expect(answer.ok ? '' : answer.error).toContain('Nothing was sent');
			// Back up: the refused message is not delivered late.
			a.emit({ type: 'host.connected', host: { kind: 'headless', label: 'h' }, resumed: true });
			await settle();
			expect(turns.send).not.toHaveBeenCalled();
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
			expect(lost).toMatchObject({ ok: false, unknown: true });
			expect(lost.ok ? '' : lost.error).toContain('The connection to peer "a" dropped');
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
