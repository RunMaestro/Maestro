/**
 * Tests for usePeerMirrorBridge: the window side of the Federation peer mirror. Covers the zero
 * footprint while the Encore Feature is off, subscribe-before-snapshot with replay, the reset
 * push, the group chat exclusivity, and that nothing it receives reaches `sessionStore`.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePeerMirrorBridge } from '../../../../renderer/hooks/federation/usePeerMirrorBridge';
import { useGroupChatStore } from '../../../../renderer/stores/groupChatStore';
import { usePeerMirrorStore } from '../../../../renderer/stores/peerMirrorStore';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import {
	createMirroredPeer,
	replacePeerAgents,
	type MirroredPeer,
	type MirrorPush,
} from '../../../../shared/maestro-lib/client/peer-mirror';
import type { AgentRecord } from '../../../../shared/maestro-lib/store/records';
import { createMockSession, resetStores } from '../../../helpers';

const agent = (id: string): AgentRecord => ({
	id,
	name: id,
	toolType: 'claude-code',
	aiTabs: [{ id: 't1' }],
});

function peerWith(peerId: string, agents: AgentRecord[]): MirroredPeer {
	return {
		...replacePeerAgents(
			createMirroredPeer({ peerId, remoteId: `r-${peerId}`, name: peerId }),
			agents,
			[],
			1
		).peer,
		connection: 'connected',
	};
}

/** A stand-in for `window.maestro.federation` whose snapshot resolves when the test says so. */
function fakeApi() {
	const eventListeners = new Set<(push: MirrorPush) => void>();
	const resetListeners = new Set<() => void>();
	let resolveSnapshot!: (value: { peers: MirroredPeer[] }) => void;
	let rejectSnapshot!: (error: Error) => void;
	const snapshot = vi.fn(
		() =>
			new Promise<{ peers: MirroredPeer[] }>((resolve, reject) => {
				resolveSnapshot = resolve;
				rejectSnapshot = reject;
			})
	);
	const onEvent = vi.fn((listener: (push: MirrorPush) => void) => {
		eventListeners.add(listener);
		return () => eventListeners.delete(listener);
	});
	const onReset = vi.fn((listener: () => void) => {
		resetListeners.add(listener);
		return () => resetListeners.delete(listener);
	});
	return {
		api: {
			status: vi.fn(),
			peers: vi.fn(),
			snapshot,
			transcript: vi.fn(),
			reconnect: vi.fn(),
			onEvent,
			onReset,
		},
		emit: (push: MirrorPush) => eventListeners.forEach((l) => l(push)),
		emitReset: () => resetListeners.forEach((l) => l()),
		resolveSnapshot: (peers: MirroredPeer[]) => resolveSnapshot({ peers }),
		rejectSnapshot: (error: Error) => rejectSnapshot(error),
		listenerCount: () => eventListeners.size + resetListeners.size,
	};
}

const maestro = window.maestro as unknown as Record<string, unknown>;
const setFederation = (on: boolean) =>
	useSettingsStore.setState((s) => ({ encoreFeatures: { ...s.encoreFeatures, federation: on } }));
const flush = () => act(async () => undefined);

