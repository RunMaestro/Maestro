/**
 * Tests for ExternalSessionCoordinator — the single owner of on-disk session
 * watchers that folds per-agent activity into one coalesced state stream and
 * stamps each event with `source: 'local' | 'external'` based on whether
 * ProcessManager is already driving the same agent-native sessionId.
 *
 * SessionFileWatcher is mocked so we can drive synthetic 'create' / 'append' /
 * 'idle' events directly. Tests focus on:
 *  - boot-time watcher construction (one per non-null spec, tolerant of
 *    missing storages / null specs / start() failures)
 *  - event routing into the internal state map
 *  - source annotation via ProcessManager.findByAgentSessionId
 *  - 100ms debounce coalescing of bursts into a single 'state-changed' emit
 *  - idle removal + stop() cleanup semantics
 */

import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { ToolType } from '../../../shared/types';
import type { AgentSessionStorage } from '../../../main/agents';
import type { SessionActivityEvent } from '../../../shared/sessionActivity';
import type { StorageWatchSpec } from '../../../main/storage/base-session-storage';
import type { ProcessManager } from '../../../main/process-manager';
import type { ManagedProcess } from '../../../main/process-manager/types';

// --- mock SessionFileWatcher -------------------------------------------------

interface FakeWatcherOptions {
	agentId: ToolType;
	storageDir: string;
	fileMatcher: StorageWatchSpec['fileMatcher'];
}

interface FakeWatcher extends EventEmitter {
	agentId: ToolType;
	storageDir: string;
	fileMatcher: StorageWatchSpec['fileMatcher'];
	start: ReturnType<typeof vi.fn>;
	stop: ReturnType<typeof vi.fn>;
}

// `vi.hoisted` runs before `vi.mock` factories, which themselves are hoisted
// to the top of the file. This is the only way to share mutable state between
// the mocked module and the test body without tripping the no-top-level-vars
// guard inside `vi.mock`.
const mockState = vi.hoisted(() => {
	return {
		createdWatchers: [] as FakeWatcher[],
	};
});

vi.mock('../../../main/storage/session-file-watcher', async () => {
	const { EventEmitter: EE } = await import('events');
	const { vi: viInner } = await import('vitest');
	class FakeSessionFileWatcher extends EE {
		agentId: ToolType;
		storageDir: string;
		fileMatcher: StorageWatchSpec['fileMatcher'];
		start = viInner.fn(async () => {});
		stop = viInner.fn(async () => {});

		constructor(options: FakeWatcherOptions) {
			super();
			this.agentId = options.agentId;
			this.storageDir = options.storageDir;
			this.fileMatcher = options.fileMatcher;
			mockState.createdWatchers.push(this as unknown as FakeWatcher);
		}
	}
	return { SessionFileWatcher: FakeSessionFileWatcher };
});

const createdWatchers = mockState.createdWatchers;

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

// Imported after vi.mock so the coordinator picks up the mocked watcher.
import {
	ExternalSessionCoordinator,
	STATE_CHANGED_EVENT,
	STATE_CHANGE_DEBOUNCE_MS,
	type ExternalSessionStateChange,
} from '../../../main/storage/external-session-coordinator';

// --- test helpers ------------------------------------------------------------

function makeSpec(rootDir: string): StorageWatchSpec {
	return {
		rootDir,
		fileMatcher: (rel: string) => ({ sessionId: rel, projectPath: '' }),
	};
}

interface StubStorageOptions {
	agentId: ToolType;
	spec: StorageWatchSpec | null;
	throwsFromSpec?: boolean;
	omitSpecFn?: boolean;
}

/**
 * Build a minimal AgentSessionStorage stub that exposes only what the
 * coordinator reads from it (`getStorageWatchSpec`). All other methods are
 * cast through `unknown` because the coordinator never touches them.
 */
function makeStorageStub(options: StubStorageOptions): AgentSessionStorage {
	const stub: Partial<AgentSessionStorage> & {
		getStorageWatchSpec?: () => StorageWatchSpec | null;
	} = { agentId: options.agentId };

	if (!options.omitSpecFn) {
		stub.getStorageWatchSpec = () => {
			if (options.throwsFromSpec) throw new Error('boom');
			return options.spec;
		};
	}

	return stub as AgentSessionStorage;
}

