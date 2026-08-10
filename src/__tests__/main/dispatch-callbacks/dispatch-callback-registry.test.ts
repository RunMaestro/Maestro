/**
 * @file dispatch-callback-registry.test.ts
 * @description Lifecycle tests for `dispatch --notify-on-complete`: the start
 * gate, fire-once guard, Auto Run parking, grace window, timeout and cancel.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
	DispatchCallbackRegistry,
	buildProcessSessionId,
	MAX_ARMED_CALLBACKS,
} from '../../../main/dispatch-callbacks/dispatch-callback-registry';
import type {
	DispatchCallbackFire,
	DispatchCallbackRegistration,
} from '../../../main/dispatch-callbacks/types';

const TARGET = 'agent-target';
const TAB = 'tab-1';
const KEY = buildProcessSessionId(TARGET, TAB);

interface Harness {
	registry: DispatchCallbackRegistry;
	fires: DispatchCallbackFire[];
	setNow: (ms: number) => void;
	/** `true` marks Auto Run as having started at the harness's current clock. */
	setAutoRun: (running: boolean) => void;
	/** Mark Auto Run as having started at an explicit timestamp. */
	setAutoRunSince: (since: number | undefined) => void;
	runTimers: () => void;
}

function makeHarness(opts: { graceMs?: number } = {}): Harness {
	let now = 1_000_000;
	let autoRunSince: number | undefined;
	const fires: DispatchCallbackFire[] = [];
	const pending: Array<{ id: number; fn: () => void }> = [];
	let timerId = 0;

	const registry = new DispatchCallbackRegistry({
		now: () => now,
		generateId: (() => {
			let n = 0;
			return () => `cb_${++n}`;
		})(),
		autoRunRunningSince: () => autoRunSince,
		onFire: (fire) => fires.push(fire),
		graceMs: opts.graceMs ?? 3000,
		setTimeoutFn: ((fn: () => void) => {
			const id = ++timerId;
			pending.push({ id, fn });
			return id as unknown as ReturnType<typeof setTimeout>;
		}) as never,
		clearTimeoutFn: ((handle: number) => {
			const index = pending.findIndex((p) => p.id === handle);
			if (index >= 0) pending.splice(index, 1);
		}) as never,
	});

	return {
		registry,
		fires,
		setNow: (ms) => {
			now = ms;
		},
		setAutoRun: (running) => {
			autoRunSince = running ? now : undefined;
		},
		setAutoRunSince: (since) => {
			autoRunSince = since;
		},
		runTimers: () => {
			const queued = pending.splice(0, pending.length);
			for (const p of queued) p.fn();
		},
	};
}

function register(
	registry: DispatchCallbackRegistry,
	overrides: Partial<DispatchCallbackRegistration> = {}
) {
	return registry.register({
		targetAgentId: TARGET,
		targetTabId: TAB,
		callerAgentId: 'agent-caller',
		timeoutMs: 60_000,
		prompt: 'do the thing',
		...overrides,
	});
}

