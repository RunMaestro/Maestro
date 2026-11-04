// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/utils/jqFilter.test.ts
// Source: src/__tests__/renderer/utils/jumpHighlight.test.ts
// Source: src/__tests__/renderer/utils/launchFromSettings.test.ts
// Source: src/__tests__/renderer/utils/liveTurnReattach.test.ts
// Source: src/__tests__/renderer/utils/logEntries.test.ts
// Source: src/__tests__/renderer/utils/logger.test.ts
// Source: src/__tests__/renderer/utils/loginUrl.test.ts
// Source: src/__tests__/renderer/utils/markdownTasks.test.ts
// Source: src/__tests__/renderer/utils/sessionJumpSlots.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseJq, evaluateJq, applyJqFilter } from '../../../renderer/utils/jqFilter';
import {
	flashJumpTarget,
	jumpToElement,
	JUMP_FLASH_DURATION_MS,
} from '../../../renderer/utils/jumpHighlight';
import { launchFromSettings } from '../../../renderer/utils/launchFromSettings';
import { useModalStore } from '../../../renderer/stores/modalStore';
import { resolveLiveAiTurns, applyLiveAiTurns } from '../../../renderer/utils/liveTurnReattach';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import {
	canAppendToLogEntry,
	dropRecoveredOutageNotices,
	isSelfContainedCard,
	steerJoinsRunningTurn,
} from '../../../renderer/utils/logEntries';
import type { LogEntry } from '../../../renderer/types';
import { logger, LogLevel } from '../../../renderer/utils/logger';
import { findLoginUrl } from '../../../renderer/utils/loginUrl';
import { taskTextAtLine, toggleTaskCheckboxAtLine } from '../../../renderer/utils/markdownTasks';
import {
	buildSessionJumpSlotMap,
	sessionJumpShortcut,
	sessionJumpSlotDigit,
} from '../../../renderer/utils/sessionJumpSlots';
// Source: src/__tests__/renderer/utils/jqFilter.test.ts
describe('', () => {
	function jq(expr: string, data: unknown): unknown[] {
		return evaluateJq(parseJq(expr), data);
	}
	const SAMPLE = {
		type: 'queue-operation',
		operation: 'enqueue',
		timestamp: '2026-04-15T01:14:45.942Z',
		count: 42,
		active: true,
		tags: ['urgent', 'backend'],
		nested: { a: { b: 1 } },
		items: [
			{ name: 'x', val: 10 },
			{ name: 'y', val: 20 },
			{ name: 'z', val: 5 },
		],
	};
	// ── Identity & Literals ──────────────────────────────────────────────────────
	describe('identity and literals', () => {
		it('. returns input', () => {
			expect(jq('.', SAMPLE)).toEqual([SAMPLE]);
		});
		it('string literal', () => {
			expect(jq('"hello"', null)).toEqual(['hello']);
		});
		it('number literal', () => {
			expect(jq('42', null)).toEqual([42]);
		});
		it('negative number', () => {
			expect(jq('-3', null)).toEqual([-3]);
		});
		it('boolean and null literals', () => {
			expect(jq('true', null)).toEqual([true]);
			expect(jq('false', null)).toEqual([false]);
			expect(jq('null', null)).toEqual([null]);
		});
	});
	// ── Field Access ─────────────────────────────────────────────────────────────
	describe('field access', () => {
		it('.field extracts a field', () => {
			expect(jq('.type', SAMPLE)).toEqual(['queue-operation']);
		});
		it('.field.nested navigates nested fields', () => {
			expect(jq('.nested.a.b', SAMPLE)).toEqual([1]);
		});
		it('missing field returns null', () => {
			expect(jq('.nonexistent', SAMPLE)).toEqual([null]);
		});
		it('.field on null returns null', () => {
			expect(jq('.foo', null)).toEqual([null]);
		});
		it('quoted field with .["name"]', () => {
			expect(jq('.["type"]', SAMPLE)).toEqual(['queue-operation']);
		});
	});
	// ── Array Indexing ───────────────────────────────────────────────────────────
	describe('array indexing', () => {
		it('.[n] returns nth element', () => {
			expect(jq('.[0]', [10, 20, 30])).toEqual([10]);
			expect(jq('.[2]', [10, 20, 30])).toEqual([30]);
		});
		it('.[-n] indexes from end', () => {
			expect(jq('.[-1]', [10, 20, 30])).toEqual([30]);
			expect(jq('.[-2]', [10, 20, 30])).toEqual([20]);
		});
		it('.field[n] chains field and index', () => {
			expect(jq('.tags[0]', SAMPLE)).toEqual(['urgent']);
		});
		it('out of bounds returns null', () => {
			expect(jq('.[99]', [1, 2, 3])).toEqual([null]);
		});
	});
	// ── Iteration ────────────────────────────────────────────────────────────────
	describe('iteration', () => {
		it('.[] iterates array', () => {
			expect(jq('.[]', [1, 2, 3])).toEqual([1, 2, 3]);
		});
		it('.[] iterates object values', () => {
			const result = jq('.[]', { a: 1, b: 2 });
			expect(result).toEqual([1, 2]);
		});
		it('.field[] chains field and iteration', () => {
			expect(jq('.tags[]', SAMPLE)).toEqual(['urgent', 'backend']);
		});
	});
	// ── Pipe ─────────────────────────────────────────────────────────────────────
	describe('pipe', () => {
		it('chains expressions with |', () => {
			expect(jq('.nested | .a | .b', SAMPLE)).toEqual([1]);
		});
		it('pipe feeds each left result into right', () => {
			expect(jq('.tags[] | length', SAMPLE)).toEqual([6, 7]);
		});
	});
	// ── Comma (multiple outputs) ─────────────────────────────────────────────────
	describe('comma', () => {
		it('produces multiple outputs', () => {
			expect(jq('.type, .operation', SAMPLE)).toEqual(['queue-operation', 'enqueue']);
		});
	});
	// ── Comparison ───────────────────────────────────────────────────────────────
	describe('comparison', () => {
		it('== compares values', () => {
			expect(jq('.count == 42', SAMPLE)).toEqual([true]);
			expect(jq('.count == 99', SAMPLE)).toEqual([false]);
		});
		it('!= compares inequality', () => {
			expect(jq('.type != "error"', SAMPLE)).toEqual([true]);
		});
		it('numeric comparisons', () => {
			expect(jq('.count > 10', SAMPLE)).toEqual([true]);
			expect(jq('.count < 10', SAMPLE)).toEqual([false]);
			expect(jq('.count >= 42', SAMPLE)).toEqual([true]);
			expect(jq('.count <= 42', SAMPLE)).toEqual([true]);
		});
		it('string equality', () => {
			expect(jq('.type == "queue-operation"', SAMPLE)).toEqual([true]);
		});
	});
	// ── Boolean Logic ────────────────────────────────────────────────────────────
	describe('boolean logic', () => {
		it('and combines conditions', () => {
			expect(jq('.active and .count == 42', SAMPLE)).toEqual([true]);
			expect(jq('.active and .count == 99', SAMPLE)).toEqual([false]);
		});
		it('or combines conditions', () => {
			expect(jq('.count == 99 or .active', SAMPLE)).toEqual([true]);
		});
		it('not negates', () => {
			expect(jq('false | not', null)).toEqual([true]);
			expect(jq('true | not', null)).toEqual([false]);
		});
	});
	// ── Select ───────────────────────────────────────────────────────────────────
	describe('select', () => {
		it('select passes matching input through', () => {
			expect(jq('select(.type == "queue-operation")', SAMPLE)).toEqual([SAMPLE]);
		});
		it('select filters non-matching input', () => {
			expect(jq('select(.type == "error")', SAMPLE)).toEqual([]);
		});
		it('select with contains', () => {
			expect(jq('select(.type | contains("queue"))', SAMPLE)).toEqual([SAMPLE]);
		});
		it('select with and', () => {
			expect(jq('select(.active and .count > 10)', SAMPLE)).toEqual([SAMPLE]);
		});
		it('select with not', () => {
			expect(jq('select(.type == "error" | not)', SAMPLE)).toEqual([SAMPLE]);
		});
	});
	// ── Built-in Functions ───────────────────────────────────────────────────────
	describe('built-in functions', () => {
		it('keys returns sorted keys', () => {
			expect(jq('keys', { b: 2, a: 1 })).toEqual([['a', 'b']]);
		});
		it('values returns values', () => {
			expect(jq('values', { a: 1, b: 2 })).toEqual([[1, 2]]);
		});
		it('length on string', () => {
			expect(jq('.type | length', SAMPLE)).toEqual([15]);
		});
		it('length on array', () => {
			expect(jq('.tags | length', SAMPLE)).toEqual([2]);
		});
		it('length on object', () => {
			expect(jq('length', { a: 1, b: 2 })).toEqual([2]);
		});
		it('type returns type name', () => {
			expect(jq('type', 'hello')).toEqual(['string']);
			expect(jq('type', 42)).toEqual(['number']);
			expect(jq('type', null)).toEqual(['null']);
			expect(jq('type', [1])).toEqual(['array']);
			expect(jq('type', {})).toEqual(['object']);
		});
		it('has checks key existence', () => {
			expect(jq('has("type")', SAMPLE)).toEqual([true]);
			expect(jq('has("nope")', SAMPLE)).toEqual([false]);
		});
		it('contains checks string containment (case-insensitive)', () => {
			expect(jq('. | contains("QUEUE")', 'queue-operation')).toEqual([true]);
			expect(jq('. | contains("nope")', 'queue-operation')).toEqual([false]);
		});
		it('startswith / endswith', () => {
			expect(jq('.type | startswith("queue")', SAMPLE)).toEqual([true]);
			expect(jq('.type | endswith("tion")', SAMPLE)).toEqual([true]);
		});
		it('test with regex', () => {
			expect(jq('.type | test("queue.*")', SAMPLE)).toEqual([true]);
			expect(jq('.type | test("^error")', SAMPLE)).toEqual([false]);
		});
		it('map transforms array elements', () => {
			expect(jq('.items | map(.name)', SAMPLE)).toEqual([['x', 'y', 'z']]);
		});
		it('sort sorts array', () => {
			expect(jq('sort', [3, 1, 2])).toEqual([[1, 2, 3]]);
		});
		it('sort_by sorts by key', () => {
			expect(jq('.items | sort_by(.val) | map(.name)', SAMPLE)).toEqual([['z', 'x', 'y']]);
		});
		it('unique deduplicates', () => {
			expect(jq('unique', [1, 2, 1, 3, 2])).toEqual([[1, 2, 3]]);
		});
		it('reverse reverses array', () => {
			expect(jq('reverse', [1, 2, 3])).toEqual([[3, 2, 1]]);
		});
		it('flatten flattens nested arrays', () => {
			expect(
				jq('flatten', [
					[1, 2],
					[3, [4]],
				])
			).toEqual([[1, 2, 3, 4]]);
		});
		it('add sums numbers', () => {
			expect(jq('add', [1, 2, 3])).toEqual([6]);
		});
		it('add concatenates strings', () => {
			expect(jq('add', ['a', 'b', 'c'])).toEqual(['abc']);
		});
		it('min / max', () => {
			expect(jq('min', [3, 1, 2])).toEqual([1]);
			expect(jq('max', [3, 1, 2])).toEqual([3]);
		});
		it('first / last', () => {
			expect(jq('first', [10, 20, 30])).toEqual([10]);
			expect(jq('last', [10, 20, 30])).toEqual([30]);
		});
		it('to_entries', () => {
			expect(jq('to_entries', { a: 1, b: 2 })).toEqual([
				[
					{ key: 'a', value: 1 },
					{ key: 'b', value: 2 },
				],
			]);
		});
		it('ascii_downcase / ascii_upcase', () => {
			expect(jq('ascii_downcase', 'Hello')).toEqual(['hello']);
			expect(jq('ascii_upcase', 'Hello')).toEqual(['HELLO']);
		});
		it('split / join', () => {
			expect(jq('split(",")', 'a,b,c')).toEqual([['a', 'b', 'c']]);
			expect(jq('join("-")', ['a', 'b', 'c'])).toEqual(['a-b-c']);
		});
		it('tonumber / tostring', () => {
			expect(jq('tonumber', '42')).toEqual([42]);
			expect(jq('tostring', 42)).toEqual(['42']);
		});
		it('empty produces no output', () => {
			expect(jq('empty', 'anything')).toEqual([]);
		});
	});
	// ── Complex Expressions ──────────────────────────────────────────────────────
	describe('complex expressions', () => {
		it('select + projection', () => {
			const result = jq('select(.count > 10) | .type', SAMPLE);
			expect(result).toEqual(['queue-operation']);
		});
		it('iterate + select', () => {
			const result = jq('.items[] | select(.val > 10)', SAMPLE);
			expect(result).toEqual([{ name: 'y', val: 20 }]);
		});
		it('iterate + field + collect', () => {
			const result = jq('.items | map(select(.val >= 10) | .name)', SAMPLE);
			expect(result).toEqual([['x', 'y']]);
		});
		it('nested pipe chain', () => {
			expect(jq('.items | sort_by(.val) | first | .name', SAMPLE)).toEqual(['z']);
		});
		it('group_by', () => {
			const data = [
				{ t: 'a', v: 1 },
				{ t: 'b', v: 2 },
				{ t: 'a', v: 3 },
			];
			const result = jq('group_by(.t)', data);
			expect(result).toEqual([
				[
					[
						{ t: 'a', v: 1 },
						{ t: 'a', v: 3 },
					],
					[{ t: 'b', v: 2 }],
				],
			]);
		});
		it('min_by / max_by', () => {
			expect(jq('.items | min_by(.val) | .name', SAMPLE)).toEqual(['z']);
			expect(jq('.items | max_by(.val) | .name', SAMPLE)).toEqual(['y']);
		});
		it('try suppresses errors', () => {
			expect(jq('.foo.bar?', 42)).toEqual([null]);
			expect(() => jq('keys', 42)).toThrow();
			expect(jq('keys?', 42)).toEqual([]);
		});
	});
	// ── Error Handling ───────────────────────────────────────────────────────────
	describe('error handling', () => {
		it('unknown function throws', () => {
			expect(() => jq('bogus', null)).toThrow(/Unknown function/);
		});
		it('unterminated string throws', () => {
			expect(() => parseJq('"oops')).toThrow(/Unterminated string/);
		});
		it('unexpected token throws', () => {
			expect(() => parseJq(']')).toThrow();
		});
		it('applyJqFilter returns error for invalid expression', () => {
			const result = applyJqFilter('}}}', null);
			expect(result.error).toBeTruthy();
			expect(result.results).toEqual([]);
		});
		it('applyJqFilter works for valid expression', () => {
			const result = applyJqFilter('.type', SAMPLE);
			expect(result.error).toBeUndefined();
			expect(result.results).toEqual(['queue-operation']);
		});
	});
	// ── Grouped expression ──────────────────────────────────────────────────────
	describe('grouped expressions', () => {
		it('parentheses group subexpressions', () => {
			expect(jq('(.type)', SAMPLE)).toEqual(['queue-operation']);
		});
	});
});
// Source: src/__tests__/renderer/utils/jumpHighlight.test.ts
describe('', () => {
	/**
	 * jsdom has no layout engine: offsetParent is always null and scrollIntoView is
	 * undefined. Both are stubbed so the retry loop and the scroll call are
	 * observable.
	 */
	function makeTarget(): HTMLElement {
		const el = document.createElement('div');
		el.scrollIntoView = vi.fn();
		Object.defineProperty(el, 'offsetParent', { get: () => document.body, configurable: true });
		document.body.appendChild(el);
		return el;
	}
	/** Run queued animation frames; rAF is faked to a 16ms timer by vi.useFakeTimers. */
	function flushFrames(count = 5) {
		for (let i = 0; i < count; i++) {
			vi.advanceTimersByTime(16);
		}
	}
	describe('flashJumpTarget', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});
		afterEach(() => {
			vi.useRealTimers();
			document.body.innerHTML = '';
		});
		it('scrolls the element into view and applies the flash class', () => {
			const el = makeTarget();
			flashJumpTarget(el);
			expect(el.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
			expect(el.classList.contains('jump-flash')).toBe(true);
		});
		it('removes the flash after the animation duration', () => {
			const el = makeTarget();
			flashJumpTarget(el);
			vi.advanceTimersByTime(JUMP_FLASH_DURATION_MS);
			expect(el.classList.contains('jump-flash')).toBe(false);
		});
		it('applies the themed color and clears it afterwards', () => {
			const el = makeTarget();
			flashJumpTarget(el, { color: '#ff0000' });
			expect(el.style.getPropertyValue('--jump-flash-color')).toBe('#ff0000');
			vi.advanceTimersByTime(JUMP_FLASH_DURATION_MS);
			expect(el.style.getPropertyValue('--jump-flash-color')).toBe('');
		});
		it('adds the arrow modifier only when requested', () => {
			const plain = makeTarget();
			flashJumpTarget(plain);
			expect(plain.classList.contains('jump-flash--arrow')).toBe(false);
			const arrowed = makeTarget();
			flashJumpTarget(arrowed, { arrow: true });
			expect(arrowed.classList.contains('jump-flash--arrow')).toBe(true);
		});
		it('skips scrolling when block is false', () => {
			const el = makeTarget();
			flashJumpTarget(el, { block: false });
			expect(el.scrollIntoView).not.toHaveBeenCalled();
			expect(el.classList.contains('jump-flash')).toBe(true);
		});
		it('cancel() clears the flash early', () => {
			const el = makeTarget();
			const cancel = flashJumpTarget(el);
			cancel();
			expect(el.classList.contains('jump-flash')).toBe(false);
		});
		it('scrolls exactly once when stabilizeFrames is not requested', () => {
			const el = makeTarget();
			flashJumpTarget(el);
			flushFrames(5);
			expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
		});
		it('re-asserts the scroll position for the requested number of frames', () => {
			const el = makeTarget();
			flashJumpTarget(el, { behavior: 'auto', stabilizeFrames: 3 });
			// The initial scroll, then one correction per stabilize frame.
			expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
			flushFrames(3);
			expect(el.scrollIntoView).toHaveBeenCalledTimes(4);
			// And it stops there rather than re-scrolling forever.
			flushFrames(5);
			expect(el.scrollIntoView).toHaveBeenCalledTimes(4);
		});
		it('corrections are always instant, even when the first scroll is smooth', () => {
			const el = makeTarget();
			flashJumpTarget(el, { stabilizeFrames: 2 });
			flushFrames(2);
			expect(el.scrollIntoView).toHaveBeenNthCalledWith(1, { behavior: 'smooth', block: 'center' });
			expect(el.scrollIntoView).toHaveBeenNthCalledWith(2, { behavior: 'auto', block: 'center' });
		});
		it('cancel() stops the stabilize loop', () => {
			const el = makeTarget();
			const cancel = flashJumpTarget(el, { behavior: 'auto', stabilizeFrames: 5 });
			cancel();
			flushFrames(5);
			expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
		});
	});
	describe('jumpToElement', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});
		afterEach(() => {
			vi.useRealTimers();
			document.body.innerHTML = '';
		});
		it('waits for the element to appear before flashing it', () => {
			let el: HTMLElement | null = null;
			const onFound = vi.fn();
			jumpToElement(() => el, { onFound });
			flushFrames(3);
			expect(onFound).not.toHaveBeenCalled();
			el = makeTarget();
			flushFrames(2);
			expect(onFound).toHaveBeenCalledWith(el);
			expect(el.classList.contains('jump-flash')).toBe(true);
		});
		it('gives up after maxAttempts and reports the timeout', () => {
			const onTimeout = vi.fn();
			jumpToElement(() => null, { maxAttempts: 3, onTimeout });
			flushFrames(6);
			expect(onTimeout).toHaveBeenCalledTimes(1);
		});
		it('ignores elements that are not laid out yet', () => {
			const el = document.createElement('div');
			el.scrollIntoView = vi.fn();
			Object.defineProperty(el, 'offsetParent', { get: () => null, configurable: true });
			document.body.appendChild(el);
			const onTimeout = vi.fn();
			jumpToElement(() => el, { maxAttempts: 2, onTimeout });
			flushFrames(5);
			expect(el.scrollIntoView).not.toHaveBeenCalled();
			expect(onTimeout).toHaveBeenCalled();
		});
		it('acts on a detached-but-present element when requireVisible is off', () => {
			const el = document.createElement('div');
			el.scrollIntoView = vi.fn();
			Object.defineProperty(el, 'offsetParent', { get: () => null, configurable: true });
			jumpToElement(() => el, { requireVisible: false });
			flushFrames(2);
			expect(el.scrollIntoView).toHaveBeenCalled();
		});
		it('cancel() stops the search so a later match is not flashed', () => {
			let el: HTMLElement | null = null;
			const cancel = jumpToElement(() => el);
			cancel();
			el = makeTarget();
			flushFrames(5);
			expect(el.classList.contains('jump-flash')).toBe(false);
		});
	});
});
// Source: src/__tests__/renderer/utils/launchFromSettings.test.ts
describe('', () => {
	describe('launchFromSettings', () => {
		beforeEach(() => {
			useModalStore.getState().closeAll();
		});
		it('closes the settings modal before running the launcher', () => {
			useModalStore.getState().openModal('settings', { tab: 'general' });
			const openedWhileSettingsClosed = vi.fn(() => useModalStore.getState().isOpen('settings'));
			launchFromSettings(() => {
				openedWhileSettingsClosed();
				useModalStore.getState().openModal('pianolaModal');
			});
			expect(openedWhileSettingsClosed).toHaveReturnedWith(false);
			expect(useModalStore.getState().isOpen('settings')).toBe(false);
			expect(useModalStore.getState().isOpen('pianolaModal')).toBe(true);
		});
		it('still runs the launcher when settings was never open', () => {
			const open = vi.fn();
			launchFromSettings(open);
			expect(open).toHaveBeenCalledTimes(1);
			expect(useModalStore.getState().isOpen('settings')).toBe(false);
		});
	});
});
// Source: src/__tests__/renderer/utils/liveTurnReattach.test.ts
describe('', () => {
	const proc = (overrides: Partial<Parameters<typeof resolveLiveAiTurns>[0][number]>) => ({
		sessionId: 'agent-1-ai-tab-1',
		pid: 100,
		isTerminal: false,
		startTime: 1000,
		...overrides,
	});
	describe('resolveLiveAiTurns', () => {
		it('resolves an AI tab process into its agent and tab', () => {
			expect(resolveLiveAiTurns([proc({})])).toEqual([
				{ sessionId: 'agent-1', tabId: 'tab-1', pid: 100, startTime: 1000 },
			]);
		});
		it('resolves a forced-parallel turn onto its originating tab', () => {
			expect(resolveLiveAiTurns([proc({ sessionId: 'agent-1-ai-tab-1-fp-2' })])[0]).toMatchObject({
				sessionId: 'agent-1',
				tabId: 'tab-1',
			});
		});
		it('skips terminals, Cue runs, and non-AI-tab ids', () => {
			const resolved = resolveLiveAiTurns([
				proc({ sessionId: 'agent-1-terminal', isTerminal: true }),
				proc({ sessionId: 'agent-1-ai-tab-9', isCueRun: true }),
				proc({ sessionId: 'agent-1-batch-1700000000' }),
				proc({ sessionId: 'agent-1' }),
			]);
			expect(resolved).toEqual([]);
		});
	});
	describe('applyLiveAiTurns', () => {
		const idleSession = (id = 'agent-1') =>
			createMockSession({
				id,
				state: 'idle',
				aiTabs: [createMockAITab({ id: 'tab-1' }), createMockAITab({ id: 'tab-2' })],
				activeTabId: 'tab-1',
			});
		it('marks the agent and the running tab busy', () => {
			const [session] = applyLiveAiTurns(
				[idleSession()],
				[{ sessionId: 'agent-1', tabId: 'tab-1', pid: 42, startTime: 1000 }]
			);
			expect(session.state).toBe('busy');
			expect(session.busySource).toBe('ai');
			expect(session.thinkingStartTime).toBe(1000);
			expect(session.aiPid).toBe(42);
			expect(session.aiTabs[0]).toMatchObject({ state: 'busy', thinkingStartTime: 1000 });
			// A tab with no live turn stays idle.
			expect(session.aiTabs[1].state).toBe('idle');
		});
		it('uses the earliest start time when an agent has several live turns', () => {
			const [session] = applyLiveAiTurns(
				[idleSession()],
				[
					{ sessionId: 'agent-1', tabId: 'tab-2', pid: 43, startTime: 5000 },
					{ sessionId: 'agent-1', tabId: 'tab-1', pid: 42, startTime: 1000 },
				]
			);
			expect(session.thinkingStartTime).toBe(1000);
			expect(session.aiTabs[0].thinkingStartTime).toBe(1000);
			expect(session.aiTabs[1].thinkingStartTime).toBe(5000);
		});
		it('marks the agent busy even when its tab is gone', () => {
			const [session] = applyLiveAiTurns(
				[createMockSession({ id: 'agent-1', state: 'idle', aiTabs: [] })],
				[{ sessionId: 'agent-1', tabId: 'closed-tab', pid: 42, startTime: 1000 }]
			);
			expect(session.state).toBe('busy');
		});
		it('leaves agents with no live turn untouched', () => {
			const sessions = [idleSession('agent-1'), idleSession('agent-2')];
			const next = applyLiveAiTurns(sessions, [
				{ sessionId: 'agent-1', tabId: 'tab-1', pid: 42, startTime: 1000 },
			]);
			expect(next[1]).toBe(sessions[1]);
			expect(next[1].state).toBe('idle');
		});
		it('returns the same array when there is nothing running', () => {
			const sessions = [idleSession()];
			expect(applyLiveAiTurns(sessions, [])).toBe(sessions);
		});
		it('does not overwrite a restored limit pause', () => {
			const paused = createMockSession({
				id: 'agent-1',
				state: 'error',
				agentErrorPaused: true,
				aiTabs: [createMockAITab({ id: 'tab-1' })],
			});
			const [session] = applyLiveAiTurns(
				[paused],
				[{ sessionId: 'agent-1', tabId: 'tab-1', pid: 42, startTime: 1000 }]
			);
			expect(session.state).toBe('error');
			expect(session.agentErrorPaused).toBe(true);
		});
		it('falls back to now when main reports no start time', () => {
			const [session] = applyLiveAiTurns(
				[idleSession()],
				[{ sessionId: 'agent-1', tabId: 'tab-1', pid: 42 }],
				7777
			);
			expect(session.thinkingStartTime).toBe(7777);
			expect(session.aiTabs[0].thinkingStartTime).toBe(7777);
		});
		it('preserves an open input request while reattaching several running tabs', () => {
			const waiting = createMockSession({ ...idleSession(), state: 'waiting_input' });
			const turns = [
				{ sessionId: waiting.id, tabId: 'tab-1', pid: 42, startTime: 1000 },
				{ sessionId: waiting.id, tabId: 'tab-2', pid: 43, startTime: 2000 },
			];
			const [reattached] = applyLiveAiTurns([waiting], turns);
			expect(reattached.state).toBe('waiting_input');
			expect(reattached.aiPid).toBe(42);
			expect(reattached.aiTabs.map((tab) => tab.state)).toEqual(['busy', 'busy']);
			const [answered] = applyLiveAiTurns([{ ...reattached, state: 'busy' }], turns);
			expect(answered.state).toBe('busy');
		});
	});
});
// Source: src/__tests__/renderer/utils/logEntries.test.ts
describe('', () => {
	function entry(overrides: Partial<LogEntry> = {}): LogEntry {
		return {
			id: 'log-1',
			timestamp: 0,
			source: 'stdout',
			text: 'some output',
			...overrides,
		};
	}
	describe('isSelfContainedCard', () => {
		it('is false for plain streamed output', () => {
			expect(isSelfContainedCard(entry({ source: 'stdout' }))).toBe(false);
			expect(isSelfContainedCard(entry({ source: 'stderr' }))).toBe(false);
			expect(isSelfContainedCard(entry({ source: 'thinking' }))).toBe(false);
		});
		it('is false for an interactive-TUI stream, which is still a stream', () => {
			expect(isSelfContainedCard(entry({ renderStyle: 'text-stream' }))).toBe(false);
		});
		it.each([
			[
				'command output card',
				{ shellCommand: { command: 'ls', cwd: '/repo', status: 'finished' } },
			],
			['retry outage card', { retryOutageId: 'outage-1' }],
			['session recovery prompt', { recoveryAction: { lastUserPrompt: 'hi', tabId: 't1' } }],
			['custom AI command chip', { aiCommand: { command: '/commit', description: 'commit' } }],
			['hidden progress placeholder', { metadata: { hiddenProgress: { kind: 'tool' as const } } }],
			['tool call card', { metadata: { toolState: { status: 'running' as const } } }],
			[
				'back-from-snooze card',
				{
					snoozeReturn: {
						snoozedAt: 1,
						wakeAt: 2,
						resolution: 'woke' as const,
					},
				},
			],
			[
				'agent delegation pill',
				{
					delegation: {
						kind: 'dispatch' as const,
						toSessionId: 'proxmox',
						toAgentName: 'Proxmox',
						toToolType: 'claude-code' as const,
						subject: 'Fix the advisory bug',
					},
				},
			],
		])('is true for a %s', (_label, overrides) => {
			expect(isSelfContainedCard(entry(overrides as Partial<LogEntry>))).toBe(true);
		});
		describe("Claude's plan-limit banner", () => {
			// The banner reaches the transcript as a plain `stdout` entry with no
			// marker (Claude forwards it on the `result` envelope after the failure
			// was already raised), so text is the only thing that can identify it.
			it('is a card, so the retried answer is not glued to its front', () => {
				const banner = entry({
					source: 'stdout',
					text: "You've hit your session limit · resets 12:50am (America/Chicago)",
				});
				expect(isSelfContainedCard(banner)).toBe(true);
				expect(canAppendToLogEntry(banner, 'stdout')).toBe(false);
			});
			it('is a card for the weekly and legacy wordings too', () => {
				expect(
					isSelfContainedCard(
						entry({ text: "You've hit your weekly limit · resets Monday at 9am" })
					)
				).toBe(true);
				expect(
					isSelfContainedCard(entry({ text: 'Claude AI usage limit reached|1755500000' }))
				).toBe(true);
			});
			it('is NOT a card when an agent merely discusses limits', () => {
				// Maestro's own agents write about quota constantly. A reply that
				// quotes the banner carries surrounding prose, so it stays a stream and
				// keeps coalescing normally.
				const reply = entry({
					text: 'Fixed. "You\'ve hit your session limit · resets 11:40am (America/Chicago)" now classifies as rate_limited, so resilience picks it up instead of letting the turn look successful.',
				});
				expect(isSelfContainedCard(reply)).toBe(false);
				expect(canAppendToLogEntry(reply, 'stdout')).toBe(true);
			});
		});
	});
	describe('canAppendToLogEntry', () => {
		it('allows appending to a plain entry of the same source', () => {
			expect(canAppendToLogEntry(entry({ source: 'stdout' }), 'stdout')).toBe(true);
			expect(canAppendToLogEntry(entry({ source: 'stderr' }), 'stderr')).toBe(true);
		});
		it('refuses across different sources', () => {
			expect(canAppendToLogEntry(entry({ source: 'stdout' }), 'stderr')).toBe(false);
			expect(canAppendToLogEntry(entry({ source: 'thinking' }), 'stdout')).toBe(false);
		});
		it('refuses when there is no previous entry', () => {
			expect(canAppendToLogEntry(undefined, 'stdout')).toBe(false);
		});
		it('refuses a command card even though its source matches', () => {
			// The regression. Source says stdout, but the card owns its own text.
			const card = entry({
				source: 'stdout',
				shellCommand: { command: 'ls', cwd: '/repo', status: 'finished', exitCode: 0 },
			});
			expect(card.source).toBe('stdout');
			expect(canAppendToLogEntry(card, 'stdout')).toBe(false);
		});
		it('refuses a still-running command card', () => {
			const card = entry({
				source: 'stdout',
				text: '',
				shellCommand: { command: 'tail -f log', cwd: '/repo', status: 'running' },
			});
			expect(canAppendToLogEntry(card, 'stdout')).toBe(false);
		});
		it('refuses every card kind, whatever source it carries', () => {
			// Cards are excluded by their marker, not by which source they happen to
			// use - so a future card that reuses a streaming source is safe by
			// construction rather than needing a new check at each call site.
			const cards: LogEntry[] = [
				entry({ source: 'stdout', shellCommand: { command: 'ls', cwd: '/', status: 'finished' } }),
				entry({ source: 'stdout', retryOutageId: 'o1' }),
				entry({ source: 'stderr', metadata: { toolState: { status: 'error' } } }),
				// A system-source card: the snooze marker shares its source with plain
				// system chatter, so only the marker can tell them apart.
				entry({
					source: 'system',
					snoozeReturn: { snoozedAt: 1, wakeAt: 2, resolution: 'woke' },
				}),
			];
			for (const card of cards) {
				expect(canAppendToLogEntry(card, card.source)).toBe(false);
			}
		});
	});
	describe('steerJoinsRunningTurn', () => {
		it.each([
			['still waiting for its verdict', 'pending'],
			['absorbed by the running turn', 'absorbed'],
			['steered before the state was recorded', undefined],
		] as const)('is true for a steer %s', (_name, steerState) => {
			expect(steerJoinsRunningTurn(entry({ source: 'user', steered: true, steerState }))).toBe(
				true
			);
		});
		it('is false for a steer the agent took as a follow-up', () => {
			// It ran as a turn of its own, so stitching it to the running turn would say
			// the opposite of what happened.
			expect(
				steerJoinsRunningTurn(entry({ source: 'user', steered: true, steerState: 'queued' }))
			).toBe(false);
		});
		it('is false for a message that started its own turn, and for no entry at all', () => {
			expect(steerJoinsRunningTurn(entry({ source: 'user' }))).toBe(false);
			expect(steerJoinsRunningTurn(entry({ source: 'stdout', steered: true }))).toBe(false);
			expect(steerJoinsRunningTurn(undefined)).toBe(false);
		});
	});
	describe('dropRecoveredOutageNotices', () => {
		const BANNER = "You've hit your weekly limit · resets 10am (America/Chicago)";
		const scope = { outageId: 'o1', lastMessage: 'Usage limit reached', resolvedAt: 100 };
		const user = entry({ id: 'u', source: 'user', text: 'hi', timestamp: 10 });
		const card = entry({
			id: 'card',
			source: 'system',
			text: 'Usage limit reached',
			retryOutageId: 'o1',
			timestamp: 20,
		});
		it('drops the banner that landed under the outage card', () => {
			const banner = entry({ id: 'b', text: BANNER, timestamp: 21 });
			expect(dropRecoveredOutageNotices([user, card, banner], scope)).toEqual([user, card]);
		});
		it('drops a bubble that is exactly the failing message', () => {
			const echo = entry({ id: 'e', text: 'Usage limit reached\n', timestamp: 21 });
			expect(dropRecoveredOutageNotices([user, card, echo], scope)).toEqual([user, card]);
		});
		it('keeps real replies, earlier turns, and output after the resolution', () => {
			const earlier = entry({ id: 'old', text: BANNER, timestamp: 1 });
			const reply = entry({ id: 'r', text: 'Here is the answer.', timestamp: 50 });
			const late = entry({ id: 'late', text: BANNER, timestamp: 200 });
			const logs = [earlier, user, card, reply, late];
			expect(dropRecoveredOutageNotices(logs, scope)).toBe(logs);
		});
		it('returns the same array when the outage card is not in this transcript', () => {
			const logs = [user, entry({ id: 'b', text: BANNER, timestamp: 21 })];
			expect(dropRecoveredOutageNotices(logs, scope)).toBe(logs);
		});
	});
});
// Source: src/__tests__/renderer/utils/logger.test.ts
describe('', () => {
	describe('logger', () => {
		let logSpy: ReturnType<typeof vi.fn>;
		let originalMaestro: typeof window.maestro;
		beforeEach(() => {
			// Save original maestro
			originalMaestro = window.maestro;
			// Create mock log function
			logSpy = vi.fn();
			// Set up window.maestro mock with logger
			(window as any).maestro = {
				logger: {
					log: logSpy,
				},
			};
		});
		afterEach(() => {
			// Restore original maestro
			(window as any).maestro = originalMaestro;
		});
		describe('LogLevel type', () => {
			it('should accept valid log levels', () => {
				const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
				expect(levels).toHaveLength(4);
			});
		});
		describe('logger singleton', () => {
			it('should be defined', () => {
				expect(logger).toBeDefined();
			});
			it('should have debug method', () => {
				expect(logger.debug).toBeInstanceOf(Function);
			});
			it('should have info method', () => {
				expect(logger.info).toBeInstanceOf(Function);
			});
			it('should have warn method', () => {
				expect(logger.warn).toBeInstanceOf(Function);
			});
			it('should have error method', () => {
				expect(logger.error).toBeInstanceOf(Function);
			});
		});
		describe('debug', () => {
			it('should call window.maestro.logger.log with debug level', () => {
				logger.debug('test message');
				expect(logSpy).toHaveBeenCalledWith('debug', 'test message', undefined, undefined);
			});
			it('should pass context parameter', () => {
				logger.debug('test message', 'TestContext');
				expect(logSpy).toHaveBeenCalledWith('debug', 'test message', 'TestContext', undefined);
			});
			it('should pass data parameter', () => {
				const data = { key: 'value' };
				logger.debug('test message', 'TestContext', data);
				expect(logSpy).toHaveBeenCalledWith('debug', 'test message', 'TestContext', data);
			});
			it('should handle empty message', () => {
				logger.debug('');
				expect(logSpy).toHaveBeenCalledWith('debug', '', undefined, undefined);
			});
			it('should handle complex data objects', () => {
				const data = {
					nested: { deep: { value: 123 } },
					array: [1, 2, 3],
					bool: true,
				};
				logger.debug('complex', 'Context', data);
				expect(logSpy).toHaveBeenCalledWith('debug', 'complex', 'Context', data);
			});
		});
		describe('info', () => {
			it('should call window.maestro.logger.log with info level', () => {
				logger.info('info message');
				expect(logSpy).toHaveBeenCalledWith('info', 'info message', undefined, undefined);
			});
			it('should pass context parameter', () => {
				logger.info('info message', 'InfoContext');
				expect(logSpy).toHaveBeenCalledWith('info', 'info message', 'InfoContext', undefined);
			});
			it('should pass data parameter', () => {
				const data = ['array', 'data'];
				logger.info('info message', 'InfoContext', data);
				expect(logSpy).toHaveBeenCalledWith('info', 'info message', 'InfoContext', data);
			});
		});
		describe('warn', () => {
			it('should call window.maestro.logger.log with warn level', () => {
				logger.warn('warning message');
				expect(logSpy).toHaveBeenCalledWith('warn', 'warning message', undefined, undefined);
			});
			it('should pass context parameter', () => {
				logger.warn('warning message', 'WarnContext');
				expect(logSpy).toHaveBeenCalledWith('warn', 'warning message', 'WarnContext', undefined);
			});
			it('should pass data parameter', () => {
				const data = new Date();
				logger.warn('warning message', 'WarnContext', data);
				expect(logSpy).toHaveBeenCalledWith('warn', 'warning message', 'WarnContext', data);
			});
		});
		describe('error', () => {
			it('should call window.maestro.logger.log with error level', () => {
				logger.error('error message');
				expect(logSpy).toHaveBeenCalledWith('error', 'error message', undefined, undefined);
			});
			it('should pass context parameter', () => {
				logger.error('error message', 'ErrorContext');
				expect(logSpy).toHaveBeenCalledWith('error', 'error message', 'ErrorContext', undefined);
			});
			it('should pass data parameter', () => {
				const error = new Error('test error');
				logger.error('error message', 'ErrorContext', error);
				expect(logSpy).toHaveBeenCalledWith('error', 'error message', 'ErrorContext', error);
			});
			it('should handle error objects as data', () => {
				const error = { code: 'ERR_001', details: 'Something went wrong' };
				logger.error('error occurred', 'ErrorHandler', error);
				expect(logSpy).toHaveBeenCalledWith('error', 'error occurred', 'ErrorHandler', error);
			});
		});
		describe('window.maestro unavailable', () => {
			it('should handle undefined window.maestro gracefully', () => {
				(window as any).maestro = undefined;
				// Should not throw
				expect(() => logger.debug('test')).not.toThrow();
				expect(() => logger.info('test')).not.toThrow();
				expect(() => logger.warn('test')).not.toThrow();
				expect(() => logger.error('test')).not.toThrow();
			});
			it('should handle null window.maestro gracefully', () => {
				(window as any).maestro = null;
				expect(() => logger.debug('test')).not.toThrow();
				expect(() => logger.info('test')).not.toThrow();
				expect(() => logger.warn('test')).not.toThrow();
				expect(() => logger.error('test')).not.toThrow();
			});
			it('should handle undefined logger gracefully', () => {
				(window as any).maestro = { logger: undefined };
				expect(() => logger.debug('test')).not.toThrow();
				expect(() => logger.info('test')).not.toThrow();
				expect(() => logger.warn('test')).not.toThrow();
				expect(() => logger.error('test')).not.toThrow();
			});
			it('should handle null logger gracefully', () => {
				(window as any).maestro = { logger: null };
				expect(() => logger.debug('test')).not.toThrow();
				expect(() => logger.info('test')).not.toThrow();
				expect(() => logger.warn('test')).not.toThrow();
				expect(() => logger.error('test')).not.toThrow();
			});
		});
		describe('edge cases', () => {
			it('should handle undefined data', () => {
				logger.debug('message', 'context', undefined);
				expect(logSpy).toHaveBeenCalledWith('debug', 'message', 'context', undefined);
			});
			it('should handle null data', () => {
				logger.debug('message', 'context', null);
				expect(logSpy).toHaveBeenCalledWith('debug', 'message', 'context', null);
			});
			it('should handle numeric data', () => {
				logger.debug('message', 'context', 42);
				expect(logSpy).toHaveBeenCalledWith('debug', 'message', 'context', 42);
			});
			it('should handle string data', () => {
				logger.debug('message', 'context', 'string data');
				expect(logSpy).toHaveBeenCalledWith('debug', 'message', 'context', 'string data');
			});
			it('should handle boolean data', () => {
				logger.debug('message', 'context', true);
				expect(logSpy).toHaveBeenCalledWith('debug', 'message', 'context', true);
			});
			it('should handle empty context', () => {
				logger.debug('message', '');
				expect(logSpy).toHaveBeenCalledWith('debug', 'message', '', undefined);
			});
			it('should handle special characters in message', () => {
				const message = 'Message with special chars: éàü ™ © ® 日本語 🎉';
				logger.debug(message);
				expect(logSpy).toHaveBeenCalledWith('debug', message, undefined, undefined);
			});
			it('should handle very long messages', () => {
				const longMessage = 'a'.repeat(10000);
				logger.debug(longMessage);
				expect(logSpy).toHaveBeenCalledWith('debug', longMessage, undefined, undefined);
			});
			it('should handle circular reference in data gracefully', () => {
				const circular: any = { a: 1 };
				circular.self = circular;
				// The logger just passes the data to IPC, doesn't stringify
				expect(() => logger.debug('message', 'context', circular)).not.toThrow();
				expect(logSpy).toHaveBeenCalledWith('debug', 'message', 'context', circular);
			});
			it('should handle functions in data', () => {
				const func = () => 'test';
				logger.debug('message', 'context', func);
				expect(logSpy).toHaveBeenCalledWith('debug', 'message', 'context', func);
			});
			it('should handle Symbol in data', () => {
				const sym = Symbol('test');
				logger.debug('message', 'context', sym);
				expect(logSpy).toHaveBeenCalledWith('debug', 'message', 'context', sym);
			});
		});
		describe('multiple calls', () => {
			it('should handle multiple consecutive calls', () => {
				logger.debug('debug 1');
				logger.info('info 1');
				logger.warn('warn 1');
				logger.error('error 1');
				expect(logSpy).toHaveBeenCalledTimes(4);
				expect(logSpy).toHaveBeenNthCalledWith(1, 'debug', 'debug 1', undefined, undefined);
				expect(logSpy).toHaveBeenNthCalledWith(2, 'info', 'info 1', undefined, undefined);
				expect(logSpy).toHaveBeenNthCalledWith(3, 'warn', 'warn 1', undefined, undefined);
				expect(logSpy).toHaveBeenNthCalledWith(4, 'error', 'error 1', undefined, undefined);
			});
			it('should handle rapid successive calls', () => {
				for (let i = 0; i < 100; i++) {
					logger.debug(`message ${i}`);
				}
				expect(logSpy).toHaveBeenCalledTimes(100);
			});
		});
		describe('type safety', () => {
			it('should accept unknown type for data parameter', () => {
				// These should all compile and work
				logger.debug('msg', 'ctx', 123);
				logger.debug('msg', 'ctx', 'string');
				logger.debug('msg', 'ctx', { obj: true });
				logger.debug('msg', 'ctx', [1, 2, 3]);
				logger.debug('msg', 'ctx', null);
				logger.debug('msg', 'ctx', undefined);
				expect(logSpy).toHaveBeenCalledTimes(6);
			});
		});
	});
});
// Source: src/__tests__/renderer/utils/loginUrl.test.ts
describe('', () => {
	describe('findLoginUrl', () => {
		it('returns null before the provider prints anything', () => {
			expect(findLoginUrl('')).toBeNull();
			expect(findLoginUrl('Starting login shell...\n$ ')).toBeNull();
		});
		it('finds a plain OAuth URL', () => {
			const url = 'https://claude.ai/oauth/authorize?client_id=abc&state=xyz';
			expect(findLoginUrl(`Open this URL to continue:\n\n  ${url}\n`)).toBe(url);
		});
		it('sees through ANSI colouring', () => {
			const url = 'https://claude.ai/oauth/authorize?code=1';
			expect(findLoginUrl(`\x1b[1;34m${url}\x1b[0m`)).toBe(url);
		});
		// The reason this helper exists: a real login URL never fits one row.
		it('rejoins a URL the terminal soft-wrapped across rows', () => {
			const wrapped =
				'https://claude.ai/oauth/authorize?client_id=9d1c&redirect_uri=http%3A%2F%2Flocal\n' +
				'host%3A45289%2Fcallback&scope=user%3Aprofile';
			expect(findLoginUrl(wrapped)).toBe(
				'https://claude.ai/oauth/authorize?client_id=9d1c&redirect_uri=http%3A%2F%2Flocalhost%3A45289%2Fcallback&scope=user%3Aprofile'
			);
		});
		it('does not glue following prose onto the URL', () => {
			const out = 'https://claude.ai/oauth/authorize?x=1\n\nPaste the code below.';
			expect(findLoginUrl(out)).toBe('https://claude.ai/oauth/authorize?x=1');
		});
		it('strips punctuation the sentence left on the end', () => {
			expect(findLoginUrl('Visit https://claude.ai/oauth/authorize?x=1.')).toBe(
				'https://claude.ai/oauth/authorize?x=1'
			);
			expect(findLoginUrl('Visit (https://claude.ai/oauth/authorize?x=1)')).toBe(
				'https://claude.ai/oauth/authorize?x=1'
			);
		});
		// The same screen prints docs and status links. Copying one of those sends
		// the user somewhere that cannot log them in, with no sign anything is wrong.
		it('ignores documentation and status links on the same screen', () => {
			const out = [
				'Docs: https://docs.anthropic.example.com/getting-started',
				'Status: https://status.example.com/',
				'Sign in: https://claude.ai/oauth/authorize?client_id=abc',
			].join('\n');
			expect(findLoginUrl(out)).toBe('https://claude.ai/oauth/authorize?client_id=abc');
		});
		it('returns nothing rather than guessing when no login URL is present', () => {
			expect(findLoginUrl('See https://example.com/help for more')).toBeNull();
		});
		// A retried login prints a fresh URL; the earlier one is spent and would
		// fail if the user copied it.
		it('prefers the most recent URL when the flow is retried', () => {
			const out = [
				'https://claude.ai/oauth/authorize?attempt=1',
				'That code expired, try again:',
				'https://claude.ai/oauth/authorize?attempt=2',
			].join('\n');
			expect(findLoginUrl(out)).toBe('https://claude.ai/oauth/authorize?attempt=2');
		});
		it('recognises device-code and provider-specific flows', () => {
			expect(findLoginUrl('https://github.com/login/device')).toBe(
				'https://github.com/login/device'
			);
			expect(findLoginUrl('https://auth.openai.com/authorize?x=1')).toBe(
				'https://auth.openai.com/authorize?x=1'
			);
		});
		it('ignores a bare origin with no path', () => {
			expect(findLoginUrl('https://claude.ai')).toBeNull();
		});
	});
});
// Source: src/__tests__/renderer/utils/markdownTasks.test.ts
describe('', () => {
	describe('toggleTaskCheckboxAtLine', () => {
		it('checks an open task and reports the new state', () => {
			const result = toggleTaskCheckboxAtLine('# Notes\n- [ ] call the clerk\n', 2);
			expect(result).toEqual({ content: '# Notes\n- [x] call the clerk\n', checked: true });
		});
		it('unchecks a closed task, accepting an uppercase marker', () => {
			const result = toggleTaskCheckboxAtLine('- [X] shipped\n', 1);
			expect(result).toEqual({ content: '- [ ] shipped\n', checked: false });
		});
		it('preserves indentation, bullet style, and spacing', () => {
			const result = toggleTaskCheckboxAtLine('\t\t*   [ ]  nested task', 1);
			expect(result?.content).toBe('\t\t*   [x]  nested task');
		});
		it('toggles ordered-list tasks', () => {
			const result = toggleTaskCheckboxAtLine('1. [ ] first step', 1);
			expect(result?.content).toBe('1. [x] first step');
		});
		it('leaves CRLF line endings intact', () => {
			const result = toggleTaskCheckboxAtLine('- [ ] a\r\n- [ ] b\r\n', 2);
			expect(result?.content).toBe('- [ ] a\r\n- [x] b\r\n');
		});
		it('only rewrites the requested line when the text repeats', () => {
			const content = '- [ ] same text\n- [ ] same text\n- [ ] same text';
			expect(toggleTaskCheckboxAtLine(content, 2)?.content).toBe(
				'- [ ] same text\n- [x] same text\n- [ ] same text'
			);
		});
		it('returns null for a line with no task marker', () => {
			expect(toggleTaskCheckboxAtLine('# Notes\n- plain bullet\n', 2)).toBeNull();
			expect(toggleTaskCheckboxAtLine('a [ ] not a task', 1)).toBeNull();
		});
		it('returns null for out-of-range and invalid line numbers', () => {
			expect(toggleTaskCheckboxAtLine('- [ ] only line', 2)).toBeNull();
			expect(toggleTaskCheckboxAtLine('- [ ] only line', 0)).toBeNull();
			expect(toggleTaskCheckboxAtLine('- [ ] only line', 1.5)).toBeNull();
		});
	});
	describe('taskTextAtLine', () => {
		it('returns the trimmed text after the task marker', () => {
			const doc = '# Plan\n- [ ] write it  \n1. [x] ship it\r\n';
			expect(taskTextAtLine(doc, 2)).toBe('write it');
			expect(taskTextAtLine(doc, 3)).toBe('ship it');
		});
		it('returns null for a line without a toggleable task', () => {
			const doc = '# Plan\n- plain item\n- [/] in progress';
			expect(taskTextAtLine(doc, 1)).toBeNull();
			expect(taskTextAtLine(doc, 2)).toBeNull();
			expect(taskTextAtLine(doc, 3)).toBeNull();
			expect(taskTextAtLine(doc, 9)).toBeNull();
			expect(taskTextAtLine(doc, 0)).toBeNull();
		});
	});
});
// Source: src/__tests__/renderer/utils/sessionJumpSlots.test.ts
describe('', () => {
	describe('sessionJumpSlots', () => {
		it('maps slot indexes 0-8 to 1-9, 9 to 0, and nothing past the tenth', () => {
			expect(sessionJumpSlotDigit(0)).toBe('1');
			expect(sessionJumpSlotDigit(8)).toBe('9');
			expect(sessionJumpSlotDigit(9)).toBe('0');
			expect(sessionJumpSlotDigit(10)).toBeNull();
			expect(sessionJumpSlotDigit(-1)).toBeNull();
		});
		it('assigns digits in draw order and stops at ten agents', () => {
			const sessions = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}` }));
			const map = buildSessionJumpSlotMap(sessions);
			expect(map.size).toBe(10);
			expect(map.get('s0')).toBe('1');
			expect(map.get('s9')).toBe('0');
			expect(map.has('s10')).toBe(false);
		});
		it('builds the Opt+Cmd chord for a digit', () => {
			expect(sessionJumpShortcut('3').keys).toEqual(['Alt', 'Meta', '3']);
		});
	});
});