function makeProcessManager(
	overrides: Partial<Pick<ProcessManager, 'findByAgentSessionId'>> = {}
): ProcessManager {
	const fake = {
		findByAgentSessionId: vi.fn(() => undefined),
		...overrides,
	};
	return fake as unknown as ProcessManager;
}

function activityEvent(
	overrides: Partial<SessionActivityEvent> & { sessionId: string }
): SessionActivityEvent {
	return {
		agentId: 'claude-code',
		projectPath: 'proj',
		lastActivityAt: Date.now(),
		source: 'external',
		sizeBytes: 0,
		...overrides,
	};
}

async function flushMicrotasks(): Promise<void> {
	// Two passes drain promise.then callbacks queued from within the
	// coordinator's await watcher.start() loop without depending on real time.
	await Promise.resolve();
	await Promise.resolve();
}

// --- tests -------------------------------------------------------------------

describe('ExternalSessionCoordinator', () => {
	beforeEach(() => {
		createdWatchers.length = 0;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	describe('start()', () => {
		it('instantiates one watcher per storage with a non-null spec', async () => {
			const claudeStorage = makeStorageStub({
				agentId: 'claude-code',
				spec: makeSpec('/tmp/claude'),
			});
			const codexStorage = makeStorageStub({
				agentId: 'codex',
				spec: makeSpec('/tmp/codex'),
			});

			const coordinator = new ExternalSessionCoordinator({
				processManager: makeProcessManager(),
				storageRegistry: { 'claude-code': claudeStorage, codex: codexStorage },
			});

			await coordinator.start();

			expect(createdWatchers).toHaveLength(2);
			expect(new Set(createdWatchers.map((w) => w.agentId))).toEqual(
				new Set(['claude-code', 'codex'])
			);
			expect(createdWatchers.every((w) => w.start.mock.calls.length === 1)).toBe(true);

			await coordinator.stop();
		});

		it('skips undefined storages and storages without a getStorageWatchSpec method', async () => {
			const claudeStorage = makeStorageStub({
				agentId: 'claude-code',
				spec: makeSpec('/tmp/claude'),
			});
			const legacyStorage = makeStorageStub({
				agentId: 'opencode',
				spec: null,
				omitSpecFn: true,
			});

			const coordinator = new ExternalSessionCoordinator({
				processManager: makeProcessManager(),
				storageRegistry: {
					'claude-code': claudeStorage,
					opencode: legacyStorage,
					codex: undefined,
				},
			});

			await coordinator.start();

			expect(createdWatchers).toHaveLength(1);
			expect(createdWatchers[0].agentId).toBe('claude-code');

			await coordinator.stop();
		});

		it('skips storages whose getStorageWatchSpec() returns null', async () => {
			const claudeStorage = makeStorageStub({
				agentId: 'claude-code',
				spec: makeSpec('/tmp/claude'),
			});
			const codexStorage = makeStorageStub({ agentId: 'codex', spec: null });

			const coordinator = new ExternalSessionCoordinator({
				processManager: makeProcessManager(),
				storageRegistry: { 'claude-code': claudeStorage, codex: codexStorage },
			});

			await coordinator.start();

			expect(createdWatchers).toHaveLength(1);
			expect(createdWatchers[0].agentId).toBe('claude-code');

			await coordinator.stop();
		});

		it('does not throw when getStorageWatchSpec() throws — just skips that storage', async () => {
			const claudeStorage = makeStorageStub({
				agentId: 'claude-code',
				spec: makeSpec('/tmp/claude'),
			});
			const badStorage = makeStorageStub({
				agentId: 'codex',
				spec: null,
				throwsFromSpec: true,
			});

			const coordinator = new ExternalSessionCoordinator({
				processManager: makeProcessManager(),
				storageRegistry: { 'claude-code': claudeStorage, codex: badStorage },
			});

			await expect(coordinator.start()).resolves.toBeUndefined();
			expect(createdWatchers).toHaveLength(1);
			expect(createdWatchers[0].agentId).toBe('claude-code');

			await coordinator.stop();
		});

		it('tolerates per-watcher start() failures (logs and skips, does not throw)', async () => {
			// Make the first watcher's start() reject; the coordinator's per-storage
			// loop awaits start() right after construction, so we wait for the first
			// FakeWatcher to appear and rewrite its start() before the await yields.
			// Simpler approach: a getter on the registry returns a stub that, when
			// the coordinator constructs its watcher, the next push gets its start
			// swapped out. We do this by polling synchronously after start() is invoked.
			const claudeStorage = makeStorageStub({
				agentId: 'claude-code',
				spec: makeSpec('/tmp/claude'),
			});
			const codexStorage = makeStorageStub({
				agentId: 'codex',
				spec: makeSpec('/tmp/codex'),
			});

			const coordinator = new ExternalSessionCoordinator({
				processManager: makeProcessManager(),
				storageRegistry: { 'claude-code': claudeStorage, codex: codexStorage },
			});

			// Patch the prototype so the FIRST watcher's start() rejects. Cast to
			// `any` because prototype-level overrides require erasing the readonly
			// instance-field type that vitest infers.
			const ctor = (await import('../../../main/storage/session-file-watcher'))
				.SessionFileWatcher as unknown as new (options: FakeWatcherOptions) => FakeWatcher;
			const proto = ctor.prototype as unknown as Record<string, unknown>;
			const originalStart = proto.start;
			let callCount = 0;
			proto.start = vi.fn(async () => {
				callCount += 1;
				if (callCount === 1) throw new Error('chokidar exploded');
			});

			try {
				await expect(coordinator.start()).resolves.toBeUndefined();
				expect(createdWatchers).toHaveLength(2);
				await expect(coordinator.stop()).resolves.toBeUndefined();
			} finally {
				proto.start = originalStart;
			}
		});

		it('is idempotent — a second start() does not re-instantiate watchers', async () => {
			const claudeStorage = makeStorageStub({
				agentId: 'claude-code',
				spec: makeSpec('/tmp/claude'),
			});

			const coordinator = new ExternalSessionCoordinator({
				processManager: makeProcessManager(),
				storageRegistry: { 'claude-code': claudeStorage },
			});

			await coordinator.start();
			await coordinator.start();

			expect(createdWatchers).toHaveLength(1);

			await coordinator.stop();
		});
	});

	describe('event handling', () => {
		it('emits state-changed after the debounce window on append', async () => {
			vi.useFakeTimers();
			const coordinator = new ExternalSessionCoordinator({
				processManager: makeProcessManager(),
				storageRegistry: {
					'claude-code': makeStorageStub({
						agentId: 'claude-code',
						spec: makeSpec('/tmp/claude'),
					}),
				},
			});
			await coordinator.start();
			await flushMicrotasks();

			const listener = vi.fn();
			coordinator.on(STATE_CHANGED_EVENT, listener);

			createdWatchers[0].emit('append', activityEvent({ sessionId: 'sess-1' }));

			// Listener not invoked synchronously — coalesced through the timer.
			expect(listener).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(STATE_CHANGE_DEBOUNCE_MS + 1);

			expect(listener).toHaveBeenCalledTimes(1);
			const payload = listener.mock.calls[0][0] as ExternalSessionStateChange;
			expect(payload.events).toHaveLength(1);
			expect(payload.events[0].sessionId).toBe('sess-1');

			await coordinator.stop();
		});

		it('emits state-changed on create the same way as append', async () => {
			vi.useFakeTimers();
			const coordinator = new ExternalSessionCoordinator({
				processManager: makeProcessManager(),
				storageRegistry: {
					'claude-code': makeStorageStub({
						agentId: 'claude-code',
						spec: makeSpec('/tmp/claude'),
					}),
				},
			});
			await coordinator.start();
			await flushMicrotasks();

			const listener = vi.fn();
			coordinator.on(STATE_CHANGED_EVENT, listener);

			createdWatchers[0].emit('create', activityEvent({ sessionId: 'sess-new' }));
			await vi.advanceTimersByTimeAsync(STATE_CHANGE_DEBOUNCE_MS + 1);

			expect(listener).toHaveBeenCalledTimes(1);
			const payload = listener.mock.calls[0][0] as ExternalSessionStateChange;
			expect(payload.events.map((e) => e.sessionId)).toEqual(['sess-new']);

			await coordinator.stop();
		});

		it("annotates source as 'local' when ProcessManager has a matching agentSessionId", async () => {
			vi.useFakeTimers();
			const local = {
				sessionId: 'local-internal-id',
				agentSessionId: 'sess-local',
			} as ManagedProcess;
			const processManager = makeProcessManager({
				findByAgentSessionId: vi.fn((id: string) => (id === 'sess-local' ? local : undefined)),
			});
			const coordinator = new ExternalSessionCoordinator({
				processManager,
				storageRegistry: {
					'claude-code': makeStorageStub({
						agentId: 'claude-code',
						spec: makeSpec('/tmp/claude'),
					}),
				},
			});
			await coordinator.start();
			await flushMicrotasks();

			const listener = vi.fn();
			coordinator.on(STATE_CHANGED_EVENT, listener);

			createdWatchers[0].emit(
				'append',
				activityEvent({ sessionId: 'sess-local', source: 'external' })
			);
			await vi.advanceTimersByTimeAsync(STATE_CHANGE_DEBOUNCE_MS + 1);

			const payload = listener.mock.calls[0][0] as ExternalSessionStateChange;
			expect(payload.events).toHaveLength(1);
			expect(payload.events[0].source).toBe('local');
			expect(processManager.findByAgentSessionId).toHaveBeenCalledWith('sess-local');

			await coordinator.stop();
		});

		it("annotates source as 'external' when ProcessManager has no matching session", async () => {
			vi.useFakeTimers();
			const processManager = makeProcessManager({
				findByAgentSessionId: vi.fn(() => undefined),
			});
			const coordinator = new ExternalSessionCoordinator({
				processManager,
				storageRegistry: {
					'claude-code': makeStorageStub({
						agentId: 'claude-code',
						spec: makeSpec('/tmp/claude'),
					}),
				},
			});
			await coordinator.start();
			await flushMicrotasks();

			const listener = vi.fn();
			coordinator.on(STATE_CHANGED_EVENT, listener);

			// Send in a payload with source already set to 'local' to prove the
			// coordinator rewrites it based on the live processManager lookup,
			// not on whatever the watcher claimed.
			createdWatchers[0].emit(
				'append',
				activityEvent({ sessionId: 'sess-remote', source: 'local' })
			);
			await vi.advanceTimersByTimeAsync(STATE_CHANGE_DEBOUNCE_MS + 1);

			const payload = listener.mock.calls[0][0] as ExternalSessionStateChange;
			expect(payload.events[0].source).toBe('external');

			await coordinator.stop();
		});

		it('coalesces a burst of events within the debounce window into one emission', async () => {
			vi.useFakeTimers();
			const coordinator = new ExternalSessionCoordinator({
				processManager: makeProcessManager(),
				storageRegistry: {
					'claude-code': makeStorageStub({
						agentId: 'claude-code',
						spec: makeSpec('/tmp/claude'),
					}),
				},
			});
			await coordinator.start();
			await flushMicrotasks();

			const listener = vi.fn();
			coordinator.on(STATE_CHANGED_EVENT, listener);

			const watcher = createdWatchers[0];
			watcher.emit('create', activityEvent({ sessionId: 'a', sizeBytes: 1 }));
			watcher.emit('append', activityEvent({ sessionId: 'a', sizeBytes: 2 }));
			watcher.emit('append', activityEvent({ sessionId: 'b', sizeBytes: 1 }));
			watcher.emit('append', activityEvent({ sessionId: 'a', sizeBytes: 3 }));

			// Inside the debounce window — still no fire.
			await vi.advanceTimersByTimeAsync(STATE_CHANGE_DEBOUNCE_MS - 1);
			expect(listener).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(2);
			expect(listener).toHaveBeenCalledTimes(1);

			const payload = listener.mock.calls[0][0] as ExternalSessionStateChange;
			const byId = new Map(payload.events.map((e) => [e.sessionId, e]));
			expect(byId.size).toBe(2);
			// Latest write for 'a' (sizeBytes 3) should have won — the map keeps the
			// most recent annotated event per key.
			expect(byId.get('a')?.sizeBytes).toBe(3);
			expect(byId.get('b')?.sizeBytes).toBe(1);

			await coordinator.stop();
		});

		it('removes the entry on idle and emits state-changed reflecting the deletion', async () => {
			vi.useFakeTimers();
			const coordinator = new ExternalSessionCoordinator({
				processManager: makeProcessManager(),
				storageRegistry: {
					'claude-code': makeStorageStub({
						agentId: 'claude-code',
						spec: makeSpec('/tmp/claude'),
					}),
				},
			});
			await coordinator.start();
			await flushMicrotasks();

			const watcher = createdWatchers[0];
			watcher.emit('append', activityEvent({ sessionId: 'sess-1' }));
			await vi.advanceTimersByTimeAsync(STATE_CHANGE_DEBOUNCE_MS + 1);
			expect(coordinator.getState().size).toBe(1);

			const listener = vi.fn();
			coordinator.on(STATE_CHANGED_EVENT, listener);

			watcher.emit('idle', activityEvent({ sessionId: 'sess-1' }));
			await vi.advanceTimersByTimeAsync(STATE_CHANGE_DEBOUNCE_MS + 1);

			expect(listener).toHaveBeenCalledTimes(1);
			const payload = listener.mock.calls[0][0] as ExternalSessionStateChange;
			expect(payload.events).toHaveLength(0);
			expect(coordinator.getState().size).toBe(0);

			await coordinator.stop();
		});

		it('idle for an unknown session is a silent no-op (no state-changed emitted)', async () => {
			vi.useFakeTimers();
			const coordinator = new ExternalSessionCoordinator({
				processManager: makeProcessManager(),
				storageRegistry: {
					'claude-code': makeStorageStub({
						agentId: 'claude-code',
						spec: makeSpec('/tmp/claude'),
					}),
				},
			});
			await coordinator.start();
			await flushMicrotasks();

			const listener = vi.fn();
			coordinator.on(STATE_CHANGED_EVENT, listener);

			createdWatchers[0].emit('idle', activityEvent({ sessionId: 'ghost' }));
			await vi.advanceTimersByTimeAsync(STATE_CHANGE_DEBOUNCE_MS + 1);

			expect(listener).not.toHaveBeenCalled();
			expect(coordinator.getState().size).toBe(0);

			await coordinator.stop();
		});
	});

	describe('getState()', () => {
		it('returns a defensive snapshot — mutating the result does not affect internal state', async () => {
			vi.useFakeTimers();
			const coordinator = new ExternalSessionCoordinator({
				processManager: makeProcessManager(),
				storageRegistry: {
					'claude-code': makeStorageStub({
						agentId: 'claude-code',
						spec: makeSpec('/tmp/claude'),
					}),
				},
			});
			await coordinator.start();
			await flushMicrotasks();

			createdWatchers[0].emit('append', activityEvent({ sessionId: 'sess-1' }));
			await vi.advanceTimersByTimeAsync(STATE_CHANGE_DEBOUNCE_MS + 1);

			const snapshot = coordinator.getState();
			expect(snapshot.size).toBe(1);
			snapshot.clear();
			expect(coordinator.getState().size).toBe(1);

			await coordinator.stop();
		});
	});

	describe('stop()', () => {
		it('calls stop() on every started watcher', async () => {
			const claudeStorage = makeStorageStub({
				agentId: 'claude-code',
				spec: makeSpec('/tmp/claude'),
			});
			const codexStorage = makeStorageStub({
				agentId: 'codex',
				spec: makeSpec('/tmp/codex'),
			});

			const coordinator = new ExternalSessionCoordinator({
				processManager: makeProcessManager(),
				storageRegistry: { 'claude-code': claudeStorage, codex: codexStorage },
			});

			await coordinator.start();
			await coordinator.stop();

			expect(createdWatchers).toHaveLength(2);
			expect(createdWatchers.every((w) => w.stop.mock.calls.length === 1)).toBe(true);
		});

		it('clears the state map and any pending debounce timer', async () => {
			vi.useFakeTimers();
			const coordinator = new ExternalSessionCoordinator({
				processManager: makeProcessManager(),
				storageRegistry: {
					'claude-code': makeStorageStub({
						agentId: 'claude-code',
						spec: makeSpec('/tmp/claude'),
					}),
				},
			});
			await coordinator.start();
			await flushMicrotasks();

			const listener = vi.fn();
			coordinator.on(STATE_CHANGED_EVENT, listener);

			createdWatchers[0].emit('append', activityEvent({ sessionId: 'sess-1' }));
			// Stop BEFORE the debounce timer fires — listener should never see it.
			await coordinator.stop();
			await vi.advanceTimersByTimeAsync(STATE_CHANGE_DEBOUNCE_MS + 10);

			expect(listener).not.toHaveBeenCalled();
			expect(coordinator.getState().size).toBe(0);
		});

		it('is safe to call multiple times', async () => {
			const coordinator = new ExternalSessionCoordinator({
				processManager: makeProcessManager(),
				storageRegistry: {
					'claude-code': makeStorageStub({
						agentId: 'claude-code',
						spec: makeSpec('/tmp/claude'),
					}),
				},
			});
			await coordinator.start();
			await expect(coordinator.stop()).resolves.toBeUndefined();
			await expect(coordinator.stop()).resolves.toBeUndefined();
		});
	});
});
