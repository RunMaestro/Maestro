// Source: src/__tests__/main/agent-run/store-watcher.test.ts
// Source: src/__tests__/main/agent-run/setup-recovery.test.ts
import { afterEach } from 'vitest';
import { beforeEach } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import type { AgentRun } from '../../../shared/agent-run';
import { startAgentRunStoreWatcher } from '../../../main/agent-run/store-watcher';
import type { StoreWatcherHandle } from '../../../main/agent-run/store-watcher';
import { setupAgentRunRecovery } from '../../../main/agent-run/setup-recovery';
import type { ProcessManager } from '../../../main/process-manager';
const mocks = vi.hoisted(() => ({
	/** What the watcher handed to `fs.watch`, by the path it watches. */
	watched: new Map<string, (event: string, name: string | null) => void>(),
	dir: '',
	runs: [] as unknown[],
	readAgentRuns: vi.fn(),
	readAgentRunEvents: vi.fn(() => []),
	broadcastRunUpdated: vi.fn(),
	broadcastEventAppended: vi.fn(),
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const recoveryWrites = vi.hoisted(() => ({
	upsertAgentRun: vi.fn(),
	appendAgentRunEvent: vi.fn(),
}));
vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	const watch = (target: unknown, listener: unknown): unknown => {
		mocks.watched.set(String(target), listener as (event: string, name: string | null) => void);
		return { on: () => undefined, close: () => undefined };
	};
	return { ...actual, watch, default: { ...actual, watch } };
});
vi.mock('../../../cli/services/storage', () => ({ getConfigDirectory: () => mocks.dir }));
vi.mock('../../../cli/services/agent-run-store', () => ({
	readAgentRuns: mocks.readAgentRuns,
	readAgentRunEvents: mocks.readAgentRunEvents,
	...recoveryWrites,
}));
vi.mock('../../../main/agent-run/broadcast', () => ({
	broadcastRunUpdated: mocks.broadcastRunUpdated,
	broadcastEventAppended: mocks.broadcastEventAppended,
}));
vi.mock('../../../main/utils/logger', () => ({ logger: mocks.logger }));
describe('store-watcher', () => {
	const RUNS_FILE = 'maestro-agent-runs.json';
	/** Longer than the watcher's debounce. */
	const PAST_DEBOUNCE_MS = 1000;

	function run(id: string): AgentRun {
		return {
			id,
			createdAt: 1,
			updatedAt: 2,
			provider: 'claude-code',
			status: 'completed',
			artifacts: [],
			touchedFiles: [],
			checks: [],
			reviews: [],
		};
	}

	describe('agent-run store watcher: onRunsChanged', () => {
		let handle: StoreWatcherHandle | null;
		const { watched } = mocks;

		beforeEach(() => {
			vi.useFakeTimers();
			mocks.dir = '/data';
			mocks.runs = [run('a')];
			mocks.readAgentRuns.mockReset();
			mocks.readAgentRuns.mockImplementation(() => mocks.runs);
			mocks.broadcastRunUpdated.mockClear();
			mocks.logger.warn.mockClear();
			handle = null;
			watched.clear();
		});

		afterEach(() => {
			handle?.stop();
			vi.useRealTimers();
		});

		/** Reports a change of the ledger, as the OS does after a write of the command line. */
		const changeLedger = (): void => {
			const listener = [...watched.entries()].find(([target]) => target.endsWith(RUNS_FILE))?.[1];
			if (!listener) throw new Error('The watcher does not watch the ledger.');
			listener('change', RUNS_FILE);
			vi.advanceTimersByTime(PAST_DEBOUNCE_MS);
		};

		it('tells the listener once at start, and reads the ledger only if the listener asks', () => {
			const readers: Array<() => AgentRun[]> = [];
			handle = startAgentRunStoreWatcher({ onRunsChanged: (readRuns) => readers.push(readRuns) });

			expect(readers).toHaveLength(1);
			// A listener with nothing to do costs no read of the file.
			expect(mocks.readAgentRuns).not.toHaveBeenCalled();

			expect(readers[0]()).toEqual([run('a')]);
			expect(mocks.readAgentRuns).toHaveBeenCalledTimes(1);
		});

		it('hands over the runs it just read after a change, with no second read', () => {
			const readers: Array<() => AgentRun[]> = [];
			handle = startAgentRunStoreWatcher({ onRunsChanged: (readRuns) => readers.push(readRuns) });
			mocks.runs = [run('a'), run('b')];

			changeLedger();

			expect(readers).toHaveLength(2);
			// One read, by the watcher, for its own broadcast.
			expect(mocks.readAgentRuns).toHaveBeenCalledTimes(1);
			expect(readers[1]()).toEqual([run('a'), run('b')]);
			expect(mocks.readAgentRuns).toHaveBeenCalledTimes(1);
			expect(mocks.broadcastRunUpdated).toHaveBeenCalledTimes(1);
		});

		it('tells the listener once for a burst of changes', () => {
			let calls = 0;
			handle = startAgentRunStoreWatcher({ onRunsChanged: () => (calls += 1) });
			const listener = [...watched.entries()].find(([target]) => target.endsWith(RUNS_FILE))?.[1];

			listener?.('change', RUNS_FILE);
			listener?.('change', RUNS_FILE);
			listener?.('change', RUNS_FILE);
			vi.advanceTimersByTime(PAST_DEBOUNCE_MS);

			// Once at start, and once for the burst.
			expect(calls).toBe(2);
		});

		it('goes on watching when the listener throws', () => {
			let calls = 0;
			handle = startAgentRunStoreWatcher({
				onRunsChanged: () => {
					calls += 1;
					throw new Error('The listener failed.');
				},
			});
			expect(calls).toBe(1);

			changeLedger();
			changeLedger();

			expect(calls).toBe(3);
			expect(mocks.logger.warn).toHaveBeenCalledWith(
				'store watch listener failed',
				expect.any(String),
				expect.objectContaining({ error: expect.stringContaining('The listener failed.') })
			);
		});

		it('starts and stops with no listener at all', () => {
			handle = startAgentRunStoreWatcher();
			expect(() => changeLedger()).not.toThrow();
			expect(() => handle?.stop()).not.toThrow();
		});
	});
});
describe('setup-recovery', () => {
	const storeMocks = { ...recoveryWrites, readAgentRuns: mocks.readAgentRuns };
	const loggerMock = mocks.logger;

	/** ProcessManager stand-in: only `get` is consulted by the recovery wiring. */
	function processManagerWithLiveSessions(live: string[]): ProcessManager {
		return {
			get: (sessionId: string) => (live.includes(sessionId) ? { sessionId } : undefined),
		} as unknown as ProcessManager;
	}

	const run = (overrides: Partial<AgentRun> = {}): AgentRun => ({
		id: 'run-1',
		createdAt: 100,
		updatedAt: 100,
		provider: 'claude-code',
		status: 'running',
		sessionId: 'sess-1',
		artifacts: [],
		touchedFiles: [],
		checks: [],
		reviews: [],
		...overrides,
	});

	describe('setupAgentRunRecovery', () => {
		afterEach(() => storeMocks.readAgentRuns.mockReset());
		beforeEach(() => {
			vi.clearAllMocks();
			storeMocks.readAgentRuns.mockReset();
			storeMocks.upsertAgentRun.mockImplementation((r: AgentRun) => r);
			storeMocks.appendAgentRunEvent.mockImplementation((e: unknown) => e);
		});

		it('settles a non-terminal run whose session is not in the process table', () => {
			storeMocks.readAgentRuns.mockReturnValue([run()]);

			const recovered = setupAgentRunRecovery(processManagerWithLiveSessions([]));

			expect(recovered).toBe(1);
			expect(storeMocks.upsertAgentRun).toHaveBeenCalledWith(
				expect.objectContaining({
					id: 'run-1',
					status: 'failed',
					metadata: expect.objectContaining({ recoveredFrom: 'running' }),
				})
			);
			expect(storeMocks.appendAgentRunEvent).toHaveBeenCalledWith(
				expect.objectContaining({ runId: 'run-1', type: 'status_change', status: 'failed' })
			);
		});

		it('leaves a run alone when the ProcessManager still tracks its session', () => {
			storeMocks.readAgentRuns.mockReturnValue([run()]);

			const recovered = setupAgentRunRecovery(processManagerWithLiveSessions(['sess-1']));

			expect(recovered).toBe(0);
			expect(storeMocks.upsertAgentRun).not.toHaveBeenCalled();
			expect(storeMocks.appendAgentRunEvent).not.toHaveBeenCalled();
		});

		it('tolerates an empty store: 0 recovered, no writes, no throw', () => {
			storeMocks.readAgentRuns.mockReturnValue([]);

			expect(setupAgentRunRecovery(processManagerWithLiveSessions([]))).toBe(0);
			expect(storeMocks.upsertAgentRun).not.toHaveBeenCalled();
			expect(storeMocks.appendAgentRunEvent).not.toHaveBeenCalled();
		});

		it('is idempotent: a second startup pass over the settled store writes nothing', () => {
			const crashed = run();
			storeMocks.readAgentRuns.mockReturnValue([crashed]);
			const pm = processManagerWithLiveSessions([]);

			expect(setupAgentRunRecovery(pm)).toBe(1);
			// Simulate the store after the first pass persisted the settle.
			const settled = storeMocks.upsertAgentRun.mock.calls[0][0] as AgentRun;
			storeMocks.readAgentRuns.mockReturnValue([settled]);
			storeMocks.upsertAgentRun.mockClear();
			storeMocks.appendAgentRunEvent.mockClear();

			expect(setupAgentRunRecovery(pm)).toBe(0);
			expect(storeMocks.upsertAgentRun).not.toHaveBeenCalled();
			expect(storeMocks.appendAgentRunEvent).not.toHaveBeenCalled();
		});

		it('swallows a store failure, logs it, and returns -1 (startup never throws)', () => {
			storeMocks.readAgentRuns.mockImplementation(() => {
				throw new Error('corrupt snapshot');
			});

			expect(() => setupAgentRunRecovery(processManagerWithLiveSessions([]))).not.toThrow();
			expect(setupAgentRunRecovery(processManagerWithLiveSessions([]))).toBe(-1);
			expect(loggerMock.warn).toHaveBeenCalledWith(
				expect.stringContaining('recovery failed'),
				expect.any(String)
			);
		});

		it('skips runs with no sessionId only when they cannot transition, settles them otherwise', () => {
			// A run with no sessionId is never "live" - it must settle too (a crash
			// can strand a queued run before its session was ever bound).
			storeMocks.readAgentRuns.mockReturnValue([run({ id: 'r-nosess', sessionId: undefined })]);

			const recovered = setupAgentRunRecovery(processManagerWithLiveSessions(['sess-1']));

			expect(recovered).toBe(1);
			expect(storeMocks.upsertAgentRun).toHaveBeenCalledWith(
				expect.objectContaining({ id: 'r-nosess', status: 'failed' })
			);
		});
	});
});
