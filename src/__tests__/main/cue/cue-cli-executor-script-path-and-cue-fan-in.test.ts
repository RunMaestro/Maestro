// Source: src/__tests__/main/cue/cue-cli-executor-script-path.test.ts
// Source: src/__tests__/main/cue/cue-fan-in.test.ts
// Source: src/__tests__/main/cue/cue-file-watcher-missing-base.test.ts
// Source: src/__tests__/main/cue/cue-filter.test.ts
// Source: src/__tests__/main/cue/cue-metrics.test.ts
import { describe as describeSourceSuite } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach } from 'vitest';
import { beforeEach } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { resolveMaestroCliScriptPath } from '../../../main/cue/cue-cli-executor';
import type { CueSettings as S0_CueSettings } from '../../../main/cue/cue-types';
import type { CueSubscription as S0_CueSubscription } from '../../../main/cue/cue-types';
import type { AgentCompletionData as S0_AgentCompletionData } from '../../../main/cue/cue-types';
import { createCueFanInTracker as s0_createCueFanInTracker } from '../../../main/cue/cue-fan-in-tracker';
import type { AgentCompletionData as S1_AgentCompletionData } from '../../../main/cue/cue-types';
import type { CueSettings as S1_CueSettings } from '../../../main/cue/cue-types';
import type { CueSubscription as S1_CueSubscription } from '../../../main/cue/cue-types';
import { createCueFanInTracker as s1_createCueFanInTracker } from '../../../main/cue/cue-fan-in-tracker';
import { createCueFileWatcher } from '../../../main/cue/cue-file-watcher';
import { globOnDisk } from '../../../main/cue/cue-file-watcher';
import { staticWatchBase } from '../../../main/cue/cue-file-watcher';
import type { CueEvent } from '../../../main/cue/cue-types';
import { matchesFilter } from '../../../main/cue/cue-filter';
import { describeFilter } from '../../../main/cue/cue-filter';
import { createCueMetrics } from '../../../main/cue/cue-metrics';
import type { CueMetricsCollector } from '../../../main/cue/cue-metrics';
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
describeSourceSuite('cue-cli-executor-script-path', () => {
	describe('resolveMaestroCliScriptPath outside Electron', () => {
		let dir: string;
		let argv1: string;

		beforeEach(() => {
			dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-bundle-')));
			argv1 = process.argv[1];
		});

		afterEach(() => {
			process.argv[1] = argv1;
			fs.rmSync(dir, { recursive: true, force: true });
		});

		it('finds the running bundle when it does not live in a directory named cli', () => {
			const bundle = path.join(dir, 'maestro-cli.js');
			fs.writeFileSync(bundle, '');
			process.argv[1] = bundle;

			expect(resolveMaestroCliScriptPath()).toBe(bundle);
		});

		it('finds maestro-cli.js beside another running script', () => {
			const bundle = path.join(dir, 'maestro-cli.js');
			fs.writeFileSync(bundle, '');
			process.argv[1] = path.join(dir, 'maestro-p.js');

			expect(resolveMaestroCliScriptPath()).toBe(bundle);
		});

		it('keeps the first of the original candidates as the path a failure names', () => {
			// Nothing readable anywhere: the fallback is unchanged, so the error still names the dev layout.
			process.argv[1] = path.join(dir, 'maestro-cli.js');

			expect(resolveMaestroCliScriptPath()).toMatch(/[\\/]cli[\\/]maestro-cli\.js$/);
		});
	});
});
describeSourceSuite('cue-fan-in', () => {
	describe('cue-fan-in-tracker', () => {
		// ─── Helpers ─────────────────────────────────────────────────────────────────
		function makeSub(overrides: Partial<S0_CueSubscription> = {}): S0_CueSubscription {
			return {
				name: 'fan-in-sub',
				event: 'agent.completed',
				enabled: true,
				prompt: 'compile results',
				source_sessions: ['session-a', 'session-b'],
				...overrides,
			};
		}
		function makeSettings(overrides: Partial<S0_CueSettings> = {}): S0_CueSettings {
			return {
				timeout_minutes: 30,
				timeout_on_fail: 'break',
				max_concurrent: 1,
				queue_size: 10,
				...overrides,
			};
		}
		function makeCompletion(
			overrides: Partial<S0_AgentCompletionData> = {}
		): S0_AgentCompletionData {
			return {
				sessionName: 'agent-a',
				status: 'completed',
				exitCode: 0,
				durationMs: 1000,
				stdout: 'output from agent',
				triggeredBy: 'fan-in-sub',
				chainDepth: 0,
				...overrides,
			};
		}
		// ─── Tests ───────────────────────────────────────────────────────────────────
		describe('CueFanInTracker - new inspection methods', () => {
			let dispatch: ReturnType<typeof vi.fn>;
			let onLog: ReturnType<typeof vi.fn>;
			beforeEach(() => {
				dispatch = vi.fn();
				onLog = vi.fn();
				vi.useFakeTimers();
			});
			afterEach(() => {
				// checkHealth tests additionally call vi.setSystemTime; restore real
				// timers here so other suites run against the real clock.
				vi.useRealTimers();
			});
			function makeTracker() {
				return s0_createCueFanInTracker({
					onLog,
					getSessions: () => [
						{
							id: 'session-a',
							name: 'Agent A',
							toolType: 'claude-code',
							cwd: '/',
							projectRoot: '/',
						},
						{
							id: 'session-b',
							name: 'Agent B',
							toolType: 'claude-code',
							cwd: '/',
							projectRoot: '/',
						},
					],
					dispatchSubscription: dispatch,
				});
			}
			describe('getActiveTrackerKeys', () => {
				it('returns empty array when no trackers are active', () => {
					const tracker = makeTracker();
					expect(tracker.getActiveTrackerKeys()).toEqual([]);
				});
				it('returns the key after the first completion arrives', () => {
					const tracker = makeTracker();
					const sub = makeSub();
					const settings = makeSettings();
					tracker.handleCompletion(
						'owner-session',
						settings,
						sub,
						['session-a', 'session-b'],
						'session-a',
						'Agent A',
						makeCompletion()
					);
					expect(tracker.getActiveTrackerKeys()).toEqual(['owner-session:fan-in-sub']);
				});
				it('removes the key after all sources complete (fan-in fires)', () => {
					const tracker = makeTracker();
					const sub = makeSub();
					const settings = makeSettings();
					const sources = ['session-a', 'session-b'];
					tracker.handleCompletion(
						'owner',
						settings,
						sub,
						sources,
						'session-a',
						'Agent A',
						makeCompletion()
					);
					tracker.handleCompletion(
						'owner',
						settings,
						sub,
						sources,
						'session-b',
						'Agent B',
						makeCompletion()
					);
					// Fan-in fired - no more active trackers
					expect(tracker.getActiveTrackerKeys()).toEqual([]);
				});
			});
			describe('getTrackerCreatedAt', () => {
				it('returns undefined for an unknown key', () => {
					const tracker = makeTracker();
					expect(tracker.getTrackerCreatedAt('nonexistent:key')).toBeUndefined();
				});
				it('returns the timestamp set when the first completion arrives', () => {
					const tracker = makeTracker();
					const sub = makeSub();
					const settings = makeSettings();
					const before = Date.now();
					tracker.handleCompletion(
						'owner-session',
						settings,
						sub,
						['session-a', 'session-b'],
						'session-a',
						'Agent A',
						makeCompletion()
					);
					const createdAt = tracker.getTrackerCreatedAt('owner-session:fan-in-sub');
					expect(createdAt).toBeGreaterThanOrEqual(before);
					expect(createdAt).toBeLessThanOrEqual(Date.now());
				});
			});
			describe('expireTracker', () => {
				it('removes the tracker and its timer without dispatching', () => {
					const tracker = makeTracker();
					const sub = makeSub();
					const settings = makeSettings();
					tracker.handleCompletion(
						'owner',
						settings,
						sub,
						['session-a', 'session-b'],
						'session-a',
						'Agent A',
						makeCompletion()
					);
					const key = 'owner:fan-in-sub';
					expect(tracker.getActiveTrackerKeys()).toContain(key);
					tracker.expireTracker(key);
					expect(tracker.getActiveTrackerKeys()).not.toContain(key);
					expect(tracker.getTrackerCreatedAt(key)).toBeUndefined();
					expect(dispatch).not.toHaveBeenCalled();
				});
				it('is a no-op for an unknown key', () => {
					const tracker = makeTracker();
					expect(() => tracker.expireTracker('nonexistent:key')).not.toThrow();
				});
			});
			describe('clearForSession - cleans up fanInCreatedAt', () => {
				it('removes createdAt entry when the owning session is cleared', () => {
					const tracker = makeTracker();
					const sub = makeSub();
					const settings = makeSettings();
					tracker.handleCompletion(
						'owner',
						settings,
						sub,
						['session-a', 'session-b'],
						'session-a',
						'Agent A',
						makeCompletion()
					);
					expect(tracker.getTrackerCreatedAt('owner:fan-in-sub')).toBeDefined();
					tracker.clearForSession('owner');
					expect(tracker.getTrackerCreatedAt('owner:fan-in-sub')).toBeUndefined();
					expect(tracker.getActiveTrackerKeys()).toEqual([]);
				});
			});
			describe('reset - clears all fanInCreatedAt entries', () => {
				it('removes all createdAt entries on reset', () => {
					const tracker = makeTracker();
					const sub = makeSub();
					const settings = makeSettings();
					tracker.handleCompletion(
						'owner',
						settings,
						sub,
						['session-a', 'session-b'],
						'session-a',
						'Agent A',
						makeCompletion()
					);
					expect(tracker.getActiveTrackerKeys()).toHaveLength(1);
					tracker.reset();
					expect(tracker.getActiveTrackerKeys()).toEqual([]);
					expect(tracker.getTrackerCreatedAt('owner:fan-in-sub')).toBeUndefined();
				});
			});
			// ─── Phase 12D - checkHealth ────────────────────────────────────────────
			describe('checkHealth', () => {
				const sessions = [
					{ id: 'session-a', name: 'Agent A', toolType: 'claude-code', cwd: '/', projectRoot: '/' },
					{ id: 'session-b', name: 'Agent B', toolType: 'claude-code', cwd: '/', projectRoot: '/' },
				];
				const sub = makeSub({ fan_in_timeout_minutes: 10 });
				function primeTracker(tracker: ReturnType<typeof makeTracker>) {
					tracker.handleCompletion(
						'owner',
						makeSettings(),
						sub,
						['session-a', 'session-b'],
						'session-a',
						'Agent A',
						makeCompletion()
					);
				}
				it('returns empty when no trackers are active', () => {
					const tracker = makeTracker();
					expect(
						tracker.checkHealth({ sessions, lookupSubscription: () => null, now: Date.now() })
					).toEqual([]);
				});
				it('excludes trackers <= 50% elapsed', () => {
					vi.setSystemTime(new Date('2026-04-21T10:00:00Z'));
					const tracker = makeTracker();
					primeTracker(tracker);
					// 3 minutes elapsed of a 10 minute timeout = 30%
					const now = Date.now() + 3 * 60 * 1000;
					const result = tracker.checkHealth({
						sessions,
						lookupSubscription: () => ({
							sub,
							settings: makeSettings(),
							sources: ['session-a', 'session-b'],
						}),
						now,
					});
					expect(result).toEqual([]);
				});
				it('includes trackers > 50% elapsed with correct counts', () => {
					vi.setSystemTime(new Date('2026-04-21T10:00:00Z'));
					const tracker = makeTracker();
					primeTracker(tracker);
					// 7 minutes elapsed of a 10 minute timeout = 70%
					const now = Date.now() + 7 * 60 * 1000;
					const result = tracker.checkHealth({
						sessions,
						lookupSubscription: () => ({
							sub,
							settings: makeSettings(),
							sources: ['session-a', 'session-b'],
						}),
						now,
					});
					expect(result).toHaveLength(1);
					const entry = result[0];
					expect(entry.key).toBe('owner:fan-in-sub');
					expect(entry.ownerSessionId).toBe('owner');
					expect(entry.subscriptionName).toBe('fan-in-sub');
					expect(entry.completedCount).toBe(1);
					expect(entry.expectedCount).toBe(2);
					expect(entry.pendingSourceIds).toEqual(['session-b']);
					expect(entry.percentElapsed).toBeGreaterThan(50);
					expect(entry.percentElapsed).toBeLessThan(100);
					expect(entry.timeoutMs).toBe(10 * 60 * 1000);
				});
				it('clamps negative elapsed (clock moved backward) to 0 and excludes', () => {
					vi.setSystemTime(new Date('2026-04-21T10:00:00Z'));
					const tracker = makeTracker();
					primeTracker(tracker);
					// Clock moved backward by 5 minutes from tracker creation
					const now = Date.now() - 5 * 60 * 1000;
					const result = tracker.checkHealth({
						sessions,
						lookupSubscription: () => ({
							sub,
							settings: makeSettings(),
							sources: ['session-a', 'session-b'],
						}),
						now,
					});
					expect(result).toEqual([]);
				});
				it('excludes trackers whose subscription can no longer be resolved', () => {
					vi.setSystemTime(new Date('2026-04-21T10:00:00Z'));
					const tracker = makeTracker();
					primeTracker(tracker);
					const now = Date.now() + 8 * 60 * 1000;
					const result = tracker.checkHealth({
						sessions,
						lookupSubscription: () => null, // subscription gone
						now,
					});
					expect(result).toEqual([]);
				});
				it('uses per-subscription fan_in_timeout_minutes over global settings', () => {
					vi.setSystemTime(new Date('2026-04-21T10:00:00Z'));
					const tracker = makeTracker();
					const localSub = makeSub({ fan_in_timeout_minutes: 2 });
					tracker.handleCompletion(
						'owner',
						makeSettings({ timeout_minutes: 100 }), // global 100m, but per-sub is 2m
						localSub,
						['session-a', 'session-b'],
						'session-a',
						'Agent A',
						makeCompletion()
					);
					// 1.5 minutes elapsed > 50% of 2 minute timeout
					const now = Date.now() + 90 * 1000;
					const result = tracker.checkHealth({
						sessions,
						lookupSubscription: () => ({
							sub: localSub,
							settings: makeSettings({ timeout_minutes: 100 }),
							sources: ['session-a', 'session-b'],
						}),
						now,
					});
					expect(result).toHaveLength(1);
					expect(result[0].timeoutMs).toBe(2 * 60 * 1000);
				});
				it('resolves pendingSourceIds via dedup (name+id referring to same session collapses)', () => {
					vi.setSystemTime(new Date('2026-04-21T10:00:00Z'));
					const tracker = makeTracker();
					primeTracker(tracker);
					const now = Date.now() + 8 * 60 * 1000;
					// Sources reference same session B by name + id.
					const result = tracker.checkHealth({
						sessions,
						lookupSubscription: () => ({
							sub,
							settings: makeSettings(),
							sources: ['session-a', 'session-b', 'Agent B'],
						}),
						now,
					});
					expect(result).toHaveLength(1);
					// Agent B resolves to session-b (already in set), so total expected is 2.
					expect(result[0].expectedCount).toBe(2);
				});
			});
			// ─── Regression: chainDepth propagation through fan-in ────────────────────
			// Bug 30ab9a5c4: fan-in dispatch did not forward the max chainDepth across
			// completed sources, so circular pipelines routed through fan-in nodes
			// bypassed the depth guard in CueCompletionService.notifyAgentCompleted -
			// the next dispatch saw chainDepth=0 and ran indefinitely. The fix stores
			// chainDepth in FanInSourceCompletion and the all-complete + timeout-continue
			// paths both pass `Math.max(...completions.map(c => c.chainDepth))` to
			// dispatchSubscription. These tests guard both paths.
			describe('chainDepth propagation', () => {
				it('forwards max chainDepth to dispatchSubscription when all sources complete', () => {
					const tracker = makeTracker();
					const sub = makeSub();
					const settings = makeSettings();
					const sources = ['session-a', 'session-b'];
					tracker.handleCompletion(
						'owner',
						settings,
						sub,
						sources,
						'session-a',
						'Agent A',
						makeCompletion({ chainDepth: 3 })
					);
					tracker.handleCompletion(
						'owner',
						settings,
						sub,
						sources,
						'session-b',
						'Agent B',
						makeCompletion({ chainDepth: 7 })
					);
					expect(dispatch).toHaveBeenCalledTimes(1);
					// dispatchSubscription signature: (ownerSessionId, sub, event, completedNames, chainDepth?)
					const call = dispatch.mock.calls[0];
					expect(call[0]).toBe('owner');
					expect(call[1]).toBe(sub);
					// Last positional argument is chainDepth - must equal max(3, 7) = 7,
					// NOT the last completion's depth (would mask cycles where the
					// deepest source isn't the most recent), and NOT 0 (the original
					// bug, which let cycles run forever).
					expect(call[4]).toBe(7);
				});
				it('forwards max chainDepth in timeout-continue mode', () => {
					vi.setSystemTime(new Date('2026-04-21T10:00:00Z'));
					const tracker = makeTracker();
					const sub = makeSub({ fan_in_timeout_minutes: 10 });
					const settings = makeSettings({ timeout_on_fail: 'continue' });
					const sources = ['session-a', 'session-b'];
					// Only session-a completes; session-b is left dangling and the
					// timer fires the timeout-continue branch.
					tracker.handleCompletion(
						'owner',
						settings,
						sub,
						sources,
						'session-a',
						'Agent A',
						makeCompletion({ chainDepth: 5 })
					);
					// Advance past the per-sub fan_in_timeout_minutes (10m).
					vi.advanceTimersByTime(11 * 60 * 1000);
					expect(dispatch).toHaveBeenCalledTimes(1);
					const call = dispatch.mock.calls[0];
					// Only one completion arrived, so max == that source's chainDepth (5).
					// The bug would have passed 0 here, masking cycles when partial
					// fan-ins continue through to dispatch.
					expect(call[4]).toBe(5);
				});
				it('falls back to chainDepth=0 when completions carry no chainDepth field', () => {
					// Defensive: events from older code paths or external callers may
					// omit chainDepth. The tracker must default to 0 (matching the
					// `?? 0` fallback in cue-fan-in-tracker.ts:219) rather than NaN
					// (which Math.max returns when fed undefined).
					const tracker = makeTracker();
					const sub = makeSub();
					const settings = makeSettings();
					const sources = ['session-a', 'session-b'];
					// Spread overrides into makeCompletion but force chainDepth=undefined
					// to simulate an external completion that didn't set it.
					const completionMissingDepth = {
						sessionName: 'agent-a',
						status: 'completed' as const,
						exitCode: 0,
						durationMs: 1000,
						stdout: 'output',
						triggeredBy: 'fan-in-sub',
					};
					tracker.handleCompletion(
						'owner',
						settings,
						sub,
						sources,
						'session-a',
						'Agent A',
						completionMissingDepth as never
					);
					tracker.handleCompletion(
						'owner',
						settings,
						sub,
						sources,
						'session-b',
						'Agent B',
						completionMissingDepth as never
					);
					expect(dispatch).toHaveBeenCalledTimes(1);
					const call = dispatch.mock.calls[0];
					expect(call[4]).toBe(0);
					expect(Number.isNaN(call[4])).toBe(false);
				});
			});
		});
	});
	describe('cue-fan-in-edge-cases', () => {
		// ─── Helpers ─────────────────────────────────────────────────────────────────
		function makeSub(overrides: Partial<S1_CueSubscription> = {}): S1_CueSubscription {
			return {
				name: 'fan-in-sub',
				event: 'agent.completed',
				enabled: true,
				prompt: 'merge results',
				source_sessions: ['session-a', 'session-b'],
				...overrides,
			};
		}
		function makeSettings(overrides: Partial<S1_CueSettings> = {}): S1_CueSettings {
			return {
				// Small default so tests can advance a handful of minutes; individual
				// tests override this as needed.
				timeout_minutes: 2,
				timeout_on_fail: 'continue',
				max_concurrent: 1,
				queue_size: 10,
				...overrides,
			};
		}
		function makeCompletion(
			overrides: Partial<S1_AgentCompletionData> = {}
		): S1_AgentCompletionData {
			return {
				sessionName: 'agent-a',
				status: 'completed',
				exitCode: 0,
				durationMs: 1000,
				stdout: 'output from agent',
				triggeredBy: 'fan-in-sub',
				chainDepth: 0,
				...overrides,
			};
		}
		const SOURCES = ['session-a', 'session-b'];
		const OWNER = 'owner-session';
		// ─── Tests ───────────────────────────────────────────────────────────────────
		describe('CueFanInTracker - edge cases', () => {
			let dispatch: ReturnType<typeof vi.fn>;
			let onLog: ReturnType<typeof vi.fn>;
			beforeEach(() => {
				dispatch = vi.fn();
				onLog = vi.fn();
				vi.useFakeTimers();
			});
			afterEach(() => {
				vi.useRealTimers();
			});
			function makeTracker() {
				return s1_createCueFanInTracker({
					onLog,
					getSessions: () => [
						{
							id: 'session-a',
							name: 'Agent A',
							toolType: 'claude-code',
							cwd: '/',
							projectRoot: '/',
						},
						{
							id: 'session-b',
							name: 'Agent B',
							toolType: 'claude-code',
							cwd: '/',
							projectRoot: '/',
						},
					],
					dispatchSubscription: dispatch,
				});
			}
			// ─── Timeout behavior ──────────────────────────────────────────────────
			describe('source never completes → timeout', () => {
				it('fires with partial data in "continue" mode', () => {
					const tracker = makeTracker();
					const sub = makeSub();
					const settings = makeSettings({ timeout_minutes: 2, timeout_on_fail: 'continue' });
					// Only session-a completes; session-b never does.
					tracker.handleCompletion(
						OWNER,
						settings,
						sub,
						SOURCES,
						'session-a',
						'Agent A',
						makeCompletion({ sessionName: 'Agent A', stdout: 'A-OUTPUT' })
					);
					expect(dispatch).not.toHaveBeenCalled();
					expect(tracker.getActiveTrackerKeys()).toEqual([`${OWNER}:${sub.name}`]);
					// Advance just past the 2-minute timeout.
					vi.advanceTimersByTime(2 * 60 * 1000 + 1);
					expect(dispatch).toHaveBeenCalledTimes(1);
					const [ownerArg, subArg, eventArg, sourceNameArg] = dispatch.mock.calls[0];
					expect(ownerArg).toBe(OWNER);
					expect(subArg).toBe(sub);
					// Partial dispatch: only Agent A is in the completedSessions list;
					// Agent B shows up in timedOutSessions.
					expect(eventArg.payload.completedSessions).toEqual(['session-a']);
					expect(eventArg.payload.timedOutSessions).toEqual(['session-b']);
					expect(eventArg.payload.partial).toBe(true);
					expect(eventArg.payload.sourceOutput).toContain('A-OUTPUT');
					expect(sourceNameArg).toBe('Agent A');
					// Tracker state is cleaned up - timeout consumed the entry.
					expect(tracker.getActiveTrackerKeys()).toEqual([]);
					expect(tracker.getTrackerCreatedAt(`${OWNER}:${sub.name}`)).toBeUndefined();
				});
				it('logs but does not dispatch in "break" mode', () => {
					const tracker = makeTracker();
					const sub = makeSub();
					const settings = makeSettings({ timeout_minutes: 2, timeout_on_fail: 'break' });
					tracker.handleCompletion(
						OWNER,
						settings,
						sub,
						SOURCES,
						'session-a',
						'Agent A',
						makeCompletion()
					);
					vi.advanceTimersByTime(2 * 60 * 1000 + 1);
					expect(dispatch).not.toHaveBeenCalled();
					expect(tracker.getActiveTrackerKeys()).toEqual([]);
					// Break-mode log surface: mentions timeout + waiting list.
					expect(
						onLog.mock.calls.some(
							(call) => typeof call[1] === 'string' && /timed out \(break mode\)/.test(call[1])
						)
					).toBe(true);
				});
				it('honors per-subscription fan_in_timeout_minutes over settings.timeout_minutes', () => {
					const tracker = makeTracker();
					const sub = makeSub({ fan_in_timeout_minutes: 1 });
					const settings = makeSettings({ timeout_minutes: 60, timeout_on_fail: 'continue' });
					tracker.handleCompletion(
						OWNER,
						settings,
						sub,
						SOURCES,
						'session-a',
						'Agent A',
						makeCompletion()
					);
					// settings.timeout_minutes is 60, but the per-sub override is 1 →
					// timeout fires just after 1 minute, well before 60.
					vi.advanceTimersByTime(60 * 1000 + 1);
					expect(dispatch).toHaveBeenCalledTimes(1);
				});
				it('honors per-subscription fan_in_timeout_on_fail override', () => {
					const tracker = makeTracker();
					const sub = makeSub({ fan_in_timeout_on_fail: 'break' });
					// Settings says "continue" but the sub pins "break" → must not
					// dispatch on timeout.
					const settings = makeSettings({ timeout_minutes: 1, timeout_on_fail: 'continue' });
					tracker.handleCompletion(
						OWNER,
						settings,
						sub,
						SOURCES,
						'session-a',
						'Agent A',
						makeCompletion()
					);
					vi.advanceTimersByTime(60 * 1000 + 1);
					expect(dispatch).not.toHaveBeenCalled();
				});
			});
			// ─── Mid-wait cleanup ──────────────────────────────────────────────────
			describe('source session removed during fan-in wait', () => {
				it('clearForSession cleans up tracker without firing timeout', () => {
					const tracker = makeTracker();
					const sub = makeSub();
					const settings = makeSettings({ timeout_minutes: 5, timeout_on_fail: 'continue' });
					tracker.handleCompletion(
						OWNER,
						settings,
						sub,
						SOURCES,
						'session-a',
						'Agent A',
						makeCompletion()
					);
					expect(tracker.getActiveTrackerKeys()).toHaveLength(1);
					// Owner session goes away (user closed the agent); clear its fan-in state.
					tracker.clearForSession(OWNER);
					// Advance past the timeout - must NOT fire because the timer was cleared.
					vi.advanceTimersByTime(5 * 60 * 1000 + 1);
					expect(dispatch).not.toHaveBeenCalled();
					expect(tracker.getActiveTrackerKeys()).toEqual([]);
					expect(tracker.getTrackerCreatedAt(`${OWNER}:${sub.name}`)).toBeUndefined();
				});
				it('clearForSession only clears entries owned by the given session', () => {
					const tracker = makeTracker();
					const sub = makeSub();
					const settings = makeSettings({ timeout_minutes: 5, timeout_on_fail: 'continue' });
					tracker.handleCompletion(
						'owner-1',
						settings,
						sub,
						SOURCES,
						'session-a',
						'Agent A',
						makeCompletion()
					);
					tracker.handleCompletion(
						'owner-2',
						settings,
						sub,
						SOURCES,
						'session-a',
						'Agent A',
						makeCompletion()
					);
					expect(tracker.getActiveTrackerKeys().sort()).toEqual(
						[`owner-1:${sub.name}`, `owner-2:${sub.name}`].sort()
					);
					tracker.clearForSession('owner-1');
					// owner-2 is still tracked and will time out normally.
					expect(tracker.getActiveTrackerKeys()).toEqual([`owner-2:${sub.name}`]);
				});
			});
			// ─── Idempotency / late-arrivals ───────────────────────────────────────
			describe('duplicate completion from the same source', () => {
				it('treats the second completion as a replacement, not a second vote', () => {
					const tracker = makeTracker();
					const sub = makeSub();
					const settings = makeSettings({ timeout_minutes: 5, timeout_on_fail: 'continue' });
					tracker.handleCompletion(
						OWNER,
						settings,
						sub,
						SOURCES,
						'session-a',
						'Agent A',
						makeCompletion({ stdout: 'A-FIRST' })
					);
					// Same session completes a second time - must NOT count as a new vote
					// toward the fan-in, otherwise a 2-source fan-in would fire prematurely
					// after one agent completes twice without the other ever running.
					tracker.handleCompletion(
						OWNER,
						settings,
						sub,
						SOURCES,
						'session-a',
						'Agent A',
						makeCompletion({ stdout: 'A-SECOND' })
					);
					expect(dispatch).not.toHaveBeenCalled();
					expect(tracker.getActiveTrackerKeys()).toEqual([`${OWNER}:${sub.name}`]);
				});
				it('second completion does not extend the timeout window', () => {
					const tracker = makeTracker();
					const sub = makeSub();
					const settings = makeSettings({ timeout_minutes: 2, timeout_on_fail: 'continue' });
					tracker.handleCompletion(
						OWNER,
						settings,
						sub,
						SOURCES,
						'session-a',
						'Agent A',
						makeCompletion()
					);
					// Half the timeout window passes, then a duplicate arrives.
					vi.advanceTimersByTime(60 * 1000);
					tracker.handleCompletion(
						OWNER,
						settings,
						sub,
						SOURCES,
						'session-a',
						'Agent A',
						makeCompletion()
					);
					// Remaining 60s + 1ms must trigger the original timeout - the
					// duplicate did NOT reset the timer.
					vi.advanceTimersByTime(60 * 1000 + 1);
					expect(dispatch).toHaveBeenCalledTimes(1);
				});
			});
			// ─── Late completion after timeout ─────────────────────────────────────
			describe('completion after timeout already fired', () => {
				it('is accepted as a fresh fan-in cycle (starts a new tracker)', () => {
					// This documents the current semantics: once a tracker is cleaned up
					// by a timeout, a late completion from the same source for the same
					// subscription starts a NEW tracker. In-flight coordination logic
					// upstream is responsible for treating post-timeout events as a new
					// cycle or dropping them - the tracker itself is stateless across
					// timeout boundaries.
					const tracker = makeTracker();
					const sub = makeSub();
					const settings = makeSettings({ timeout_minutes: 2, timeout_on_fail: 'continue' });
					tracker.handleCompletion(
						OWNER,
						settings,
						sub,
						SOURCES,
						'session-a',
						'Agent A',
						makeCompletion()
					);
					vi.advanceTimersByTime(2 * 60 * 1000 + 1); // timeout fires
					expect(dispatch).toHaveBeenCalledTimes(1);
					// Late completion arrives from session-b - tracker was cleared, so
					// this becomes the first completion of a new cycle.
					tracker.handleCompletion(
						OWNER,
						settings,
						sub,
						SOURCES,
						'session-b',
						'Agent B',
						makeCompletion()
					);
					// A new timer is ticking; we have NOT re-dispatched yet.
					expect(dispatch).toHaveBeenCalledTimes(1);
					expect(tracker.getActiveTrackerKeys()).toEqual([`${OWNER}:${sub.name}`]);
				});
				it('expireTracker prevents further completions from that tracker dispatching', () => {
					// expireTracker is the cleanup-service's eviction path. After it runs,
					// subsequent completions for the same key start a fresh tracker
					// cycle, but the tracker we expired must never dispatch.
					const tracker = makeTracker();
					const sub = makeSub();
					const settings = makeSettings({ timeout_minutes: 5, timeout_on_fail: 'continue' });
					tracker.handleCompletion(
						OWNER,
						settings,
						sub,
						SOURCES,
						'session-a',
						'Agent A',
						makeCompletion()
					);
					tracker.expireTracker(`${OWNER}:${sub.name}`);
					// Advance past the original timeout - expireTracker should have
					// cleared the timer; no dispatch must occur.
					vi.advanceTimersByTime(5 * 60 * 1000 + 1);
					expect(dispatch).not.toHaveBeenCalled();
				});
			});
		});
	});
});
describeSourceSuite('cue-file-watcher-missing-base', () => {
	const DEBOUNCE_MS = 50;
	const SETTLE_MS = 400;
	const WAIT_TIMEOUT_MS = 8000;
	const RM_OPTIONS = { recursive: true, force: true, maxRetries: 10, retryDelay: 50 } as const;
	// Each test can wait up to WAIT_TIMEOUT_MS on top of several SETTLE_MS pauses,
	// which a slow Windows runner can push past the suite's 10s default.
	const TEST_TIMEOUT_MS = 30000;
	// Windows and default macOS volumes match folder names case-insensitively.
	const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

	function delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	async function waitFor(predicate: () => boolean, timeoutMs = WAIT_TIMEOUT_MS): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!predicate()) {
			if (Date.now() > deadline) throw new Error('waitFor timed out');
			await delay(25);
		}
	}

	/**
	 * Asserts the events one new file produced: exactly one `add`, first, for one
	 * path, followed by nothing but `change`. A second `add` would mean two
	 * watchers fired for the same file. One writeFileSync can still surface as
	 * add + change when FSEvents delivers its flags in two batches more than the
	 * debounce apart, which loaded full-suite runs hit; a trailing `change` is the OS.
	 */
	function expectSingleAdd(fileEvents: CueEvent[]): CueEvent {
		expect(fileEvents.filter((e) => e.payload.changeType === 'add')).toHaveLength(1);
		expect(fileEvents[0].payload.changeType).toBe('add');
		expect(fileEvents.slice(1).every((e) => e.payload.changeType === 'change')).toBe(true);
		expect(new Set(fileEvents.map((e) => e.payload.path)).size).toBe(1);
		return fileEvents[0];
	}

	/** mkdir that tolerates a folder Windows still holds pending-delete. */
	async function mkdirWithRetry(dir: string): Promise<void> {
		for (let attempt = 0; ; attempt++) {
			try {
				fs.mkdirSync(dir, { recursive: true });
				return;
			} catch (error) {
				if (attempt >= 20) throw error;
				await delay(50);
			}
		}
	}

	describe('cue-file-watcher with a missing static folder', { timeout: TEST_TIMEOUT_MS }, () => {
		let root: string;
		let events: CueEvent[];
		let cleanup: (() => void) | null;

		const start = (watchGlob: string) => {
			cleanup = createCueFileWatcher({
				watchGlob,
				projectRoot: root,
				debounceMs: DEBOUNCE_MS,
				triggerName: 'missing-base',
				onEvent: (event) => events.push(event),
			});
		};

		beforeEach(() => {
			root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cue-watch-base-')));
			events = [];
			cleanup = null;
		});

		afterEach(async () => {
			cleanup?.();
			cleanup = null;
			// Watchers close asynchronously; give the handles a moment on Windows.
			await delay(50);
			try {
				fs.rmSync(root, RM_OPTIONS);
			} catch (error) {
				// A handle Windows has not released yet only leaves a temp folder
				// behind; it says nothing about the watcher under test.
				if (process.platform !== 'win32') throw error;
			}
		});

		it('fires once for a file written into a folder created after the watcher is ready', async () => {
			start('inbox/*.txt');
			await delay(SETTLE_MS);

			await mkdirWithRetry(path.join(root, 'inbox'));
			await delay(SETTLE_MS);
			fs.writeFileSync(path.join(root, 'inbox', 'a.txt'), 'one');

			await waitFor(() => events.length >= 1);
			await delay(SETTLE_MS);
			const event = expectSingleAdd(events);
			expect(event.type).toBe('file.changed');
			expect(event.payload).toMatchObject({
				path: path.join(root, 'inbox', 'a.txt'),
				filename: 'a.txt',
				directory: path.join(root, 'inbox'),
				extension: '.txt',
				changeType: 'add',
			});
		});

		it('fires for a file written in the same tick the folder is created', async () => {
			start('inbox/*.txt');
			await delay(SETTLE_MS);

			await mkdirWithRetry(path.join(root, 'inbox'));
			fs.writeFileSync(path.join(root, 'inbox', 'fast.txt'), 'fast');

			await waitFor(() => events.length >= 1);
			await delay(SETTLE_MS);
			expect(expectSingleAdd(events).payload).toMatchObject({ filename: 'fast.txt' });
		});

		it('fires for nested missing folders created one level at a time', async () => {
			start('a/b/*.md');
			await delay(SETTLE_MS);

			await mkdirWithRetry(path.join(root, 'a'));
			await delay(SETTLE_MS);
			await mkdirWithRetry(path.join(root, 'a', 'b'));
			await delay(SETTLE_MS);
			fs.writeFileSync(path.join(root, 'a', 'b', 'note.md'), '# note');

			await waitFor(() => events.length >= 1);
			await delay(SETTLE_MS);
			expect(expectSingleAdd(events).payload).toMatchObject({
				path: path.join(root, 'a', 'b', 'note.md'),
			});
		});

		it('keeps firing after the folder is deleted and created again', async () => {
			await mkdirWithRetry(path.join(root, 'inbox'));
			start('inbox/*.txt');
			await delay(SETTLE_MS);

			fs.writeFileSync(path.join(root, 'inbox', 'first.txt'), '1');
			await waitFor(() => events.length >= 1);

			fs.rmSync(path.join(root, 'inbox'), RM_OPTIONS);
			await delay(SETTLE_MS);
			await mkdirWithRetry(path.join(root, 'inbox'));
			await delay(SETTLE_MS);
			const before = events.length;
			fs.writeFileSync(path.join(root, 'inbox', 'second.txt'), '2');

			await waitFor(() => events.some((e) => e.payload.filename === 'second.txt'));
			await delay(SETTLE_MS);
			expectSingleAdd(events.slice(before).filter((e) => e.payload.filename === 'second.txt'));
		});

		it('keeps firing after a parent of the folder is deleted and the chain recreated', async () => {
			await mkdirWithRetry(path.join(root, 'a', 'b'));
			start('a/b/*.md');
			await delay(SETTLE_MS);

			fs.rmSync(path.join(root, 'a'), RM_OPTIONS);
			await delay(SETTLE_MS);
			await mkdirWithRetry(path.join(root, 'a', 'b'));
			await delay(SETTLE_MS);
			fs.writeFileSync(path.join(root, 'a', 'b', 'back.md'), 'back');

			await waitFor(() => events.length >= 1);
			await delay(SETTLE_MS);
			expect(expectSingleAdd(events).payload).toMatchObject({ filename: 'back.md' });
		});

		it.runIf(CASE_INSENSITIVE_FS)(
			'fires for a folder created in a different case than the glob spells it',
			async () => {
				start('Inbox/*.txt');
				await delay(SETTLE_MS);

				await mkdirWithRetry(path.join(root, 'inbox'));
				await delay(SETTLE_MS);
				fs.writeFileSync(path.join(root, 'inbox', 'cased.txt'), 'cased');

				await waitFor(() => events.length >= 1);
				await delay(SETTLE_MS);
				expect(expectSingleAdd(events).payload).toMatchObject({ filename: 'cased.txt' });
			}
		);

		it('does not report files already in a folder present at start', async () => {
			await mkdirWithRetry(path.join(root, 'inbox'));
			fs.writeFileSync(path.join(root, 'inbox', 'old.txt'), 'old');
			// macOS FSEvents replays a write made moments before a stream opens, so a
			// file written right before start can still arrive as `add`. Let it age
			// past that window: "present at start" means present before the watcher.
			await delay(SETTLE_MS);
			start('inbox/*.txt');
			await delay(SETTLE_MS * 2);

			expect(events).toHaveLength(0);
		});

		it('still fires for a glob with no static folder', async () => {
			start('**/*.md');
			await delay(SETTLE_MS);

			await mkdirWithRetry(path.join(root, 'deep', 'er'));
			await delay(SETTLE_MS);
			fs.writeFileSync(path.join(root, 'deep', 'er', 'x.md'), 'x');

			await waitFor(() => events.length >= 1);
			expect(events[0].payload).toMatchObject({
				path: path.join(root, 'deep', 'er', 'x.md'),
				changeType: 'add',
			});
		});
	});

	describe('staticWatchBase', () => {
		it.each([
			['inbox/*.txt', 'inbox'],
			['a/b/*.md', 'a/b'],
			['./inbox/*.txt', 'inbox'],
			['docs/readme.md', 'docs'],
			['readme.md', ''],
			['**/*.md', ''],
			['{a,b}/*.md', ''],
			['src/**/*.ts', 'src'],
		])('%s -> %j', (glob, base) => {
			expect(staticWatchBase(glob)).toBe(base);
		});
	});

	describe('globOnDisk', () => {
		let root: string;

		beforeEach(() => {
			root = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-glob-on-disk-'));
			fs.mkdirSync(path.join(root, 'inbox', 'Sub'), { recursive: true });
		});

		afterEach(() => {
			fs.rmSync(root, RM_OPTIONS);
		});

		it('respells the static folder the way it is spelled on disk', () => {
			expect(globOnDisk(root, 'Inbox/sub', 'Inbox/sub/*.txt')).toBe('inbox/Sub/*.txt');
		});

		it('keeps a leading ./ off and an exact spelling as is', () => {
			expect(globOnDisk(root, 'inbox', './inbox/**/*.md')).toBe('inbox/**/*.md');
		});

		it('returns the glob unchanged when the folder is missing', () => {
			expect(globOnDisk(root, 'outbox', 'outbox/*.txt')).toBe('outbox/*.txt');
		});
	});
});
describeSourceSuite('cue-filter', () => {
	describe('cue-filter', () => {
		describe('matchesFilter', () => {
			describe('exact string matching', () => {
				it('matches exact string values', () => {
					expect(matchesFilter({ extension: '.ts' }, { extension: '.ts' })).toBe(true);
				});

				it('rejects non-matching string values', () => {
					expect(matchesFilter({ extension: '.js' }, { extension: '.ts' })).toBe(false);
				});

				it('coerces payload value to string for comparison', () => {
					expect(matchesFilter({ count: 42 }, { count: '42' })).toBe(true);
				});
			});

			describe('negation (!value)', () => {
				it('matches when value does not equal', () => {
					expect(matchesFilter({ status: 'active' }, { status: '!archived' })).toBe(true);
				});

				it('rejects when value equals the negated term', () => {
					expect(matchesFilter({ status: 'archived' }, { status: '!archived' })).toBe(false);
				});
			});

			describe('numeric comparisons', () => {
				it('matches greater than', () => {
					expect(matchesFilter({ size: 1500 }, { size: '>1000' })).toBe(true);
				});

				it('rejects not greater than', () => {
					expect(matchesFilter({ size: 500 }, { size: '>1000' })).toBe(false);
				});

				it('rejects equal for greater than', () => {
					expect(matchesFilter({ size: 1000 }, { size: '>1000' })).toBe(false);
				});

				it('matches less than', () => {
					expect(matchesFilter({ priority: 3 }, { priority: '<5' })).toBe(true);
				});

				it('rejects not less than', () => {
					expect(matchesFilter({ priority: 7 }, { priority: '<5' })).toBe(false);
				});

				it('matches greater than or equal', () => {
					expect(matchesFilter({ score: 100 }, { score: '>=100' })).toBe(true);
					expect(matchesFilter({ score: 101 }, { score: '>=100' })).toBe(true);
				});

				it('rejects less than for >=', () => {
					expect(matchesFilter({ score: 99 }, { score: '>=100' })).toBe(false);
				});

				it('matches less than or equal', () => {
					expect(matchesFilter({ count: 10 }, { count: '<=10' })).toBe(true);
					expect(matchesFilter({ count: 9 }, { count: '<=10' })).toBe(true);
				});

				it('rejects greater than for <=', () => {
					expect(matchesFilter({ count: 11 }, { count: '<=10' })).toBe(false);
				});

				it('handles string payload values with numeric comparison', () => {
					expect(matchesFilter({ size: '1500' }, { size: '>1000' })).toBe(true);
				});
			});

			describe('glob pattern matching', () => {
				it('matches simple glob patterns', () => {
					expect(matchesFilter({ path: 'file.ts' }, { path: '*.ts' })).toBe(true);
				});

				it('rejects non-matching glob patterns', () => {
					expect(matchesFilter({ path: 'file.js' }, { path: '*.ts' })).toBe(false);
				});

				it('matches complex glob patterns', () => {
					expect(
						matchesFilter({ path: 'src/components/Button.tsx' }, { path: 'src/**/*.tsx' })
					).toBe(true);
				});

				it('rejects non-matching complex patterns', () => {
					expect(matchesFilter({ path: 'test/Button.tsx' }, { path: 'src/**/*.tsx' })).toBe(false);
				});
			});

			describe('boolean matching', () => {
				it('matches true boolean', () => {
					expect(matchesFilter({ active: true }, { active: true })).toBe(true);
				});

				it('rejects false when expecting true', () => {
					expect(matchesFilter({ active: false }, { active: true })).toBe(false);
				});

				it('matches false boolean', () => {
					expect(matchesFilter({ active: false }, { active: false })).toBe(true);
				});

				it('rejects true when expecting false', () => {
					expect(matchesFilter({ active: true }, { active: false })).toBe(false);
				});
			});

			describe('numeric equality', () => {
				it('matches exact numeric values', () => {
					expect(matchesFilter({ exitCode: 0 }, { exitCode: 0 })).toBe(true);
				});

				it('rejects non-matching numeric values', () => {
					expect(matchesFilter({ exitCode: 1 }, { exitCode: 0 })).toBe(false);
				});
			});

			describe('dot-notation nested access', () => {
				it('resolves nested payload fields', () => {
					const payload = { source: { status: 'completed' } };
					expect(matchesFilter(payload, { 'source.status': 'completed' })).toBe(true);
				});

				it('returns false for missing nested path', () => {
					const payload = { source: {} };
					expect(matchesFilter(payload, { 'source.status': 'completed' })).toBe(false);
				});

				it('handles deeply nested access', () => {
					const payload = { a: { b: { c: 'deep' } } };
					expect(matchesFilter(payload, { 'a.b.c': 'deep' })).toBe(true);
				});
			});

			describe('AND logic', () => {
				it('requires all conditions to pass', () => {
					const payload = { extension: '.ts', changeType: 'change', path: 'src/index.ts' };
					const filter = { extension: '.ts', changeType: 'change' };
					expect(matchesFilter(payload, filter)).toBe(true);
				});

				it('fails if any condition does not pass', () => {
					const payload = { extension: '.js', changeType: 'change' };
					const filter = { extension: '.ts', changeType: 'change' };
					expect(matchesFilter(payload, filter)).toBe(false);
				});
			});

			describe('missing payload fields', () => {
				it('fails when payload field is undefined', () => {
					expect(matchesFilter({}, { extension: '.ts' })).toBe(false);
				});

				it('fails when nested payload field is undefined', () => {
					expect(matchesFilter({ source: {} }, { 'source.missing': 'value' })).toBe(false);
				});
			});

			describe('NaN handling in numeric comparisons', () => {
				it('rejects non-numeric payload value with > filter', () => {
					expect(matchesFilter({ size: 'abc' }, { size: '>5' })).toBe(false);
				});

				it('rejects non-numeric payload value with >= filter', () => {
					expect(matchesFilter({ size: 'abc' }, { size: '>=5' })).toBe(false);
				});

				it('rejects non-numeric payload value with < filter', () => {
					expect(matchesFilter({ size: 'abc' }, { size: '<5' })).toBe(false);
				});

				it('rejects non-numeric payload value with <= filter', () => {
					expect(matchesFilter({ size: 'abc' }, { size: '<=5' })).toBe(false);
				});

				it('rejects non-numeric threshold in >= filter', () => {
					expect(matchesFilter({ size: 100 }, { size: '>=abc' })).toBe(false);
				});

				it('rejects non-numeric threshold in > filter', () => {
					expect(matchesFilter({ size: 100 }, { size: '>abc' })).toBe(false);
				});

				it('rejects non-numeric threshold in < filter', () => {
					expect(matchesFilter({ size: 100 }, { size: '<abc' })).toBe(false);
				});

				it('rejects non-numeric threshold in <= filter', () => {
					expect(matchesFilter({ size: 100 }, { size: '<=abc' })).toBe(false);
				});

				it('rejects empty string payload value with numeric filter', () => {
					expect(matchesFilter({ size: '' }, { size: '>0' })).toBe(false);
				});

				it('rejects empty string payload that would coerce to 0 with >=0 filter', () => {
					// Number('') === 0, but empty string is not a valid numeric operand
					expect(matchesFilter({ size: '' }, { size: '>=0' })).toBe(false);
				});

				it('rejects null payload value with numeric filter', () => {
					expect(matchesFilter({ size: null }, { size: '>=0' })).toBe(false);
				});

				it('rejects whitespace-only string with numeric filter', () => {
					expect(matchesFilter({ size: '  ' }, { size: '>0' })).toBe(false);
				});

				it('rejects Infinity payload value with numeric filter', () => {
					expect(matchesFilter({ size: Infinity }, { size: '>0' })).toBe(false);
				});

				it('rejects -Infinity payload value with numeric filter', () => {
					expect(matchesFilter({ size: -Infinity }, { size: '>0' })).toBe(false);
				});

				it('rejects NaN payload value with numeric filter', () => {
					expect(matchesFilter({ size: NaN }, { size: '>0' })).toBe(false);
				});

				it('rejects NaN threshold in filter expression', () => {
					expect(matchesFilter({ size: 100 }, { size: '>NaN' })).toBe(false);
				});

				it('rejects empty threshold in filter expression', () => {
					// filterValue '>=' sliced to '' → Number('') = 0, but should reject
					expect(matchesFilter({ size: 5 }, { size: '>=' })).toBe(false);
				});

				it('handles boolean payload coercion with numeric filter', () => {
					// Number(true) === 1, so true > 0 should pass
					expect(matchesFilter({ active: true }, { active: '>0' })).toBe(true);
					// Number(false) === 0, so false > 0 should fail
					expect(matchesFilter({ active: false }, { active: '>0' })).toBe(false);
				});
			});

			describe('empty filter', () => {
				it('matches everything when filter is empty', () => {
					expect(matchesFilter({ any: 'value' }, {})).toBe(true);
					expect(matchesFilter({}, {})).toBe(true);
				});
			});
		});

		describe('combined filter conditions', () => {
			it('combined numeric + glob in same filter object', () => {
				expect(
					matchesFilter({ size: 1500, path: 'src/app.ts' }, { size: '>1000', path: 'src/**/*.ts' })
				).toBe(true);
				expect(
					matchesFilter({ size: 500, path: 'src/app.ts' }, { size: '>1000', path: 'src/**/*.ts' })
				).toBe(false);
			});
		});

		describe('unicode handling', () => {
			it('matches unicode strings exactly', () => {
				expect(matchesFilter({ name: '日本語' }, { name: '日本語' })).toBe(true);
				expect(matchesFilter({ name: '日本語' }, { name: '中文' })).toBe(false);
			});
		});

		describe('deep dot notation', () => {
			it('resolves 4-level deep path', () => {
				expect(matchesFilter({ a: { b: { c: { d: 'found' } } } }, { 'a.b.c.d': 'found' })).toBe(
					true
				);
			});

			it('returns false for partial path', () => {
				expect(matchesFilter({ a: { b: 42 } }, { 'a.b.c': 'anything' })).toBe(false);
			});
		});

		describe('describeFilter', () => {
			it('describes exact string match', () => {
				expect(describeFilter({ extension: '.ts' })).toBe('extension == ".ts"');
			});

			it('describes negation', () => {
				expect(describeFilter({ status: '!archived' })).toBe('status != archived');
			});

			it('describes greater than', () => {
				expect(describeFilter({ size: '>1000' })).toBe('size > 1000');
			});

			it('describes less than', () => {
				expect(describeFilter({ priority: '<5' })).toBe('priority < 5');
			});

			it('describes greater than or equal', () => {
				expect(describeFilter({ score: '>=100' })).toBe('score >= 100');
			});

			it('describes less than or equal', () => {
				expect(describeFilter({ count: '<=10' })).toBe('count <= 10');
			});

			it('describes glob pattern', () => {
				expect(describeFilter({ path: '*.ts' })).toBe('path matches *.ts');
			});

			it('describes boolean', () => {
				expect(describeFilter({ active: true })).toBe('active is true');
			});

			it('describes numeric equality', () => {
				expect(describeFilter({ exitCode: 0 })).toBe('exitCode == 0');
			});

			it('joins multiple conditions with AND', () => {
				const result = describeFilter({ extension: '.ts', status: '!archived' });
				expect(result).toBe('extension == ".ts" AND status != archived');
			});
		});
	});
});
describeSourceSuite('cue-metrics', () => {
	describe('cue-metrics', () => {
		let metrics: CueMetricsCollector;

		beforeEach(() => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-04-21T10:00:00Z'));
			metrics = createCueMetrics();
		});

		afterEach(() => {
			// Restore real timers so other suites aren't polluted.
			vi.useRealTimers();
		});

		describe('snapshot', () => {
			it('returns all counters zeroed on construction', () => {
				const snap = metrics.snapshot();
				expect(snap.runsStarted).toBe(0);
				expect(snap.runsCompleted).toBe(0);
				expect(snap.runsFailed).toBe(0);
				expect(snap.runsTimedOut).toBe(0);
				expect(snap.runsStopped).toBe(0);
				expect(snap.eventsDropped).toBe(0);
				expect(snap.queueRestored).toBe(0);
				expect(snap.fanInTimeouts).toBe(0);
				expect(snap.fanInCompletions).toBe(0);
				expect(snap.githubPollErrors).toBe(0);
				expect(snap.rateLimitBackoffs).toBe(0);
				expect(snap.configReloads).toBe(0);
				expect(snap.pathTraversalsBlocked).toBe(0);
				expect(snap.heartbeatFailures).toBe(0);
			});

			it('records startedAt as construction time', () => {
				expect(metrics.snapshot().startedAt).toBe(new Date('2026-04-21T10:00:00Z').getTime());
			});

			it('returns a fresh object each call (no shared reference)', () => {
				const a = metrics.snapshot();
				const b = metrics.snapshot();
				expect(a).not.toBe(b);
				a.runsStarted = 999;
				expect(metrics.snapshot().runsStarted).toBe(0);
			});
		});

		describe('increment', () => {
			it('bumps the targeted key by 1 by default', () => {
				metrics.increment('runsStarted');
				expect(metrics.snapshot().runsStarted).toBe(1);
			});

			it('bumps the targeted key by an explicit amount', () => {
				metrics.increment('eventsDropped', 5);
				expect(metrics.snapshot().eventsDropped).toBe(5);
			});

			it('accumulates across multiple calls', () => {
				metrics.increment('runsCompleted');
				metrics.increment('runsCompleted');
				metrics.increment('runsCompleted', 3);
				expect(metrics.snapshot().runsCompleted).toBe(5);
			});

			it('independent keys do not cross-contaminate', () => {
				metrics.increment('runsStarted', 2);
				metrics.increment('runsFailed', 7);
				const snap = metrics.snapshot();
				expect(snap.runsStarted).toBe(2);
				expect(snap.runsFailed).toBe(7);
				expect(snap.runsCompleted).toBe(0);
			});

			it('accepts zero and negative increments (decrement semantics)', () => {
				metrics.increment('runsStarted', 5);
				metrics.increment('runsStarted', -2);
				metrics.increment('runsStarted', 0);
				expect(metrics.snapshot().runsStarted).toBe(3);
			});
		});

		describe('reset', () => {
			it('returns all counters to zero', () => {
				metrics.increment('runsStarted', 10);
				metrics.increment('eventsDropped', 5);
				metrics.reset();
				const snap = metrics.snapshot();
				expect(snap.runsStarted).toBe(0);
				expect(snap.eventsDropped).toBe(0);
			});

			it('updates startedAt to the reset time', () => {
				vi.setSystemTime(new Date('2026-04-21T11:00:00Z'));
				metrics.reset();
				expect(metrics.snapshot().startedAt).toBe(new Date('2026-04-21T11:00:00Z').getTime());
			});

			it('allows fresh increments after reset', () => {
				metrics.increment('runsStarted', 10);
				metrics.reset();
				metrics.increment('runsStarted');
				expect(metrics.snapshot().runsStarted).toBe(1);
			});
		});
	});
});
