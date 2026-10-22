/**
 * Tests for main/agent-run/store-watcher.ts: the `onRunsChanged` listener.
 *
 * The watcher reads the run ledger on every change to broadcast it. A second
 * reader of the ledger gets the runs from the watcher, so that the file is
 * read once per change, and not at all at start by a listener that has
 * nothing to do.
 *
 * `fs.watch` is stood in for, and the debounce runs on fake timers. A real
 * watch delivers its event whenever the OS gets to it, which under a loaded
 * test run is sometimes not within any timeout worth waiting for.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '../../../shared/agent-run';

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
}));
vi.mock('../../../main/agent-run/broadcast', () => ({
	broadcastRunUpdated: mocks.broadcastRunUpdated,
	broadcastEventAppended: mocks.broadcastEventAppended,
}));
vi.mock('../../../main/utils/logger', () => ({ logger: mocks.logger }));

import { startAgentRunStoreWatcher } from '../../../main/agent-run/store-watcher';
import type { StoreWatcherHandle } from '../../../main/agent-run/store-watcher';

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
