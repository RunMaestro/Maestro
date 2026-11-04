// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/main/cue/cue-session-registry.test.ts
// Source: src/__tests__/main/cue/cue-text-utils.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
	createCueSessionRegistry,
	type CueSessionRegistry,
} from '../../../main/cue/cue-session-registry';
import type { SessionState } from '../../../main/cue/cue-session-state';
import type { CueConfig } from '../../../main/cue/cue-types';
import {
	buildCuePersistedOutput,
	MAX_HISTORY_RESPONSE_LENGTH,
	sliceHeadByChars,
	sliceTailByChars,
} from '../../../main/cue/cue-text-utils';
// Source: src/__tests__/main/cue/cue-session-registry.test.ts
describe('', () => {
	function makeState(overrides: Partial<SessionState> = {}): SessionState {
		const config: CueConfig = {
			subscriptions: [],
			settings: {
				timeout_minutes: 30,
				timeout_on_fail: 'break',
				max_concurrent: 1,
				queue_size: 10,
			},
		};
		return {
			config,
			triggerSources: [],
			sleepPrevented: false,
			...overrides,
		};
	}
	describe('cue-session-registry', () => {
		let registry: CueSessionRegistry;
		beforeEach(() => {
			registry = createCueSessionRegistry();
		});
		describe('session lifecycle', () => {
			it('register / get / has / size', () => {
				expect(registry.size()).toBe(0);
				expect(registry.has('s1')).toBe(false);
				expect(registry.get('s1')).toBeUndefined();
				const state = makeState();
				registry.register('s1', state);
				expect(registry.size()).toBe(1);
				expect(registry.has('s1')).toBe(true);
				expect(registry.get('s1')).toBe(state);
			});
			it('unregister removes a session', () => {
				registry.register('s1', makeState());
				registry.register('s2', makeState());
				registry.unregister('s1');
				expect(registry.has('s1')).toBe(false);
				expect(registry.has('s2')).toBe(true);
				expect(registry.size()).toBe(1);
			});
			it('snapshot returns a defensive copy of the session map', () => {
				const stateA = makeState();
				const stateB = makeState();
				registry.register('s1', stateA);
				registry.register('s2', stateB);
				const snapshot = registry.snapshot();
				expect(snapshot.size).toBe(2);
				expect(snapshot.get('s1')).toBe(stateA);
				expect(snapshot.get('s2')).toBe(stateB);
				// Mutating the snapshot does NOT affect the registry.
				snapshot.delete('s1');
				expect(registry.has('s1')).toBe(true);
			});
		});
		describe('time.scheduled dedup', () => {
			it('markScheduledFired returns true on first fire, false on duplicate', () => {
				expect(registry.markScheduledFired('s1', 'sub-1', '09:00')).toBe(true);
				expect(registry.markScheduledFired('s1', 'sub-1', '09:00')).toBe(false);
			});
			it('different time slots are independent', () => {
				expect(registry.markScheduledFired('s1', 'sub-1', '09:00')).toBe(true);
				expect(registry.markScheduledFired('s1', 'sub-1', '10:00')).toBe(true);
			});
			it('different sessions are independent', () => {
				expect(registry.markScheduledFired('s1', 'sub-1', '09:00')).toBe(true);
				expect(registry.markScheduledFired('s2', 'sub-1', '09:00')).toBe(true);
			});
			it('different sub names are independent', () => {
				expect(registry.markScheduledFired('s1', 'sub-1', '09:00')).toBe(true);
				expect(registry.markScheduledFired('s1', 'sub-2', '09:00')).toBe(true);
			});
			it('evictStaleScheduledKeys removes keys for the same (session, sub) with non-current time', () => {
				registry.markScheduledFired('s1', 'sub-1', '08:00');
				registry.markScheduledFired('s1', 'sub-1', '09:00');
				registry.markScheduledFired('s1', 'sub-1', '10:00');
				registry.evictStaleScheduledKeys('s1', 'sub-1', '10:00');
				// 08:00 and 09:00 are evicted; 10:00 stays - re-firing 10:00 must still be deduped.
				expect(registry.markScheduledFired('s1', 'sub-1', '08:00')).toBe(true);
				expect(registry.markScheduledFired('s1', 'sub-1', '09:00')).toBe(true);
				expect(registry.markScheduledFired('s1', 'sub-1', '10:00')).toBe(false);
			});
			it('evictStaleScheduledKeys does not touch other sessions or subs', () => {
				registry.markScheduledFired('s1', 'sub-1', '08:00');
				registry.markScheduledFired('s2', 'sub-1', '08:00');
				registry.markScheduledFired('s1', 'sub-2', '08:00');
				registry.evictStaleScheduledKeys('s1', 'sub-1', '09:00');
				// Only s1:sub-1 is evicted.
				expect(registry.markScheduledFired('s1', 'sub-1', '08:00')).toBe(true);
				expect(registry.markScheduledFired('s2', 'sub-1', '08:00')).toBe(false);
				expect(registry.markScheduledFired('s1', 'sub-2', '08:00')).toBe(false);
			});
			it('clearScheduledForSession drops all scheduled keys for that session', () => {
				registry.markScheduledFired('s1', 'sub-1', '08:00');
				registry.markScheduledFired('s1', 'sub-2', '09:00');
				registry.markScheduledFired('s2', 'sub-1', '08:00');
				registry.clearScheduledForSession('s1');
				expect(registry.markScheduledFired('s1', 'sub-1', '08:00')).toBe(true);
				expect(registry.markScheduledFired('s1', 'sub-2', '09:00')).toBe(true);
				// s2 untouched
				expect(registry.markScheduledFired('s2', 'sub-1', '08:00')).toBe(false);
			});
		});
		describe('app.startup dedup', () => {
			it('markStartupFired returns true on first fire, false on duplicate', () => {
				expect(registry.markStartupFired('s1', 'init')).toBe(true);
				expect(registry.markStartupFired('s1', 'init')).toBe(false);
			});
			it('different sessions are independent', () => {
				expect(registry.markStartupFired('s1', 'init')).toBe(true);
				expect(registry.markStartupFired('s2', 'init')).toBe(true);
			});
			it("clearStartupForSession drops only that session's startup keys", () => {
				registry.markStartupFired('s1', 'init-a');
				registry.markStartupFired('s1', 'init-b');
				registry.markStartupFired('s2', 'init-a');
				registry.clearStartupForSession('s1');
				expect(registry.markStartupFired('s1', 'init-a')).toBe(true);
				expect(registry.markStartupFired('s1', 'init-b')).toBe(true);
				// s2 untouched
				expect(registry.markStartupFired('s2', 'init-a')).toBe(false);
			});
		});
		describe('clearAllStartupKeys', () => {
			it('clears all startup fired-keys so subsequent fires are allowed', () => {
				registry.markStartupFired('s1', 'init-a');
				registry.markStartupFired('s1', 'init-b');
				registry.markStartupFired('s2', 'init-a');
				registry.clearAllStartupKeys();
				expect(registry.markStartupFired('s1', 'init-a')).toBe(true);
				expect(registry.markStartupFired('s1', 'init-b')).toBe(true);
				expect(registry.markStartupFired('s2', 'init-a')).toBe(true);
			});
			it('does not affect sessions, scheduled keys, or session state', () => {
				registry.register('s1', makeState());
				registry.markScheduledFired('s1', 'sub-1', '09:00');
				registry.markStartupFired('s1', 'init');
				registry.clearAllStartupKeys();
				expect(registry.has('s1')).toBe(true);
				expect(registry.markScheduledFired('s1', 'sub-1', '09:00')).toBe(false); // still deduped
			});
		});
		describe('clear', () => {
			it('drops all sessions and time.scheduled keys but PRESERVES startup keys', () => {
				registry.register('s1', makeState());
				registry.register('s2', makeState());
				registry.markScheduledFired('s1', 'sub-1', '09:00');
				registry.markStartupFired('s1', 'init');
				registry.markStartupFired('s2', 'init');
				registry.clear();
				// Sessions are gone.
				expect(registry.size()).toBe(0);
				expect(registry.has('s1')).toBe(false);
				// Scheduled keys are gone - re-firing the same slot succeeds.
				expect(registry.markScheduledFired('s1', 'sub-1', '09:00')).toBe(true);
				// Startup keys are PRESERVED - re-firing must be deduped. This is the
				// regression target: toggling Cue off/on must NOT re-fire app.startup.
				expect(registry.markStartupFired('s1', 'init')).toBe(false);
				expect(registry.markStartupFired('s2', 'init')).toBe(false);
			});
			it('clear is idempotent', () => {
				registry.register('s1', makeState());
				registry.clear();
				registry.clear();
				expect(registry.size()).toBe(0);
			});
		});
		describe('sweepStaleScheduledKeys', () => {
			it('returns 0 and does nothing when no keys exist', () => {
				const evicted = registry.sweepStaleScheduledKeys('09:00');
				expect(evicted).toBe(0);
			});
			it('does not evict a key that matches the current time', () => {
				registry.markScheduledFired('s1', 'sub-1', '09:00');
				const evicted = registry.sweepStaleScheduledKeys('09:00');
				expect(evicted).toBe(0);
				// Key still in set - re-firing is still deduped
				expect(registry.markScheduledFired('s1', 'sub-1', '09:00')).toBe(false);
			});
			it('evicts keys whose time component differs from the current time', () => {
				registry.markScheduledFired('s1', 'sub-1', '08:59');
				registry.markScheduledFired('s1', 'sub-1', '09:00');
				// At 09:01 - the 08:59 key is stale, the 09:00 key is also stale
				const evicted = registry.sweepStaleScheduledKeys('09:01');
				expect(evicted).toBe(2);
				// After eviction, both slots can fire again
				expect(registry.markScheduledFired('s1', 'sub-1', '08:59')).toBe(true);
				expect(registry.markScheduledFired('s1', 'sub-1', '09:00')).toBe(true);
			});
			it('evicts stale keys across multiple sessions and subscriptions', () => {
				registry.markScheduledFired('s1', 'sub-a', '10:00');
				registry.markScheduledFired('s2', 'sub-b', '10:00');
				registry.markScheduledFired('s1', 'sub-a', '10:01');
				const evicted = registry.sweepStaleScheduledKeys('10:01');
				// The two 10:00 keys are stale; the 10:01 key is current
				expect(evicted).toBe(2);
			});
			it('does not affect startup fired keys', () => {
				registry.markStartupFired('s1', 'init');
				registry.sweepStaleScheduledKeys('09:00');
				// Startup key is unaffected - still deduped
				expect(registry.markStartupFired('s1', 'init')).toBe(false);
			});
		});
		describe('heartbeat last run', () => {
			it('records the latest run per (session, sub)', () => {
				expect(registry.heartbeatFiredAt('s1', 'beat')).toBeUndefined();
				registry.markHeartbeatFired('s1', 'beat', 1000);
				registry.markHeartbeatFired('s1', 'beat', 2000);
				registry.markHeartbeatFired('s2', 'beat', 5000);
				expect(registry.heartbeatFiredAt('s1', 'beat')).toBe(2000);
				expect(registry.heartbeatFiredAt('s2', 'beat')).toBe(5000);
			});
			it('forgets a session on unregister and everything on clear', () => {
				registry.markHeartbeatFired('s1', 'beat', 1000);
				registry.markHeartbeatFired('s2', 'beat', 1000);
				registry.unregister('s1');
				expect(registry.heartbeatFiredAt('s1', 'beat')).toBeUndefined();
				expect(registry.heartbeatFiredAt('s2', 'beat')).toBe(1000);
				registry.clear();
				expect(registry.heartbeatFiredAt('s2', 'beat')).toBeUndefined();
			});
		});
	});
});
// Source: src/__tests__/main/cue/cue-text-utils.test.ts
describe('', () => {
	// A supplementary-plane code point (U+1F600 😀) encodes as the surrogate pair
	// D83D DE00 - two UTF-16 code units. A naive `.slice()` that lands between
	// them produces a lone surrogate that downstream consumers see as garbage.
	const EMOJI = '😀'; // 2 code units
	const TREE = '🌳'; // 2 code units
	const HEART = '❤'; // 1 code unit
	describe('sliceTailByChars', () => {
		it('returns the full string when shorter than max', () => {
			expect(sliceTailByChars('hello', 10)).toBe('hello');
		});
		it('returns the full string when exactly equal to max', () => {
			expect(sliceTailByChars('hello', 5)).toBe('hello');
		});
		it('returns empty string for maxChars <= 0', () => {
			expect(sliceTailByChars('hello', 0)).toBe('');
			expect(sliceTailByChars('hello', -1)).toBe('');
		});
		it('returns empty string for empty input', () => {
			expect(sliceTailByChars('', 5)).toBe('');
		});
		it('returns the last N ASCII chars when plain text', () => {
			expect(sliceTailByChars('abcdefghij', 3)).toBe('hij');
		});
		it('does not split a surrogate pair at the start of the slice', () => {
			// "ab" + "😀" → len 4 (a=1, b=1, 😀=2). slice(-3) would start at index 1,
			// landing on the b; slice(-2) lands on the high surrogate of 😀; slice(-1)
			// lands on the low surrogate and must shift forward to return just "".
			const input = 'ab' + EMOJI;
			const low = sliceTailByChars(input, 1);
			// The tail was a lone low surrogate; helper must strip it rather than
			// emit a broken half-emoji.
			expect(low).not.toMatch(/[\uDC00-\uDFFF]/);
		});
		it('includes the full emoji when the slice boundary lands exactly on the high surrogate', () => {
			// slice(-2) on "ab😀" lands on 😀's high surrogate - the whole emoji
			// fits, so the helper should return it intact.
			const input = 'ab' + EMOJI;
			expect(sliceTailByChars(input, 2)).toBe(EMOJI);
		});
		it('preserves adjacent emojis when they both fit', () => {
			const input = 'xx' + EMOJI + TREE; // 2 + 2 + 2 = 6 units
			expect(sliceTailByChars(input, 4)).toBe(EMOJI + TREE);
		});
		it('handles BMP characters (single code units) unchanged', () => {
			const input = 'x' + HEART + 'y'; // each is 1 unit
			expect(sliceTailByChars(input, 2)).toBe(HEART + 'y');
		});
		it('handles a string of only emoji', () => {
			const input = EMOJI + EMOJI + EMOJI;
			const result = sliceTailByChars(input, 3);
			// Must not start with a lone low surrogate
			expect(result).not.toMatch(/^[\uDC00-\uDFFF]/);
		});
	});
	describe('sliceHeadByChars', () => {
		it('returns the full string when shorter than max', () => {
			expect(sliceHeadByChars('hello', 10)).toBe('hello');
		});
		it('returns empty string for maxChars <= 0', () => {
			expect(sliceHeadByChars('hello', 0)).toBe('');
			expect(sliceHeadByChars('hello', -1)).toBe('');
		});
		it('returns empty string for empty input', () => {
			expect(sliceHeadByChars('', 5)).toBe('');
		});
		it('returns the first N ASCII chars', () => {
			expect(sliceHeadByChars('abcdefghij', 3)).toBe('abc');
		});
		it('does not split a surrogate pair at the end of the slice', () => {
			// "a" + "😀" + "b" → boundaries at 1,3,4. slice(0,2) lands between the
			// high and low surrogates - helper must step back to "a".
			const input = 'a' + EMOJI + 'b';
			const result = sliceHeadByChars(input, 2);
			expect(result).toBe('a');
			expect(result).not.toMatch(/[\uD800-\uDBFF]$/);
		});
		it('includes the full emoji when it just fits', () => {
			const input = 'a' + EMOJI + 'b';
			expect(sliceHeadByChars(input, 3)).toBe('a' + EMOJI);
		});
		it('handles a string of only emoji', () => {
			const input = EMOJI + EMOJI + EMOJI;
			const result = sliceHeadByChars(input, 3);
			// Must not end with a lone high surrogate
			expect(result).not.toMatch(/[\uD800-\uDBFF]$/);
		});
		it('handles BMP characters (single code units) unchanged', () => {
			const input = HEART + HEART + HEART;
			expect(sliceHeadByChars(input, 2)).toBe(HEART + HEART);
		});
	});
	describe('buildCuePersistedOutput', () => {
		it('returns null for both fields when the run printed nothing', () => {
			// NULL (not '') is what makes `WHERE output_excerpt IS NOT NULL` the
			// noise filter on cue_events - a heartbeat that says nothing must not
			// leave a row that looks like it has something to read.
			expect(buildCuePersistedOutput({ stdout: '', stderr: '' })).toEqual({
				excerpt: null,
				fullOutput: null,
			});
		});
		it('treats whitespace-only output as silent', () => {
			expect(buildCuePersistedOutput({ stdout: '   \n\t ', stderr: '' }).excerpt).toBeNull();
		});
		it('excerpts stdout for a chatty run and carries the full output', () => {
			const { excerpt, fullOutput } = buildCuePersistedOutput({
				stdout: 'Reviewed 3 PRs. Merged the docs fix.',
				stderr: '',
			});
			expect(excerpt).toBe('Reviewed 3 PRs. Merged the docs fix.');
			expect(fullOutput).toBe('Reviewed 3 PRs. Merged the docs fix.');
		});
		it('falls back to stderr for the excerpt when stdout is empty', () => {
			// A failed run kept for its error output must not be reduced to a bare
			// trigger label. fullOutput stays null - stderr has its own column.
			const { excerpt, fullOutput } = buildCuePersistedOutput({
				stdout: '',
				stderr: 'Agent exited with status 3.',
			});
			expect(excerpt).toBe('Agent exited with status 3.');
			expect(fullOutput).toBeNull();
		});
		it('head-truncates full output at the persisted cap', () => {
			const long = 'x'.repeat(MAX_HISTORY_RESPONSE_LENGTH + 500);
			const { fullOutput } = buildCuePersistedOutput({ stdout: long, stderr: '' });
			expect(fullOutput).toHaveLength(MAX_HISTORY_RESPONSE_LENGTH);
		});
		it('excerpts a stdout that is only a fenced table instead of calling the run silent', () => {
			// Seen live on 2026-10-14: this stdout persisted a NULL excerpt beside a
			// non-null full output, so History hid a run that had answered.
			const stdout = '```\n| billing-api | 2.7.0 | raza |\n```';
			const { excerpt, fullOutput } = buildCuePersistedOutput({
				stdout,
				stderr: 'warning: cache miss',
			});
			expect(excerpt).toBe('billing-api · 2.7.0 · raza');
			expect(fullOutput).toBe(stdout);
		});
		it('gives every run with visible stdout a non-null excerpt', () => {
			for (const stdout of [
				'```\n| a | b |\n```',
				'| a | b |\n|---|---|',
				'x'.repeat(500),
				`${'long sentence '.repeat(40)}end`,
				'```\n```',
			]) {
				expect(buildCuePersistedOutput({ stdout, stderr: '' }).excerpt).not.toBeNull();
			}
		});
		it('strips ANSI codes out of the excerpt', () => {
			const { excerpt } = buildCuePersistedOutput({
				stdout: '\u001b[32mBuild passed.\u001b[0m',
				stderr: '',
			});
			expect(excerpt).toBe('Build passed.');
		});
	});
});