describe('usePeerMirrorBridge', () => {
	let fake: ReturnType<typeof fakeApi>;

	beforeEach(() => {
		resetStores(usePeerMirrorStore, useSessionStore, useSettingsStore, useGroupChatStore);
		fake = fakeApi();
		maestro.federation = fake.api;
	});

	afterEach(() => {
		delete maestro.federation;
	});

	it('does nothing at all while the Federation Encore Feature is off', () => {
		setFederation(false);
		renderHook(() => usePeerMirrorBridge());
		expect(fake.api.onEvent).not.toHaveBeenCalled();
		expect(fake.api.onReset).not.toHaveBeenCalled();
		expect(fake.api.snapshot).not.toHaveBeenCalled();
		expect(usePeerMirrorStore.getState()).toMatchObject({ enabled: false, order: [] });
	});

	it('subscribes before it loads the snapshot, then replays the pushes that came in between', async () => {
		setFederation(true);
		renderHook(() => usePeerMirrorBridge());
		expect(fake.api.onEvent.mock.invocationCallOrder[0]).toBeLessThan(
			fake.api.snapshot.mock.invocationCallOrder[0]
		);
		// A push while the snapshot is in flight is held, not applied to an empty store.
		fake.emit({ peerId: 'build', event: { type: 'agent.updated', agent: agent('a2') } });
		expect(usePeerMirrorStore.getState().enabled).toBe(false);

		fake.resolveSnapshot([peerWith('build', [agent('a1')])]);
		await flush();
		const state = usePeerMirrorStore.getState();
		expect(state.enabled).toBe(true);
		expect(state.peers.build.agents.map((a) => a.id)).toEqual(['a1', 'a2']);

		// Once replayed, pushes apply at once.
		act(() => fake.emit({ peerId: 'build', event: { type: 'agent.removed', agentId: 'a1' } }));
		expect(usePeerMirrorStore.getState().peers.build.agents.map((a) => a.id)).toEqual(['a2']);
	});

	it('still builds the mirror from pushes when the snapshot read fails', async () => {
		setFederation(true);
		renderHook(() => usePeerMirrorBridge());
		fake.rejectSnapshot(new Error('main went away'));
		await flush();
		expect(usePeerMirrorStore.getState()).toMatchObject({ enabled: true, order: [] });
	});

	it('empties the store on the reset push', async () => {
		setFederation(true);
		renderHook(() => usePeerMirrorBridge());
		fake.resolveSnapshot([peerWith('build', [agent('a1')])]);
		await flush();
		act(() => fake.emitReset());
		expect(usePeerMirrorStore.getState()).toMatchObject({ enabled: false, order: [], peers: {} });
	});

	it('turning the feature off unsubscribes and empties the store', async () => {
		setFederation(true);
		renderHook(() => usePeerMirrorBridge());
		fake.resolveSnapshot([peerWith('build', [agent('a1')])]);
		await flush();
		expect(fake.listenerCount()).toBe(2);
		act(() => setFederation(false));
		expect(fake.listenerCount()).toBe(0);
		expect(usePeerMirrorStore.getState()).toMatchObject({ enabled: false, order: [] });
	});

	it('unmounting unsubscribes and ignores a snapshot that lands afterwards', async () => {
		setFederation(true);
		const { unmount } = renderHook(() => usePeerMirrorBridge());
		unmount();
		expect(fake.listenerCount()).toBe(0);
		fake.resolveSnapshot([peerWith('build', [agent('a1')])]);
		await flush();
		expect(usePeerMirrorStore.getState().enabled).toBe(false);
	});

	it('leaves the mirror when a group chat opens', async () => {
		setFederation(true);
		renderHook(() => usePeerMirrorBridge());
		fake.resolveSnapshot([peerWith('build', [agent('a1')])]);
		await flush();
		act(() => usePeerMirrorStore.getState().selectMirroredAgent('build', 'a1'));
		expect(usePeerMirrorStore.getState().activeMirror?.key).toBe('build:a1');
		act(() => useGroupChatStore.setState({ activeGroupChatId: 'gc-1' }));
		expect(usePeerMirrorStore.getState().activeMirror).toBeNull();
	});

	it('never writes a mirrored agent into sessionStore', async () => {
		const local = createMockSession({ id: 'local-1' });
		useSessionStore.setState({ sessions: [local], activeSessionId: 'local-1' });
		const before = useSessionStore.getState();
		setFederation(true);
		renderHook(() => usePeerMirrorBridge());
		fake.resolveSnapshot([peerWith('build', [agent('a1')])]);
		await flush();
		act(() => {
			fake.emit({ peerId: 'build', event: { type: 'agent.updated', agent: agent('a2') } });
			fake.emit({
				peerId: 'build',
				event: {
					type: 'turn',
					agentId: 'a2',
					tabId: 't1',
					event: { kind: 'text', at: 1, text: 'x' },
				},
			});
			usePeerMirrorStore.getState().selectMirroredAgent('build', 'a2');
			fake.emitReset();
		});
		const after = useSessionStore.getState();
		expect(after.sessions).toBe(before.sessions);
		expect(after.activeSessionId).toBe('local-1');
	});
});
