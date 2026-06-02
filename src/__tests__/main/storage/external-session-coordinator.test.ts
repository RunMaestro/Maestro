/**
 * Tests for the ExternalSessionCoordinator (Remote Agent Visibility, Phase 4).
 *
 * SessionFileWatcher is MOCKED rather than driven through real files — this
 * keeps the tests focused on coordinator semantics (state-map transitions,
 * source annotation, debounce coalescing, lifecycle) and avoids the chokidar
 * timing flakiness that `session-file-watcher.test.ts` already covers with real
 * files. The mock is an EventEmitter, so tests synthesize `'append'`/`'create'`/
 * `'idle'` events by emitting on the created watcher instances directly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Shared mutable state the mock pushes into, surfaced via vi.hoisted so both the
// vi.mock factory (hoisted to the top) and the test bodies can reach it.
const hoisted = vi.hoisted(() => ({
	createdWatchers: [] as Array<{
		agentId: string;
		storageDir: string;
		emit: (event: string, ...args: unknown[]) => boolean;
		on: (event: string, listener: (...args: unknown[]) => void) => unknown;
		start: ReturnType<typeof vi.fn>;
		stop: ReturnType<typeof vi.fn>;
	}>,
	// Per-agent override for what `start()` should do (defaults to resolve).
	startBehavior: new Map<string, () => Promise<void>>(),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock('../../../main/storage/session-file-watcher', async () => {
	const { EventEmitter } = await import('events');
	class MockSessionFileWatcher extends EventEmitter {
		agentId: string;
		storageDir: string;
		fileMatcher: unknown;
		start = vi.fn(async () => {
			const behavior = hoisted.startBehavior.get(this.agentId);
			if (behavior) return behavior();
			return undefined;
		});
		stop = vi.fn(async () => undefined);
		constructor(config: { agentId: string; storageDir: string; fileMatcher: unknown }) {
			super();
			this.agentId = config.agentId;
			this.storageDir = config.storageDir;
			this.fileMatcher = config.fileMatcher;
			hoisted.createdWatchers.push(this as never);
		}
	}
	return { SessionFileWatcher: MockSessionFileWatcher };
});

import {
	ExternalSessionCoordinator,
	STATE_CHANGED_EVENT,
	type ExternalSessionStateChange,
	type WatchableStorage,
} from '../../../main/storage/external-session-coordinator';
import type { StorageWatchSpec } from '../../../main/storage/base-session-storage';
import type { SessionActivityEvent } from '../../../shared/sessionActivity';
import type { ToolType } from '../../../shared/types';

const DEBOUNCE_MS = 100;

/** Build a stub storage that returns the given watch spec. */
function makeStorage(
	agentId: string,
	spec: StorageWatchSpec | null = { rootDir: `/root/${agentId}`, fileMatcher: () => null }
): WatchableStorage {
	return {
		agentId: agentId as ToolType,
		getStorageWatchSpec: () => spec,
	};
}

/** Build a synthetic activity event. */
function makeEvent(overrides: Partial<SessionActivityEvent> = {}): SessionActivityEvent {
	return {
		agentId: 'claude-code' as ToolType,
		sessionId: 'sess-abc',
		projectPath: '/proj',
		lastActivityAt: 1000,
		source: 'external',
		sizeBytes: 100,
		...overrides,
	};
}

/** Fake ProcessManager surface — only findByAgentSessionId is used. */
function makeProcessManager(matches: Record<string, boolean> = {}) {
	return {
		findByAgentSessionId: vi.fn((agentSessionId: string) =>
			matches[agentSessionId] ? ({ sessionId: 'local' } as never) : undefined
		),
	};
}