describe('DispatchCallbackRegistry', () => {
	let h: Harness;

	beforeEach(() => {
		h = makeHarness();
	});

	it('does not fire for an exit that happened before the dispatched process started', () => {
		register(h.registry);
		// A predecessor turn (queued dispatch) exits while we are still pending.
		h.registry.noteExit(KEY, 0);
		h.runTimers();
		expect(h.fires).toHaveLength(0);
	});

	it('fires once on the dispatched run exit after the grace window', () => {
		register(h.registry);
		h.registry.noteSpawn(KEY);
		h.registry.noteExit(KEY, 0);
		expect(h.fires).toHaveLength(0); // still in grace
		h.runTimers();
		expect(h.fires).toHaveLength(1);
		expect(h.fires[0].status).toBe('completed');
		expect(h.fires[0].exitCode).toBe(0);
	});

	it('reports failed for a non-zero exit', () => {
		register(h.registry);
		h.registry.noteSpawn(KEY);
		h.registry.noteExit(KEY, 1);
		h.runTimers();
		expect(h.fires[0].status).toBe('failed');
	});

	it('ignores a second exit after firing (fire-once guard)', () => {
		register(h.registry);
		h.registry.noteSpawn(KEY);
		h.registry.noteExit(KEY, 0);
		h.runTimers();
		h.registry.noteSpawn(KEY);
		h.registry.noteExit(KEY, 0);
		h.runTimers();
		expect(h.fires).toHaveLength(1);
	});

	it('ignores exits from a different tab of the same agent', () => {
		register(h.registry);
		const otherTab = buildProcessSessionId(TARGET, 'tab-2');
		h.registry.noteSpawn(otherTab);
		h.registry.noteExit(otherTab, 0);
		h.runTimers();
		expect(h.fires).toHaveLength(0);
	});

	describe('Auto Run finality', () => {
		it('parks instead of firing while an Auto Run is running, then fires once at the end', () => {
			register(h.registry);
			h.setAutoRun(true);
			h.registry.noteSpawn(KEY);

			// Three tasks, three process exits - none of them should wake the caller.
			for (let i = 0; i < 3; i++) {
				h.registry.noteExit(KEY, 0);
				h.runTimers();
			}
			expect(h.fires).toHaveLength(0);

			h.setAutoRun(false);
			h.registry.noteAutoRunFinal(TARGET, { tasksCompleted: 3, tasksTotal: 3 });
			expect(h.fires).toHaveLength(1);
			expect(h.fires[0].tasksCompleted).toBe(3);
			expect(h.fires[0].tasksTotal).toBe(3);
		});

		it('parks when an Auto Run starts during the grace window', () => {
			register(h.registry);
			h.registry.noteSpawn(KEY);
			h.registry.noteExit(KEY, 0);
			// The dispatched turn's last act was to start an Auto Run; its state
			// broadcast lands after the process exit.
			h.setAutoRun(true);
			h.runTimers();
			expect(h.fires).toHaveLength(0);

			h.registry.noteAutoRunFinal(TARGET, { tasksCompleted: 5, tasksTotal: 5 });
			expect(h.fires).toHaveLength(1);
		});

		it('does not park behind an Auto Run that was already running before the dispatch', () => {
			// Auto Run is agent-scoped with no tab dimension, so a batch running in
			// another tab of the same agent must not delay - or donate its task
			// counts to - a callback correlated to this tab's turn.
			h.setAutoRunSince(500_000); // started long before this dispatch
			register(h.registry);
			h.registry.noteSpawn(KEY);
			h.registry.noteExit(KEY, 0);
			h.runTimers();
			expect(h.fires).toHaveLength(1);
			expect(h.fires[0].status).toBe('completed');
			expect(h.fires[0].tasksTotal).toBeUndefined();
		});

		it('ignores an Auto Run finality edge from another agent', () => {
			register(h.registry);
			h.setAutoRun(true);
			h.registry.noteSpawn(KEY);
			h.registry.noteExit(KEY, 0);
			h.registry.noteAutoRunFinal('some-other-agent');
			expect(h.fires).toHaveLength(0);
		});
	});

	describe('--new-tab spawn lookback', () => {
		it('adopts a spawn observed just before registration', () => {
			h.registry.noteSpawn(KEY);
			register(h.registry, { armFromRecentSpawn: true });
			h.registry.noteExit(KEY, 0);
			h.runTimers();
			expect(h.fires).toHaveLength(1);
		});

		it('replays an exit that landed before registration', () => {
			// A very short turn can spawn AND exit before the new-tab ack round-trips
			// back to the web server. Adopting only the spawn would leave the entry
			// armed until it reported a bogus timeout.
			h.registry.noteSpawn(KEY);
			h.registry.noteExit(KEY, 0);
			register(h.registry, { armFromRecentSpawn: true });
			h.runTimers();
			expect(h.fires).toHaveLength(1);
			expect(h.fires[0].status).toBe('completed');
		});

		it('replays a failing pre-registration exit with its exit code', () => {
			h.registry.noteSpawn(KEY);
			h.registry.noteExit(KEY, 3);
			register(h.registry, { armFromRecentSpawn: true });
			h.runTimers();
			expect(h.fires).toHaveLength(1);
			expect(h.fires[0].status).toBe('failed');
			expect(h.fires[0].exitCode).toBe(3);
		});

		it('does not replay an exit that predates the adopted spawn', () => {
			// The predecessor turn's exit, then our spawn: still running, nothing to
			// replay.
			h.registry.noteExit(KEY, 0);
			h.setNow(1_000_100);
			h.registry.noteSpawn(KEY);
			register(h.registry, { armFromRecentSpawn: true });
			h.runTimers();
			expect(h.fires).toHaveLength(0);
		});

		it('does not adopt a prior spawn for an existing tab', () => {
			h.registry.noteSpawn(KEY);
			register(h.registry);
			h.registry.noteExit(KEY, 0);
			h.runTimers();
			expect(h.fires).toHaveLength(0);
		});
	});

	describe('expiry and cancellation', () => {
		it('fires a timeout callback once the deadline passes', () => {
			register(h.registry, { timeoutMs: 60_000 });
			h.setNow(1_000_000 + 60_001);
			h.registry.sweepExpired();
			expect(h.fires).toHaveLength(1);
			expect(h.fires[0].status).toBe('timeout');

			// Sweeping again must not double-fire.
			h.registry.sweepExpired();
			expect(h.fires).toHaveLength(1);
		});

		it('cancel() stops a later exit from firing', () => {
			const entry = register(h.registry);
			expect(h.registry.cancel(entry.callbackId)).toBe(true);
			h.registry.noteSpawn(KEY);
			h.registry.noteExit(KEY, 0);
			h.runTimers();
			expect(h.fires).toHaveLength(0);
			expect(h.registry.cancel(entry.callbackId)).toBe(false);
		});

		it('cancelForTab() drops every callback bound to a closed tab', () => {
			register(h.registry);
			expect(h.registry.cancelForTab(TARGET, TAB)).toBe(1);
			expect(h.registry.list()).toHaveLength(0);
		});

		it('cancelForTab() wakes the caller with a cancelled status', () => {
			register(h.registry);
			expect(h.registry.cancelForTab(TARGET, TAB)).toBe(1);
			expect(h.fires).toHaveLength(1);
			expect(h.fires[0].status).toBe('cancelled');

			// Terminal: a second close (or a later exit) must not double-fire.
			expect(h.registry.cancelForTab(TARGET, TAB)).toBe(0);
			h.registry.noteSpawn(KEY);
			h.registry.noteExit(KEY, 0);
			h.runTimers();
			expect(h.fires).toHaveLength(1);
		});

		it('cancelForTab() leaves callbacks bound to other tabs armed', () => {
			register(h.registry);
			register(h.registry, { targetTabId: 'tab-2' });
			expect(h.registry.cancelForTab(TARGET, 'tab-2')).toBe(1);
			expect(h.fires).toHaveLength(1);
			expect(h.registry.hasArmedFor(TARGET, TAB)).toBe(true);
		});

		it('cancel() stays silent while cancelForTab() notifies', () => {
			const entry = register(h.registry);
			expect(h.registry.cancel(entry.callbackId)).toBe(true);
			expect(h.fires).toHaveLength(0);
		});
	});

	it('hasArmedFor() reports an existing arming on the same tab', () => {
		expect(h.registry.hasArmedFor(TARGET, TAB)).toBe(false);
		register(h.registry);
		expect(h.registry.hasArmedFor(TARGET, TAB)).toBe(true);
		expect(h.registry.hasArmedFor(TARGET, 'tab-2')).toBe(false);
	});

	it('refuses to arm past the runaway cap', () => {
		for (let i = 0; i < MAX_ARMED_CALLBACKS; i++) {
			register(h.registry, { targetTabId: `tab-${i}` });
		}
		expect(() => register(h.registry, { targetTabId: 'overflow' })).toThrow(/Too many/);
	});

	it('clamps the timeout to the 24h hard cap', () => {
		const entry = register(h.registry, { timeoutMs: 999 * 60 * 60 * 1000 });
		expect(entry.timeoutMs).toBe(24 * 60 * 60 * 1000);
	});

	it('measures duration from the spawn, not from registration', () => {
		register(h.registry);
		h.setNow(1_010_000);
		h.registry.noteSpawn(KEY);
		h.setNow(1_015_000);
		h.registry.noteExit(KEY, 0);
		h.runTimers();
		expect(h.fires[0].durationMs).toBe(5000);
	});
});

describe('buildProcessSessionId', () => {
	it('matches the exit listener composite id shape', () => {
		expect(buildProcessSessionId('abc', 'xyz')).toBe('abc-ai-xyz');
	});
});

describe('dispose', () => {
	it('drops entries and pending timers', () => {
		const h = makeHarness();
		register(h.registry);
		h.registry.dispose();
		expect(h.registry.list()).toHaveLength(0);
		vi.clearAllMocks();
	});
});
