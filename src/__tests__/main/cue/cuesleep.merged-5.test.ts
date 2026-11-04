// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/main/cue/cue-cleanup-service.test.ts
// Source: src/__tests__/main/cue/cue-output-filter.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	createCueCleanupService,
	CLEANUP_INTERVAL_TICKS,
	type CueCleanupServiceDeps,
} from '../../../main/cue/cue-cleanup-service';
import type { CueFanInTracker } from '../../../main/cue/cue-fan-in-tracker';
import type { CueSessionRegistry } from '../../../main/cue/cue-session-registry';
import {
	buildFilteredOutputs,
	mergeUpstreamForwarded,
	type FanInSourceCompletion,
} from '../../../main/cue/cue-output-filter';
import type { CueSubscription } from '../../../main/cue/cue-types';
// Source: src/__tests__/main/cue/cue-cleanup-service.test.ts
describe('', () => {
	// ─── Helpers ─────────────────────────────────────────────────────────────────
	function makeMockTracker(overrides: Partial<CueFanInTracker> = {}): CueFanInTracker {
		return {
			handleCompletion: vi.fn(),
			clearForSession: vi.fn(),
			reset: vi.fn(),
			getActiveTrackerKeys: vi.fn(() => []),
			getTrackerCreatedAt: vi.fn(() => undefined),
			expireTracker: vi.fn(),
			...overrides,
		};
	}
	function makeMockRegistry(overrides: Partial<CueSessionRegistry> = {}): CueSessionRegistry {
		return {
			register: vi.fn(),
			unregister: vi.fn(),
			get: vi.fn(() => undefined),
			has: vi.fn(() => false),
			snapshot: vi.fn(() => new Map()),
			size: vi.fn(() => 0),
			markScheduledFired: vi.fn(() => true),
			evictStaleScheduledKeys: vi.fn(),
			clearScheduledForSession: vi.fn(),
			markStartupFired: vi.fn(() => true),
			clearStartupForSession: vi.fn(),
			clear: vi.fn(),
			sweepStaleScheduledKeys: vi.fn(() => 0),
			...overrides,
		};
	}
	function makeDeps(overrides: Partial<CueCleanupServiceDeps> = {}): CueCleanupServiceDeps {
		return {
			fanInTracker: makeMockTracker(),
			registry: makeMockRegistry(),
			getSessions: vi.fn(() => []),
			getSessionTimeoutMs: vi.fn(() => 30 * 60 * 1000),
			getCurrentMinute: vi.fn(() => '09:00'),
			onLog: vi.fn(),
			...overrides,
		};
	}
	// ─── Tests ───────────────────────────────────────────────────────────────────
	describe('createCueCleanupService', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});
		describe('sweep - no-op cases', () => {
			it('returns zero counts when no trackers or keys exist', () => {
				const deps = makeDeps();
				const service = createCueCleanupService(deps);
				const result = service.sweep();
				expect(result).toEqual({ fanInEvicted: 0, scheduledKeysEvicted: 0 });
			});
			it('does not evict a recent fan-in tracker', () => {
				const tracker = makeMockTracker({
					getActiveTrackerKeys: vi.fn(() => ['session-1:sub-a']),
					getTrackerCreatedAt: vi.fn(() => Date.now() - 1000), // 1 second old
					expireTracker: vi.fn(),
				});
				const deps = makeDeps({
					fanInTracker: tracker,
					getSessions: () => [{ id: 'session-1' }],
					getSessionTimeoutMs: () => 30 * 60 * 1000, // 30 min - 2× = 60 min
				});
				const service = createCueCleanupService(deps);
				const result = service.sweep();
				expect(tracker.expireTracker).not.toHaveBeenCalled();
				expect(result.fanInEvicted).toBe(0);
			});
		});
		describe('sweep - fan-in eviction', () => {
			it('evicts a fan-in tracker whose owner session is no longer active', () => {
				const tracker = makeMockTracker({
					getActiveTrackerKeys: vi.fn(() => ['removed-session:sub-a']),
					getTrackerCreatedAt: vi.fn(() => Date.now()),
					expireTracker: vi.fn(),
				});
				const deps = makeDeps({
					fanInTracker: tracker,
					getSessions: () => [], // removed-session is gone
				});
				const service = createCueCleanupService(deps);
				const result = service.sweep();
				expect(tracker.expireTracker).toHaveBeenCalledWith('removed-session:sub-a');
				expect(result.fanInEvicted).toBe(1);
				expect(deps.onLog).toHaveBeenCalledWith('warn', expect.stringContaining('removed session'));
			});
			it('evicts a fan-in tracker whose age exceeds 2× the session timeout', () => {
				const timeoutMs = 30 * 60 * 1000; // 30 minutes
				const createdAt = Date.now() - 3 * timeoutMs; // 90 minutes ago > 2× timeout
				const tracker = makeMockTracker({
					getActiveTrackerKeys: vi.fn(() => ['session-1:sub-a']),
					getTrackerCreatedAt: vi.fn(() => createdAt),
					expireTracker: vi.fn(),
				});
				const deps = makeDeps({
					fanInTracker: tracker,
					getSessions: () => [{ id: 'session-1' }],
					getSessionTimeoutMs: () => timeoutMs,
				});
				const service = createCueCleanupService(deps);
				const result = service.sweep();
				expect(tracker.expireTracker).toHaveBeenCalledWith('session-1:sub-a');
				expect(result.fanInEvicted).toBe(1);
				expect(deps.onLog).toHaveBeenCalledWith('warn', expect.stringContaining('2× timeout'));
			});
			it('handles a key without a colon (edge case) by treating the whole key as session ID', () => {
				const tracker = makeMockTracker({
					getActiveTrackerKeys: vi.fn(() => ['orphaned-key']),
					getTrackerCreatedAt: vi.fn(() => undefined),
					expireTracker: vi.fn(),
				});
				const deps = makeDeps({
					fanInTracker: tracker,
					getSessions: () => [], // no sessions
				});
				const service = createCueCleanupService(deps);
				const result = service.sweep();
				// Should be evicted because "orphaned-key" is not in active sessions
				expect(tracker.expireTracker).toHaveBeenCalledWith('orphaned-key');
				expect(result.fanInEvicted).toBe(1);
			});
		});
		describe('sweep - scheduled key eviction', () => {
			it('reports evicted scheduled key count from registry.sweepStaleScheduledKeys', () => {
				const registry = makeMockRegistry({
					sweepStaleScheduledKeys: vi.fn(() => 3),
				});
				const deps = makeDeps({ registry });
				const service = createCueCleanupService(deps);
				const result = service.sweep();
				expect(result.scheduledKeysEvicted).toBe(3);
				expect(registry.sweepStaleScheduledKeys).toHaveBeenCalledWith('09:00');
				expect(deps.onLog).toHaveBeenCalledWith(
					'info',
					expect.stringContaining('3 stale scheduled key')
				);
			});
			it('passes the current minute from getCurrentMinute to the registry sweep', () => {
				const registry = makeMockRegistry({ sweepStaleScheduledKeys: vi.fn(() => 0) });
				const deps = makeDeps({
					registry,
					getCurrentMinute: () => '14:32',
				});
				const service = createCueCleanupService(deps);
				service.sweep();
				expect(registry.sweepStaleScheduledKeys).toHaveBeenCalledWith('14:32');
			});
		});
		describe('onTick cadence', () => {
			it('does not sweep before CLEANUP_INTERVAL_TICKS ticks', () => {
				const registry = makeMockRegistry({ sweepStaleScheduledKeys: vi.fn(() => 0) });
				const tracker = makeMockTracker({ getActiveTrackerKeys: vi.fn(() => []) });
				const deps = makeDeps({ registry, fanInTracker: tracker });
				const service = createCueCleanupService(deps);
				for (let i = 0; i < CLEANUP_INTERVAL_TICKS - 1; i++) {
					service.onTick();
				}
				expect(tracker.getActiveTrackerKeys).not.toHaveBeenCalled();
				expect(registry.sweepStaleScheduledKeys).not.toHaveBeenCalled();
			});
			it('triggers a sweep on exactly the Nth tick', () => {
				const registry = makeMockRegistry({ sweepStaleScheduledKeys: vi.fn(() => 0) });
				const tracker = makeMockTracker({ getActiveTrackerKeys: vi.fn(() => []) });
				const deps = makeDeps({ registry, fanInTracker: tracker });
				const service = createCueCleanupService(deps);
				for (let i = 0; i < CLEANUP_INTERVAL_TICKS; i++) {
					service.onTick();
				}
				expect(tracker.getActiveTrackerKeys).toHaveBeenCalledTimes(1);
				expect(registry.sweepStaleScheduledKeys).toHaveBeenCalledTimes(1);
			});
			it('sweeps again after another full interval', () => {
				const registry = makeMockRegistry({ sweepStaleScheduledKeys: vi.fn(() => 0) });
				const tracker = makeMockTracker({ getActiveTrackerKeys: vi.fn(() => []) });
				const deps = makeDeps({ registry, fanInTracker: tracker });
				const service = createCueCleanupService(deps);
				for (let i = 0; i < CLEANUP_INTERVAL_TICKS * 2; i++) {
					service.onTick();
				}
				expect(registry.sweepStaleScheduledKeys).toHaveBeenCalledTimes(2);
			});
		});
		describe('sweep - direct invocation', () => {
			it('sweep() bypasses the tick counter and runs immediately', () => {
				const registry = makeMockRegistry({ sweepStaleScheduledKeys: vi.fn(() => 0) });
				const tracker = makeMockTracker({ getActiveTrackerKeys: vi.fn(() => []) });
				const deps = makeDeps({ registry, fanInTracker: tracker });
				const service = createCueCleanupService(deps);
				// No ticks fired - sweep still runs when called directly
				service.sweep();
				expect(tracker.getActiveTrackerKeys).toHaveBeenCalledTimes(1);
				expect(registry.sweepStaleScheduledKeys).toHaveBeenCalledTimes(1);
			});
		});
	});
});
// Source: src/__tests__/main/cue/cue-output-filter.test.ts
describe('', () => {
	function makeSub(overrides: Partial<CueSubscription> = {}): CueSubscription {
		return {
			name: 'sub',
			event: 'agent.completed',
			enabled: true,
			prompt: 'process it',
			...overrides,
		};
	}
	function makeCompletion(overrides: Partial<FanInSourceCompletion> = {}): FanInSourceCompletion {
		return {
			sessionId: 'id-a',
			sessionName: 'Agent A',
			output: 'a-output',
			truncated: false,
			chainDepth: 0,
			...overrides,
		};
	}
	describe('buildFilteredOutputs', () => {
		describe('default (no filters)', () => {
			it('includes every completion when include_output_from is unset', () => {
				const completions = [makeCompletion()];
				const { outputCompletions, perSourceOutputs, forwardedOutputs } = buildFilteredOutputs(
					completions,
					makeSub()
				);
				expect(outputCompletions).toEqual(completions);
				expect(perSourceOutputs).toEqual({ 'Agent A': 'a-output' });
				expect(forwardedOutputs).toEqual({});
			});
			it('forwards nothing when forward_output_from is unset', () => {
				const completions = [makeCompletion()];
				const { forwardedOutputs } = buildFilteredOutputs(completions, makeSub());
				expect(forwardedOutputs).toEqual({});
			});
		});
		describe('include_output_from', () => {
			it('includes only listed sources (by sessionName)', () => {
				const completions = [
					makeCompletion({ sessionId: 'id-a', sessionName: 'Agent A', output: 'a' }),
					makeCompletion({ sessionId: 'id-b', sessionName: 'Agent B', output: 'b' }),
				];
				const { outputCompletions, perSourceOutputs } = buildFilteredOutputs(
					completions,
					makeSub({ include_output_from: ['Agent A'] })
				);
				expect(outputCompletions.map((c) => c.sessionName)).toEqual(['Agent A']);
				expect(perSourceOutputs).toEqual({ 'Agent A': 'a' });
			});
			it('includes listed sources by sessionId as well', () => {
				const completions = [
					makeCompletion({ sessionId: 'id-a', sessionName: 'Agent A', output: 'a' }),
					makeCompletion({ sessionId: 'id-b', sessionName: 'Agent B', output: 'b' }),
				];
				const { perSourceOutputs } = buildFilteredOutputs(
					completions,
					makeSub({ include_output_from: ['id-b'] })
				);
				expect(perSourceOutputs).toEqual({ 'Agent B': 'b' });
			});
			it('returns empty maps when include_output_from is an empty array', () => {
				const completions = [makeCompletion()];
				const { outputCompletions, perSourceOutputs } = buildFilteredOutputs(
					completions,
					makeSub({ include_output_from: [] })
				);
				expect(outputCompletions).toEqual([]);
				expect(perSourceOutputs).toEqual({});
			});
		});
		describe('forward_output_from', () => {
			it('forwards only listed sources', () => {
				const completions = [
					makeCompletion({ sessionName: 'Agent A', output: 'a' }),
					makeCompletion({ sessionId: 'id-b', sessionName: 'Agent B', output: 'b' }),
				];
				const { forwardedOutputs } = buildFilteredOutputs(
					completions,
					makeSub({ forward_output_from: ['Agent A'] })
				);
				expect(forwardedOutputs).toEqual({ 'Agent A': 'a' });
			});
			it('is independent of include_output_from (forward-only source is excluded from prompt)', () => {
				const completions = [
					makeCompletion({ sessionName: 'Agent A', output: 'a' }),
					makeCompletion({ sessionId: 'id-b', sessionName: 'Agent B', output: 'b' }),
				];
				const { perSourceOutputs, forwardedOutputs } = buildFilteredOutputs(
					completions,
					makeSub({
						include_output_from: ['Agent A'],
						forward_output_from: ['Agent B'],
					})
				);
				expect(perSourceOutputs).toEqual({ 'Agent A': 'a' });
				expect(forwardedOutputs).toEqual({ 'Agent B': 'b' });
			});
		});
	});
	describe('mergeUpstreamForwarded', () => {
		it('returns the original map when upstream is undefined', () => {
			const base = { 'Agent A': 'a' };
			expect(mergeUpstreamForwarded(base, undefined, makeSub())).toEqual(base);
		});
		it('passes all upstream keys through when forward_output_from is unset', () => {
			const merged = mergeUpstreamForwarded({}, { 'Agent X': 'x', 'Agent Y': 'y' }, makeSub());
			expect(merged).toEqual({ 'Agent X': 'x', 'Agent Y': 'y' });
		});
		it('filters upstream keys by forward_output_from when set', () => {
			const merged = mergeUpstreamForwarded(
				{},
				{ 'Agent X': 'x', 'Agent Y': 'y' },
				makeSub({ forward_output_from: ['Agent X'] })
			);
			expect(merged).toEqual({ 'Agent X': 'x' });
		});
		it('preserves base entries when merging', () => {
			const merged = mergeUpstreamForwarded(
				{ 'Agent A': 'a' },
				{ 'Agent X': 'x' },
				makeSub({ forward_output_from: ['Agent A', 'Agent X'] })
			);
			expect(merged).toEqual({ 'Agent A': 'a', 'Agent X': 'x' });
		});
	});
});