beforeEach(() => {
	hoisted.createdWatchers.length = 0;
	hoisted.startBehavior.clear();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe('ExternalSessionCoordinator — start() / watcher construction', () => {
	it('constructs one watcher per non-null spec', async () => {
		const coordinator = new ExternalSessionCoordinator({
			processManager: makeProcessManager(),
			storageRegistry: {
				'claude-code': makeStorage('claude-code'),
				codex: makeStorage('codex'),
			},
		});
		await coordinator.start();
		expect(hoisted.createdWatchers).toHaveLength(2);
		expect(hoisted.createdWatchers.map((w) => w.agentId).sort()).toEqual(['claude-code', 'codex']);
		await coordinator.stop();
	});

	it('skips undefined storages in the registry', async () => {
		const coordinator = new ExternalSessionCoordinator({
			processManager: makeProcessManager(),
			storageRegistry: {
				'claude-code': makeStorage('claude-code'),
				codex: undefined,
			},
		});
		await coordinator.start();
		expect(hoisted.createdWatchers).toHaveLength(1);
		expect(hoisted.createdWatchers[0].agentId).toBe('claude-code');
		await coordinator.stop();
	});

	it('skips storages without a getStorageWatchSpec method', async () => {
		const coordinator = new ExternalSessionCoordinator({
			processManager: makeProcessManager(),
			storageRegistry: {
				'claude-code': makeStorage('claude-code'),
				codex: { agentId: 'codex' as ToolType }, // no getStorageWatchSpec
			},
		});
		await coordinator.start();
		expect(hoisted.createdWatchers).toHaveLength(1);
		await coordinator.stop();
	});

	it('skips storages whose spec is null', async () => {
		const coordinator = new ExternalSessionCoordinator({
			processManager: makeProcessManager(),
			storageRegistry: {
				'claude-code': makeStorage('claude-code'),
				codex: makeStorage('codex', null),
			},
		});
		await coordinator.start();
		expect(hoisted.createdWatchers).toHaveLength(1);
		expect(hoisted.createdWatchers[0].agentId).toBe('claude-code');
		await coordinator.stop();
	});

	it('skips storages whose spec function throws, and continues', async () => {
		const throwingStorage: WatchableStorage = {
			agentId: 'codex' as ToolType,
			getStorageWatchSpec: () => {
				throw new Error('boom');
			},
		};
		const coordinator = new ExternalSessionCoordinator({
			processManager: makeProcessManager(),
			storageRegistry: {
				codex: throwingStorage,
				'claude-code': makeStorage('claude-code'),
			},
		});
		await coordinator.start();
		expect(hoisted.createdWatchers).toHaveLength(1);
		expect(hoisted.createdWatchers[0].agentId).toBe('claude-code');
		await coordinator.stop();
	});

	it('survives a watcher start() rejection and still retains the other watcher', async () => {
		hoisted.startBehavior.set('claude-code', () => Promise.reject(new Error('chokidar exploded')));
		const coordinator = new ExternalSessionCoordinator({
			processManager: makeProcessManager(),
			storageRegistry: {
				'claude-code': makeStorage('claude-code'),
				codex: makeStorage('codex'),
			},
		});
		// Should not reject despite the first watcher failing to start.
		await expect(coordinator.start()).resolves.toBeUndefined();
		expect(hoisted.createdWatchers).toHaveLength(2);
		await coordinator.stop();
	});

	it('is idempotent — repeat start() does not construct more watchers', async () => {
		const coordinator = new ExternalSessionCoordinator({
			processManager: makeProcessManager(),
			storageRegistry: { 'claude-code': makeStorage('claude-code') },
		});
		await coordinator.start();
		await coordinator.start();
		expect(hoisted.createdWatchers).toHaveLength(1);
		await coordinator.stop();
	});
});

describe('ExternalSessionCoordinator — event routing & debounce', () => {
	async function startWithOneWatcher(matches: Record<string, boolean> = {}) {
		const coordinator = new ExternalSessionCoordinator({
			processManager: makeProcessManager(matches),
			storageRegistry: { 'claude-code': makeStorage('claude-code') },
		});
		await coordinator.start();
		return { coordinator, watcher: hoisted.createdWatchers[0] };
	}

	it("routes 'append' into the state map and emits state-changed after debounce", async () => {
		const { coordinator, watcher } = await startWithOneWatcher();
		const onChange = vi.fn();
		coordinator.on(STATE_CHANGED_EVENT, onChange);

		watcher.emit('append', makeEvent());
		expect(onChange).not.toHaveBeenCalled(); // not yet — debounced
		vi.advanceTimersByTime(DEBOUNCE_MS);

		expect(onChange).toHaveBeenCalledTimes(1);
		const payload = onChange.mock.calls[0][0] as ExternalSessionStateChange;
		expect(payload.events).toHaveLength(1);
		expect(payload.events[0].sessionId).toBe('sess-abc');
		await coordinator.stop();
	});

	it("routes 'create' into the state map and emits state-changed after debounce", async () => {
		const { coordinator, watcher } = await startWithOneWatcher();
		const onChange = vi.fn();
		coordinator.on(STATE_CHANGED_EVENT, onChange);

		watcher.emit('create', makeEvent({ sessionId: 'new-sess' }));
		vi.advanceTimersByTime(DEBOUNCE_MS);

		expect(onChange).toHaveBeenCalledTimes(1);
		const payload = onChange.mock.calls[0][0] as ExternalSessionStateChange;
		expect(payload.events[0].sessionId).toBe('new-sess');
		await coordinator.stop();
	});

	it('annotates source=local when ProcessManager knows the agent session id', async () => {
		const { coordinator, watcher } = await startWithOneWatcher({ 'sess-abc': true });
		const onChange = vi.fn();
		coordinator.on(STATE_CHANGED_EVENT, onChange);

		// Watcher claims external, but the ProcessManager match overrides it.
		watcher.emit('append', makeEvent({ source: 'external' }));
		vi.advanceTimersByTime(DEBOUNCE_MS);

		const payload = onChange.mock.calls[0][0] as ExternalSessionStateChange;
		expect(payload.events[0].source).toBe('local');
		await coordinator.stop();
	});

	it('annotates source=external when ProcessManager has no match', async () => {
		const { coordinator, watcher } = await startWithOneWatcher({});
		const onChange = vi.fn();
		coordinator.on(STATE_CHANGED_EVENT, onChange);

		watcher.emit('append', makeEvent());
		vi.advanceTimersByTime(DEBOUNCE_MS);

		const payload = onChange.mock.calls[0][0] as ExternalSessionStateChange;
		expect(payload.events[0].source).toBe('external');
		await coordinator.stop();
	});

	it('coalesces a burst into a single emission with the latest copy per key', async () => {
		const { coordinator, watcher } = await startWithOneWatcher();
		const onChange = vi.fn();
		coordinator.on(STATE_CHANGED_EVENT, onChange);

		watcher.emit('append', makeEvent({ lastActivityAt: 1000, sizeBytes: 10 }));
		watcher.emit('append', makeEvent({ lastActivityAt: 2000, sizeBytes: 20 }));
		watcher.emit('append', makeEvent({ lastActivityAt: 3000, sizeBytes: 30 }));
		watcher.emit('append', makeEvent({ lastActivityAt: 4000, sizeBytes: 40 }));
		vi.advanceTimersByTime(DEBOUNCE_MS);

		expect(onChange).toHaveBeenCalledTimes(1);
		const payload = onChange.mock.calls[0][0] as ExternalSessionStateChange;
		expect(payload.events).toHaveLength(1);
		expect(payload.events[0].sizeBytes).toBe(40); // latest wins
		await coordinator.stop();
	});

	it("'idle' deletes a tracked session and emits", async () => {
		const { coordinator, watcher } = await startWithOneWatcher();
		const onChange = vi.fn();
		coordinator.on(STATE_CHANGED_EVENT, onChange);

		watcher.emit('append', makeEvent());
		vi.advanceTimersByTime(DEBOUNCE_MS);
		expect(coordinator.getState().size).toBe(1);

		watcher.emit('idle', makeEvent());
		vi.advanceTimersByTime(DEBOUNCE_MS);

		expect(coordinator.getState().size).toBe(0);
		expect(onChange).toHaveBeenCalledTimes(2);
		expect((onChange.mock.calls[1][0] as ExternalSessionStateChange).events).toHaveLength(0);
		await coordinator.stop();
	});

	it("'idle' for an unknown session is silent", async () => {
		const { coordinator, watcher } = await startWithOneWatcher();
		const onChange = vi.fn();
		coordinator.on(STATE_CHANGED_EVENT, onChange);

		watcher.emit('idle', makeEvent({ sessionId: 'never-seen' }));
		vi.advanceTimersByTime(DEBOUNCE_MS);

		expect(onChange).not.toHaveBeenCalled();
		await coordinator.stop();
	});
});

describe('ExternalSessionCoordinator — getState & stop', () => {
	it('getState returns a defensive snapshot', async () => {
		const coordinator = new ExternalSessionCoordinator({
			processManager: makeProcessManager(),
			storageRegistry: { 'claude-code': makeStorage('claude-code') },
		});
		await coordinator.start();
		const watcher = hoisted.createdWatchers[0];
		watcher.emit('append', makeEvent());
		vi.advanceTimersByTime(DEBOUNCE_MS);

		const snapshot = coordinator.getState();
		snapshot.clear(); // mutate the copy
		expect(coordinator.getState().size).toBe(1); // internal state untouched
		await coordinator.stop();
	});

	it('stop() stops every watcher, clears state, and is safe to call twice', async () => {
		const coordinator = new ExternalSessionCoordinator({
			processManager: makeProcessManager(),
			storageRegistry: {
				'claude-code': makeStorage('claude-code'),
				codex: makeStorage('codex'),
			},
		});
		await coordinator.start();
		const [w1, w2] = hoisted.createdWatchers;
		w1.emit('append', makeEvent());
		vi.advanceTimersByTime(DEBOUNCE_MS);

		await coordinator.stop();
		expect(w1.stop).toHaveBeenCalledTimes(1);
		expect(w2.stop).toHaveBeenCalledTimes(1);
		expect(coordinator.getState().size).toBe(0);

		// Repeat stop is a no-op (watchers already spliced away).
		await expect(coordinator.stop()).resolves.toBeUndefined();
		expect(w1.stop).toHaveBeenCalledTimes(1);
	});

	it('stop() cancels a pending debounce so no late emission fires', async () => {
		const coordinator = new ExternalSessionCoordinator({
			processManager: makeProcessManager(),
			storageRegistry: { 'claude-code': makeStorage('claude-code') },
		});
		await coordinator.start();
		const watcher = hoisted.createdWatchers[0];
		const onChange = vi.fn();
		coordinator.on(STATE_CHANGED_EVENT, onChange);

		watcher.emit('append', makeEvent()); // arms the debounce timer
		await coordinator.stop(); // should cancel it
		vi.advanceTimersByTime(DEBOUNCE_MS);

		expect(onChange).not.toHaveBeenCalled();
	});
});
