// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/utils/browserPageView.test.ts
// Source: src/__tests__/renderer/utils/crossTabSearch.test.ts
// Source: src/__tests__/renderer/utils/executionQueue.test.ts
// Source: src/__tests__/renderer/utils/extensionColors.test.ts
// Source: src/__tests__/renderer/utils/fixedPitchFont.test.ts
// Source: src/__tests__/renderer/utils/gitLogSearch.test.ts
// Source: src/__tests__/renderer/utils/grokWizard.test.ts
import { describe, afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
	createHostBrowserPageView,
	type HostBrowserPageElement,
} from '../../../renderer/utils/browserPageView';
import type { BrowserPageState } from '../../../shared/browserPage';
import type { BrowserRelayFrame, BrowserRelayInput } from '../../../shared/browserRelay';
import { searchTabsMessages, flattenCrossTabMatches } from '../../../renderer/utils/crossTabSearch';
import { createMockAITab as s2_createMockAITab } from '../../helpers';
import type { LogEntry } from '../../../renderer/types';
import {
	isRunnableQueueItem,
	nextRunnableQueueItem,
	hasRunnableQueueItem,
	takeNextRunnableQueueItem,
	reorderQueueItem,
	resolveQueuedItemTabName,
	hasWorkAheadOfNewMessage,
	applyQueuedItemRelease,
	getForceSendEligibility,
	shouldOfferForceSend,
	describeSteerBlocked,
	getSteerEligibility,
	shouldOfferSteer,
	getSteerTitle,
	applyQueuedItemEdit,
	applyQueuedItemDispatchFailure,
	isSameQueuedPrompt,
	findQueuedDuplicate,
	releaseConnectionHeldQueueItems,
	hasConsultHoldForTab,
	dropConsultHold,
	findQueuedMergeTarget,
	mergeQueuedItemIntoPrevious,
	applyReplayDispatch,
} from '../../../renderer/utils/executionQueue';
import { mergeSessionPersistenceChanges } from '../../../shared/sessionPersistenceMerge';
import type { AITab, QueuedItem, Session } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab as s3_createMockAITab } from '../../helpers/mockTab';
import { getExtensionColor } from '../../../renderer/utils/extensionColors';
import { THEMES } from '../../../shared/themes';
import {
	isFixedPitchStack,
	resolveTerminalFontFamily,
	resolveFixedPitchFontFamily,
	type MeasureAdvance,
} from '../../../renderer/utils/fixedPitchFont';
import { MONO_FALLBACK_STACK, withMonoFallback } from '../../../shared/fontStack';
import { gitLogSearchTerms, matchesGitLogTerms } from '../../../renderer/utils/gitLogSearch';
import {
	extractGrokTextFromJsonl,
	getGrokTextDelta,
	GROK_WIZARD_DISCOVERY_ARGS,
} from '../../../renderer/utils/grokWizard';
// Source: src/__tests__/renderer/utils/browserPageView.test.ts
describe('', () => {
	const target = { sessionId: 'session-1', tabId: 'browser-1' };
	const state: BrowserPageState = {
		url: 'https://example.test',
		title: 'Example',
		width: 1024,
		height: 768,
		canGoBack: false,
		canGoForward: false,
		isLoading: false,
		webContentsId: 1,
		ready: true,
	};
	const frame: BrowserRelayFrame = { ...state, dataUrl: 'data:image/png;base64,dGVzdA==' };
	describe('host browser page presentation', () => {
		let view: HostBrowserPageElement;
		let originalApi: typeof window.maestro.browserSession;
		const pageFrame = vi.fn<() => Promise<BrowserRelayFrame>>();
		const pageInput = vi.fn<(target: unknown, input: BrowserRelayInput) => Promise<void>>();
		const pageOpen = vi.fn<() => Promise<BrowserPageState>>();
		const decode = vi.fn<() => Promise<void>>();
		beforeEach(() => {
			vi.useFakeTimers();
			pageFrame.mockReset().mockResolvedValue(frame);
			pageInput.mockReset().mockResolvedValue(undefined);
			pageOpen.mockReset().mockResolvedValue(state);
			decode.mockReset().mockResolvedValue(undefined);
			vi.stubGlobal(
				'Image',
				class {
					src = '';
					decode = decode;
				}
			);
			originalApi = window.maestro.browserSession;
			window.maestro.browserSession = {
				...originalApi,
				pageOpen,
				pageFrame,
				pageInput,
				pageSuspend: vi.fn().mockResolvedValue(undefined),
				pageRelease: vi.fn().mockResolvedValue(undefined),
			};
			view = createHostBrowserPageView(target, state.url, '#fff');
		});
		afterEach(() => {
			view.dispose();
			window.maestro.browserSession = originalApi;
			vi.useRealTimers();
			vi.unstubAllGlobals();
		});
		it.each(['frame', 'decode'])(
			'retries a transient %s failure and restores the presentation',
			async (kind) => {
				const failed = vi.fn();
				const recovered = vi.fn();
				view.addEventListener('did-fail-load', failed);
				view.addEventListener('did-finish-load', recovered);
				if (kind === 'frame') pageFrame.mockRejectedValueOnce(new Error('Frame unavailable'));
				else decode.mockRejectedValueOnce(new Error('Decode unavailable'));
				view.setActive(true);
				await vi.advanceTimersByTimeAsync(0);
				expect(failed).toHaveBeenCalledTimes(1);
				expect(pageFrame).toHaveBeenCalledTimes(1);
				await vi.advanceTimersByTimeAsync(999);
				expect(pageFrame).toHaveBeenCalledTimes(1);
				await vi.advanceTimersByTimeAsync(1);
				expect(pageFrame).toHaveBeenCalledTimes(2);
				expect(view.querySelector('img')?.src).toBe(frame.dataUrl);
				expect(recovered).toHaveBeenCalledTimes(1);
				await vi.advanceTimersByTimeAsync(125);
				expect(pageFrame).toHaveBeenCalledTimes(3);
			}
		);
		it('backs off repeated failures and cancels pending retries while inactive', async () => {
			pageFrame.mockRejectedValue(new Error('Frame unavailable'));
			view.setActive(true);
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(1000);
			expect(pageFrame).toHaveBeenCalledTimes(2);
			await vi.advanceTimersByTimeAsync(1999);
			expect(pageFrame).toHaveBeenCalledTimes(2);
			await vi.advanceTimersByTimeAsync(1);
			expect(pageFrame).toHaveBeenCalledTimes(3);
			view.setActive(false);
			await vi.advanceTimersByTimeAsync(10000);
			expect(pageFrame).toHaveBeenCalledTimes(3);
		});
		it.each(['inactive', 'disposed'])(
			'ignores a rejected in-flight frame after becoming %s',
			async (mode) => {
				let rejectFrame!: (error: Error) => void;
				pageFrame.mockReturnValueOnce(
					new Promise((_, reject) => {
						rejectFrame = reject;
					})
				);
				const failed = vi.fn();
				view.addEventListener('did-fail-load', failed);
				view.setActive(true);
				await vi.advanceTimersByTimeAsync(0);
				if (mode === 'disposed') view.dispose();
				else view.setActive(false);
				rejectFrame(new Error('Stale failure'));
				await vi.advanceTimersByTimeAsync(10000);
				expect(failed).not.toHaveBeenCalled();
				expect(pageFrame).toHaveBeenCalledTimes(1);
			}
		);
		it('starts only one pump when activation changes while the page is opening', async () => {
			view.dispose();
			let finishOpening!: (value: BrowserPageState) => void;
			pageOpen.mockReturnValueOnce(
				new Promise((resolve) => {
					finishOpening = resolve;
				})
			);
			view = createHostBrowserPageView(target, state.url, '#fff');
			view.setActive(true);
			view.setActive(false);
			view.setActive(true);
			finishOpening(state);
			await vi.advanceTimersByTimeAsync(0);
			expect(pageFrame).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(125);
			expect(pageFrame).toHaveBeenCalledTimes(2);
		});
		it('does not publish an old frame failure after a new activation starts', async () => {
			let rejectFrame!: (error: Error) => void;
			pageFrame.mockReturnValueOnce(
				new Promise((_, reject) => {
					rejectFrame = reject;
				})
			);
			const failed = vi.fn();
			view.addEventListener('did-fail-load', failed);
			view.setActive(true);
			await vi.advanceTimersByTimeAsync(0);
			view.setActive(false);
			view.setActive(true);
			rejectFrame(new Error('Stale failure'));
			await vi.advanceTimersByTimeAsync(0);
			expect(failed).not.toHaveBeenCalled();
			expect(pageFrame).toHaveBeenCalledTimes(2);
			expect(view.querySelector('img')?.src).toBe(frame.dataUrl);
			await vi.advanceTimersByTimeAsync(125);
			expect(pageFrame).toHaveBeenCalledTimes(3);
		});
		it('keeps a long paste intact and ahead of subsequent typing while awaiting each chunk', async () => {
			let finishFirst!: () => void;
			pageInput.mockReturnValueOnce(
				new Promise((resolve) => {
					finishFirst = resolve;
				})
			);
			const text = 'a'.repeat(16383) + '\u{1f600}' + 'b'.repeat(16384);
			const keyboard = view.querySelector('textarea')!;
			const paste = new Event('paste', { bubbles: true, cancelable: true });
			Object.defineProperty(paste, 'clipboardData', { value: { getData: () => text } });
			keyboard.dispatchEvent(paste);
			keyboard.value = 'next';
			keyboard.dispatchEvent(new InputEvent('input'));
			await vi.advanceTimersByTimeAsync(0);
			expect(pageInput).toHaveBeenCalledTimes(1);
			const first = pageInput.mock.calls[0][1];
			expect(first.type === 'text' && first.text.length).toBe(16383);
			finishFirst();
			await vi.advanceTimersByTimeAsync(0);
			const inputs = pageInput.mock.calls.map(([, input]) => input);
			expect(inputs).toEqual([
				{ type: 'text', text: 'a'.repeat(16383) },
				{ type: 'text', text: '\u{1f600}' + 'b'.repeat(16382) },
				{ type: 'text', text: 'bb' },
				{ type: 'text', text: 'next' },
			]);
		});
		it('stops sending remaining text chunks when the presentation is disposed', async () => {
			let finishFirst!: () => void;
			pageInput.mockReturnValueOnce(
				new Promise((resolve) => {
					finishFirst = resolve;
				})
			);
			const keyboard = view.querySelector('textarea')!;
			keyboard.value = 'a'.repeat(32768);
			keyboard.dispatchEvent(new InputEvent('input'));
			await vi.advanceTimersByTimeAsync(0);
			expect(pageInput).toHaveBeenCalledTimes(1);
			view.dispose();
			finishFirst();
			await vi.advanceTimersByTimeAsync(0);
			expect(pageInput).toHaveBeenCalledTimes(1);
		});
	});
});
// Source: src/__tests__/renderer/utils/crossTabSearch.test.ts
describe('', () => {
	function log(
		overrides: Partial<LogEntry> & {
			id: string;
			text: string;
		}
	): LogEntry {
		return {
			timestamp: 1700000000000,
			source: 'ai',
			...overrides,
		} as LogEntry;
	}
	describe('searchTabsMessages', () => {
		it('returns an empty result for a blank query', () => {
			const tabs = [
				s2_createMockAITab({ id: 't1', logs: [log({ id: 'l1', text: 'hello world' })] }),
			];
			const result = searchTabsMessages(tabs, '   ');
			expect(result.tabs).toEqual([]);
			expect(result.totalMatches).toBe(0);
			expect(result.error).toBeNull();
		});
		it('finds matches across multiple tabs and groups them per tab', () => {
			const tabs = [
				s2_createMockAITab({
					id: 't1',
					name: 'First',
					logs: [log({ id: 'a', text: 'deploy the widget' }), log({ id: 'b', text: 'unrelated' })],
				}),
				s2_createMockAITab({
					id: 't2',
					name: 'Second',
					logs: [log({ id: 'c', text: 'the WIDGET broke' })],
				}),
			];
			const result = searchTabsMessages(tabs, 'widget');
			expect(result.totalMatches).toBe(2);
			expect(result.tabs.map((t) => t.tabId)).toEqual(['t1', 't2']);
			expect(result.tabs[0].tabName).toBe('First');
			expect(result.tabs[0].matches.map((m) => m.logId)).toEqual(['a']);
			// Case-insensitive by default
			expect(result.tabs[1].matches.map((m) => m.logId)).toEqual(['c']);
		});
		it('omits tabs with no matches entirely', () => {
			const tabs = [
				s2_createMockAITab({ id: 't1', logs: [log({ id: 'a', text: 'nothing here' })] }),
				s2_createMockAITab({ id: 't2', logs: [log({ id: 'b', text: 'found it' })] }),
			];
			const result = searchTabsMessages(tabs, 'found');
			expect(result.tabs).toHaveLength(1);
			expect(result.tabs[0].tabId).toBe('t2');
		});
		it('highlights the exact matched span within the snippet', () => {
			const tabs = [
				s2_createMockAITab({ id: 't1', logs: [log({ id: 'a', text: 'alpha beta gamma' })] }),
			];
			const [match] = searchTabsMessages(tabs, 'beta').tabs[0].matches;
			const [start, end] = match.range;
			expect(match.snippet.slice(start, end)).toBe('beta');
		});
		it('collapses whitespace in snippets while keeping the highlight aligned', () => {
			const tabs = [
				s2_createMockAITab({
					id: 't1',
					logs: [log({ id: 'a', text: 'line one\n\n   line two NEEDLE trailing\n\ttext' })],
				}),
			];
			const [match] = searchTabsMessages(tabs, 'needle').tabs[0].matches;
			const [start, end] = match.range;
			expect(match.snippet).not.toContain('\n');
			expect(match.snippet.slice(start, end)).toBe('NEEDLE');
		});
		it('marks snippets truncated when the entry is longer than the context window', () => {
			const filler = 'x'.repeat(500);
			const tabs = [
				s2_createMockAITab({
					id: 't1',
					logs: [log({ id: 'a', text: `${filler} target ${filler}` })],
				}),
			];
			const [match] = searchTabsMessages(tabs, 'target').tabs[0].matches;
			expect(match.truncatedStart).toBe(true);
			expect(match.truncatedEnd).toBe(true);
		});
		it('counts repeated matches within a single entry', () => {
			const tabs = [
				s2_createMockAITab({ id: 't1', logs: [log({ id: 'a', text: 'foo foo foo bar' })] }),
			];
			const [match] = searchTabsMessages(tabs, 'foo').tabs[0].matches;
			expect(match.matchCount).toBe(3);
			// Still one row per entry
			expect(searchTabsMessages(tabs, 'foo').tabs[0].matches).toHaveLength(1);
		});
		it('treats the query literally in plain-text mode', () => {
			const tabs = [
				s2_createMockAITab({ id: 't1', logs: [log({ id: 'a', text: 'cost is $1.50 today' })] }),
			];
			expect(searchTabsMessages(tabs, '$1.50').totalMatches).toBe(1);
			// The regex metacharacters must not be interpreted
			expect(searchTabsMessages(tabs, 'c.st').totalMatches).toBe(0);
		});
		it('compiles the query as a pattern in regex mode', () => {
			const tabs = [
				s2_createMockAITab({ id: 't1', logs: [log({ id: 'a', text: 'error code 4711 raised' })] }),
			];
			expect(searchTabsMessages(tabs, '\\d{4}', { regex: true }).totalMatches).toBe(1);
		});
		it('reports an invalid regex instead of throwing', () => {
			const tabs = [s2_createMockAITab({ id: 't1', logs: [log({ id: 'a', text: 'anything' })] })];
			const result = searchTabsMessages(tabs, '(unclosed', { regex: true });
			expect(result.error).toBeTruthy();
			expect(result.tabs).toEqual([]);
		});
		it('honors case sensitivity when requested', () => {
			const tabs = [s2_createMockAITab({ id: 't1', logs: [log({ id: 'a', text: 'Widget' })] })];
			expect(searchTabsMessages(tabs, 'widget', { caseSensitive: true }).totalMatches).toBe(0);
			expect(searchTabsMessages(tabs, 'Widget', { caseSensitive: true }).totalMatches).toBe(1);
		});
		it('caps emitted rows per tab but still reports the true total', () => {
			const logs = Array.from({ length: 5 }, (_, i) => log({ id: `l${i}`, text: 'hit' }));
			const tabs = [s2_createMockAITab({ id: 't1', logs })];
			const result = searchTabsMessages(tabs, 'hit', { maxPerTab: 2 });
			expect(result.tabs[0].matches).toHaveLength(2);
			expect(result.tabs[0].totalMatches).toBe(5);
			expect(result.totalMatches).toBe(5);
			expect(result.truncated).toBe(true);
		});
		it('caps emitted rows across all tabs', () => {
			const tabs = [
				s2_createMockAITab({ id: 't1', logs: [log({ id: 'a', text: 'hit' })] }),
				s2_createMockAITab({ id: 't2', logs: [log({ id: 'b', text: 'hit' })] }),
			];
			const result = searchTabsMessages(tabs, 'hit', { maxTotal: 1 });
			expect(flattenCrossTabMatches(result)).toHaveLength(1);
			expect(result.totalMatches).toBe(2);
			expect(result.truncated).toBe(true);
		});
		it('searches every log source, tagging each hit with its origin', () => {
			const tabs = [
				s2_createMockAITab({
					id: 't1',
					logs: [
						log({ id: 'a', text: 'ping', source: 'user' }),
						log({ id: 'b', text: 'ping', source: 'tool' }),
						log({ id: 'c', text: 'ping', source: 'error' }),
					],
				}),
			];
			const sources = searchTabsMessages(tabs, 'ping').tabs[0].matches.map((m) => m.source);
			expect(sources).toEqual(['user', 'tool', 'error']);
		});
		it('skips entries with empty text', () => {
			const tabs = [
				s2_createMockAITab({
					id: 't1',
					logs: [log({ id: 'a', text: '' }), log({ id: 'b', text: 'real' })],
				}),
			];
			expect(searchTabsMessages(tabs, 'real').tabs[0].matches.map((m) => m.logId)).toEqual(['b']);
		});
	});
	describe('flattenCrossTabMatches', () => {
		it('flattens grouped results into keyboard-navigation order', () => {
			const tabs = [
				s2_createMockAITab({
					id: 't1',
					logs: [log({ id: 'a', text: 'hit' }), log({ id: 'b', text: 'hit' })],
				}),
				s2_createMockAITab({ id: 't2', logs: [log({ id: 'c', text: 'hit' })] }),
			];
			const flat = flattenCrossTabMatches(searchTabsMessages(tabs, 'hit'));
			expect(flat.map((f) => f.match.logId)).toEqual(['a', 'b', 'c']);
			expect(flat.map((f) => f.tab.tabId)).toEqual(['t1', 't1', 't2']);
		});
	});
});
// Source: src/__tests__/renderer/utils/executionQueue.test.ts
describe('', () => {
	function item(id: string, paused = false): QueuedItem {
		return { id, timestamp: 0, tabId: 'tab-1', type: 'message', text: id, paused };
	}
	function tabItem(id: string, tabId: string): QueuedItem {
		return { id, timestamp: 0, tabId, type: 'message', text: id };
	}
	describe('executionQueue helpers', () => {
		it('isRunnableQueueItem treats user and connection holds as non-runnable', () => {
			expect(isRunnableQueueItem(item('a'))).toBe(true);
			expect(isRunnableQueueItem(item('b', true))).toBe(false);
			expect(isRunnableQueueItem({ ...item('c'), waitingForConnection: true })).toBe(false);
		});
		it('releaseConnectionHeldQueueItems removes only the connection hold', () => {
			const held = { ...item('a', true), waitingForConnection: true };
			const queue = [held, item('b')];
			const released = releaseConnectionHeldQueueItems(queue);
			expect(released[0]).toEqual(item('a', true));
			expect(released[1]).toEqual(item('b'));
			expect(releaseConnectionHeldQueueItems(released)).toBe(released);
		});
		it('nextRunnableQueueItem returns the first non-paused item', () => {
			const q = [item('a', true), item('b'), item('c')];
			expect(nextRunnableQueueItem(q)?.id).toBe('b');
			expect(nextRunnableQueueItem([item('a', true)])).toBeUndefined();
			expect(nextRunnableQueueItem([])).toBeUndefined();
		});
		it('does not let later work overtake a connection-held item', () => {
			const q = [
				item('paused', true),
				{ ...item('held'), waitingForConnection: true },
				item('later'),
			];
			expect(nextRunnableQueueItem(q)).toBeUndefined();
			expect(hasRunnableQueueItem(q)).toBe(false);
			expect(takeNextRunnableQueueItem(q)).toEqual({ item: null, remaining: q });
		});
		it('hasRunnableQueueItem reflects whether any item can run', () => {
			expect(hasRunnableQueueItem([item('a', true), item('b')])).toBe(true);
			expect(hasRunnableQueueItem([item('a', true), item('b', true)])).toBe(false);
			expect(hasRunnableQueueItem([])).toBe(false);
		});
		it('takeNextRunnableQueueItem removes the first runnable item, preserving order of the rest', () => {
			const q = [item('a', true), item('b'), item('c')];
			const { item: taken, remaining } = takeNextRunnableQueueItem(q);
			expect(taken?.id).toBe('b');
			// The paused item ahead of it stays in place; 'c' keeps its order.
			expect(remaining.map((i) => i.id)).toEqual(['a', 'c']);
		});
		it('takeNextRunnableQueueItem returns null + unchanged queue when all items are paused', () => {
			const q = [item('a', true), item('b', true)];
			const { item: taken, remaining } = takeNextRunnableQueueItem(q);
			expect(taken).toBeNull();
			expect(remaining).toBe(q);
		});
	});
	describe('mergeQueuedItemIntoPrevious', () => {
		it.each([
			['user', 'user', 'user'],
			['user', 'auto', 'auto'],
			['user', undefined, undefined],
			['auto', 'user', 'auto'],
			[undefined, 'user', undefined],
		] as const)('keeps merged provenance conservative for %s + %s', (first, second, expected) => {
			const result = mergeQueuedItemIntoPrevious(
				[msg('a', { querySource: first }), msg('b', { querySource: second })],
				'b'
			);
			expect(result?.queue[0].querySource).toBe(expected);
		});
		const msg = (id: string, overrides: Partial<QueuedItem> = {}): QueuedItem => ({
			id,
			timestamp: 0,
			tabId: 'tab-1',
			type: 'message',
			text: `text ${id}`,
			...overrides,
		});
		it('appends the text and images to the item above and keeps its id, place and settings', () => {
			const q = [
				msg('a', { images: ['img-a'], paused: true, turnSettings: { model: 'opus' } }),
				msg('b', { images: ['img-b'], turnSettings: { model: 'haiku' } }),
				msg('c'),
			];
			const result = mergeQueuedItemIntoPrevious(q, 'b');
			expect(result?.targetId).toBe('a');
			expect(result?.queue.map((i) => i.id)).toEqual(['a', 'c']);
			expect(result?.queue[0]).toMatchObject({
				text: 'text a\n\ntext b',
				images: ['img-a', 'img-b'],
				paused: true,
				turnSettings: { model: 'opus' },
			});
		});
		it('separates the two with exactly one blank line, whatever whitespace they carried', () => {
			const q = [msg('a', { text: 'first\n\n\n  ' }), msg('b', { text: '\n\n  second' })];
			expect(mergeQueuedItemIntoPrevious(q, 'b')?.queue[0].text).toBe('first\n\n  second');
		});
		it('merges into the previous item for the SAME tab, skipping other tabs', () => {
			const q = [msg('a'), msg('x', { tabId: 'tab-2' }), msg('b')];
			expect(findQueuedMergeTarget(q, 'b')?.id).toBe('a');
			expect(mergeQueuedItemIntoPrevious(q, 'b')?.queue.map((i) => i.id)).toEqual(['a', 'x']);
		});
		it('keeps an @mention from either message so dispatch re-plans the consult', () => {
			const q = [msg('a'), msg('b', { crossAgentMention: true })];
			expect(mergeQueuedItemIntoPrevious(q, 'b')?.queue[0].crossAgentMention).toBe(true);
		});
		it('keeps a picked mention routing, preferring the earlier message', () => {
			expect(
				mergeQueuedItemIntoPrevious([msg('a'), msg('b', { mentionRouting: 'handoff' })], 'b')
					?.queue[0].mentionRouting
			).toBe('handoff');
			expect(
				mergeQueuedItemIntoPrevious(
					[msg('a', { mentionRouting: 'parallel' }), msg('b', { mentionRouting: 'handoff' })],
					'b'
				)?.queue[0].mentionRouting
			).toBe('parallel');
		});
		it('refuses the first item, commands, leading-mention messages, and consult holds', () => {
			expect(mergeQueuedItemIntoPrevious([msg('a'), msg('b')], 'a')).toBeNull();
			expect(
				mergeQueuedItemIntoPrevious([msg('a', { type: 'command' }), msg('b')], 'b')
			).toBeNull();
			expect(
				mergeQueuedItemIntoPrevious([msg('a'), msg('b', { type: 'command' })], 'b')
			).toBeNull();
			expect(
				mergeQueuedItemIntoPrevious([msg('a'), msg('b', { crossAgentOnly: true })], 'b')
			).toBeNull();
			expect(
				mergeQueuedItemIntoPrevious(
					[msg('a', { awaitingConsult: {} as QueuedItem['awaitingConsult'] }), msg('b')],
					'b'
				)
			).toBeNull();
			expect(mergeQueuedItemIntoPrevious([msg('a'), msg('x', { tabId: 'tab-2' })], 'x')).toBeNull();
			expect(mergeQueuedItemIntoPrevious([msg('a')], 'missing')).toBeNull();
		});
	});
	describe('reorderQueueItem', () => {
		it('moves an item within the whole queue when no tabId is given', () => {
			const q = [item('a'), item('b'), item('c')];
			expect(reorderQueueItem(q, 0, 2).map((i) => i.id)).toEqual(['b', 'c', 'a']);
			expect(reorderQueueItem(q, 2, 0).map((i) => i.id)).toEqual(['c', 'a', 'b']);
		});
		it('returns the same queue reference for no-op or out-of-range moves', () => {
			const q = [item('a'), item('b')];
			expect(reorderQueueItem(q, 1, 1)).toBe(q);
			expect(reorderQueueItem(q, -1, 0)).toBe(q);
			expect(reorderQueueItem(q, 0, 5)).toBe(q);
		});
		it('reorders only the target tab and keeps other tabs in their absolute slots', () => {
			// Interleaved: tab-1 at slots 0 and 2, tab-2 at slot 1.
			const q = [tabItem('a', 'tab-1'), tabItem('x', 'tab-2'), tabItem('c', 'tab-1')];
			// In tab-1's filtered view [a, c], move a (0) after c (1).
			const result = reorderQueueItem(q, 0, 1, 'tab-1');
			// tab-1 items become [c, a] back in slots 0 and 2; tab-2 'x' stays at slot 1.
			expect(result.map((i) => i.id)).toEqual(['c', 'x', 'a']);
		});
		it('treats tab-scoped indices as positions within that tab only', () => {
			const q = [
				tabItem('a', 'tab-1'),
				tabItem('b', 'tab-1'),
				tabItem('x', 'tab-2'),
				tabItem('c', 'tab-1'),
			];
			// tab-1 filtered view [a, b, c]; move c (index 2) to front (index 0).
			const result = reorderQueueItem(q, 2, 0, 'tab-1');
			expect(result.map((i) => i.id)).toEqual(['c', 'a', 'x', 'b']);
		});
		it('returns the same queue reference for out-of-range tab-scoped moves', () => {
			const q = [tabItem('a', 'tab-1'), tabItem('x', 'tab-2')];
			// tab-1 has only one item, so index 1 is out of range for its view.
			expect(reorderQueueItem(q, 0, 1, 'tab-1')).toBe(q);
		});
	});
	describe('hasWorkAheadOfNewMessage', () => {
		it('is false for an idle agent with an empty queue', () => {
			const session = createMockSession({ aiTabs: [s3_createMockAITab({ id: 'tab-1' })] });
			expect(hasWorkAheadOfNewMessage(session)).toBe(false);
		});
		it('is true while any tab is mid-turn, including a closed-but-thinking orphan', () => {
			const busy = createMockSession({
				aiTabs: [s3_createMockAITab({ id: 'tab-1', state: 'busy' })],
			});
			expect(hasWorkAheadOfNewMessage(busy)).toBe(true);
			// A tab closed mid-send keeps working in the background and still holds
			// the agent's order, so a new message lands behind it.
			const orphaned = createMockSession({
				aiTabs: [s3_createMockAITab({ id: 'tab-1' })],
				orphanedThinkingTabs: [s3_createMockAITab({ id: 'tab-gone', state: 'busy' })],
			});
			expect(hasWorkAheadOfNewMessage(orphaned)).toBe(true);
		});
		it('counts runnable and connection-held work, but not user-paused work', () => {
			const queued = createMockSession({
				aiTabs: [s3_createMockAITab({ id: 'tab-1' })],
				executionQueue: [item('a')],
			});
			expect(hasWorkAheadOfNewMessage(queued)).toBe(true);
			// A paused item is invisible to dispatch, so nothing is actually ahead.
			const held = createMockSession({
				aiTabs: [s3_createMockAITab({ id: 'tab-1' })],
				executionQueue: [item('a', true)],
			});
			expect(hasWorkAheadOfNewMessage(held)).toBe(false);
			const connectionHeld = createMockSession({
				aiTabs: [s3_createMockAITab({ id: 'tab-1' })],
				executionQueue: [{ ...item('a'), waitingForConnection: true }],
			});
			expect(hasWorkAheadOfNewMessage(connectionHeld)).toBe(true);
		});
		it('is true while Auto Run is active, which never marks the agent busy', () => {
			const session = createMockSession({ aiTabs: [s3_createMockAITab({ id: 'tab-1' })] });
			expect(hasWorkAheadOfNewMessage(session, { autoRunActive: true })).toBe(true);
		});
	});
	describe('applyQueuedItemRelease', () => {
		it('returns the agent to idle when the released tab was the only one working', () => {
			const session = createMockSession({
				state: 'busy',
				busySource: 'ai',
				thinkingStartTime: 123,
				aiTabs: [s3_createMockAITab({ id: 'tab-1', state: 'busy', thinkingStartTime: 123 })],
			});
			const next = applyQueuedItemRelease(session, 'tab-1');
			expect(next.aiTabs[0].state).toBe('idle');
			expect(next.aiTabs[0].thinkingStartTime).toBeUndefined();
			expect(next.state).toBe('idle');
			expect(next.busySource).toBeUndefined();
			expect(next.thinkingStartTime).toBeUndefined();
		});
		it('keeps the agent busy when another tab is still mid-turn', () => {
			// Blanking the agent state here would strand the other tab's thinking pill.
			const session = createMockSession({
				state: 'busy',
				busySource: 'ai',
				thinkingStartTime: 123,
				aiTabs: [
					s3_createMockAITab({ id: 'tab-1', state: 'busy', thinkingStartTime: 123 }),
					s3_createMockAITab({ id: 'tab-2', state: 'busy', thinkingStartTime: 456 }),
				],
			});
			const next = applyQueuedItemRelease(session, 'tab-1');
			expect(next.aiTabs[0].state).toBe('idle');
			expect(next.aiTabs[1].state).toBe('busy');
			expect(next.state).toBe('busy');
			expect(next.thinkingStartTime).toBe(123);
		});
		it('keeps the agent busy for a still-thinking orphan tab', () => {
			const session = createMockSession({
				state: 'busy',
				busySource: 'ai',
				aiTabs: [s3_createMockAITab({ id: 'tab-1', state: 'busy' })],
				orphanedThinkingTabs: [s3_createMockAITab({ id: 'tab-gone', state: 'busy' })],
			});
			const next = applyQueuedItemRelease(session, 'tab-1');
			expect(next.state).toBe('busy');
			expect(next.orphanedThinkingTabs?.[0].state).toBe('busy');
		});
		it('leaves the queue untouched', () => {
			const session = createMockSession({
				state: 'busy',
				aiTabs: [s3_createMockAITab({ id: 'tab-1', state: 'busy' })],
				executionQueue: [item('a'), item('b')],
			});
			expect(applyQueuedItemRelease(session, 'tab-1').executionQueue.map((i) => i.id)).toEqual([
				'a',
				'b',
			]);
		});
	});
	describe('resolveQueuedItemTabName', () => {
		const tab = (id: string, name?: string) => ({ id, name, state: 'idle' }) as unknown as AITab;
		const session = (tabs: AITab[], orphans: AITab[] = []) =>
			({ aiTabs: tabs, orphanedThinkingTabs: orphans }) as unknown as Session;
		it('prefers the live tab name over the snapshot taken when the item was queued', () => {
			const queued = { tabId: 'tab-1', tabName: 'New' };
			expect(resolveQueuedItemTabName(session([tab('tab-1', 'PR #1427')]), queued)).toBe(
				'PR #1427'
			);
		});
		it('gives two items on the same tab the same label once that tab is named', () => {
			const s = session([tab('tab-1', 'PR #1427')]);
			const first = { tabId: 'tab-1', tabName: 'New' };
			const second = { tabId: 'tab-1', tabName: 'PR #1427' };
			expect(resolveQueuedItemTabName(s, first)).toBe(resolveQueuedItemTabName(s, second));
		});
		it('falls back to an orphaned (closed but draining) tab before the snapshot', () => {
			const s = session([], [tab('tab-9', 'Draining Tab')]);
			expect(resolveQueuedItemTabName(s, { tabId: 'tab-9', tabName: 'Stale' })).toBe(
				'Draining Tab'
			);
		});
		it('falls back to the snapshot when the tab is gone entirely', () => {
			expect(resolveQueuedItemTabName(session([]), { tabId: 'gone', tabName: 'Old Name' })).toBe(
				'Old Name'
			);
		});
	});
	describe('shouldOfferForceSend', () => {
		const tab = (id: string, state: 'idle' | 'busy') => ({ id, state }) as unknown as AITab;
		const session = (tabs: AITab[]) => ({ aiTabs: tabs }) as unknown as Session;
		const queued = { tabId: 'tab-1' };
		const eligibility = (tabs: AITab[], forcedParallelEnabled = true) =>
			getForceSendEligibility(session(tabs), queued, { forcedParallelEnabled });
		it('offers the control on a quiet agent, where forcing is always allowed', () => {
			const e = eligibility([tab('tab-1', 'idle')]);
			expect(e.canForce).toBe(true);
			expect(shouldOfferForceSend(e)).toBe(true);
		});
		it('offers it disabled when only the Forced Parallel setting is in the way', () => {
			// The one blocked reason the user can act on: the tooltip names a
			// setting, so the dimmed button is a signpost rather than a dead control.
			const e = eligibility([tab('tab-1', 'idle'), tab('tab-2', 'busy')], false);
			expect(e.blockedReason).toBe('needs-forced-parallel');
			expect(shouldOfferForceSend(e)).toBe(true);
		});
		it("hides it when the item's own tab is mid-turn", () => {
			// A tab runs one turn at a time, so the item is next in line by
			// definition and the wait resolves itself.
			const e = eligibility([tab('tab-1', 'busy')]);
			expect(e.blockedReason).toBe('target-tab-busy');
			expect(shouldOfferForceSend(e)).toBe(false);
		});
		it('hides it when there is no tab left to run on', () => {
			// No AI tabs at all, so there is not even an active tab to fall back to.
			const e = eligibility([]);
			expect(e.blockedReason).toBe('no-target-tab');
			expect(shouldOfferForceSend(e)).toBe(false);
		});
		it('hides it when eligibility has not been computed', () => {
			expect(shouldOfferForceSend(null)).toBe(false);
			expect(shouldOfferForceSend(undefined)).toBe(false);
		});
	});
	/**
	 * applyQueuedItemEdit is the single write for a queued-message edit. Both save
	 * paths call it - the inline chat list (App.tsx, active agent) and the
	 * Execution Queue browser (useQueueHandlers, any agent by id) - because they
	 * had already drifted once: one of them dropped `turnSettings`, silently
	 * discarding the model and effort the user had just picked in the modal.
	 */
	describe('applyQueuedItemEdit', () => {
		const patch = (over: Partial<QueuedItem['turnSettings']> | undefined = undefined) => ({
			text: 'edited',
			images: [] as string[],
			turnSettings: over ?? {},
		});
		it('writes the model/effort override onto the target item', () => {
			const queue = [item('a'), item('b')];
			const next = applyQueuedItemEdit(queue, 'a', {
				text: 'edited',
				images: [],
				turnSettings: { model: 'opus', effort: 'ultrathink' },
			});
			expect(next[0].text).toBe('edited');
			expect(next[0].turnSettings).toEqual({ model: 'opus', effort: 'ultrathink' });
		});
		it('leaves every other item untouched', () => {
			const queue = [item('a'), item('b')];
			const next = applyQueuedItemEdit(queue, 'a', patch({ model: 'opus' }));
			expect(next[1]).toBe(queue[1]);
			expect(next[1].text).toBe('b');
		});
		it('assigns turnSettings rather than merging, so a cleared picker clears', () => {
			const queue = [{ ...item('a'), turnSettings: { model: 'opus', effort: 'ultrathink' } }];
			// User cleared the model back to "Default" but kept the effort.
			const next = applyQueuedItemEdit(queue, 'a', patch({ effort: 'ultrathink' }));
			expect(next[0].turnSettings).toEqual({ effort: 'ultrathink' });
			expect(next[0].turnSettings?.model).toBeUndefined();
		});
		it('preserves queue order and length', () => {
			const queue = [item('a'), item('b'), item('c')];
			const next = applyQueuedItemEdit(queue, 'b', patch({ model: 'opus' }));
			expect(next.map((i) => i.id)).toEqual(['a', 'b', 'c']);
		});
		it('is a no-op when the id is not in the queue', () => {
			const queue = [item('a')];
			const next = applyQueuedItemEdit(queue, 'missing', patch({ model: 'opus' }));
			expect(next[0]).toBe(queue[0]);
		});
		it('writes the re-derived @mention fields, dropping a routing the edit invalidated', () => {
			const queue = [{ ...item('a'), crossAgentMention: true, mentionRouting: 'handoff' as const }];
			const kept = applyQueuedItemEdit(queue, 'a', patch(), {
				crossAgentMention: true,
				crossAgentOnly: false,
				mentionRouting: 'handoff',
			});
			expect(kept[0].mentionRouting).toBe('handoff');
			// The edit removed every mention: no consult, no routing.
			const dropped = applyQueuedItemEdit(queue, 'a', patch(), {
				crossAgentMention: false,
				crossAgentOnly: false,
				mentionRouting: undefined,
			});
			expect(dropped[0].crossAgentMention).toBe(false);
			expect(dropped[0].mentionRouting).toBeUndefined();
		});
		it('does not disturb an item paused state', () => {
			const queue = [item('a', /* paused */ true)];
			const next = applyQueuedItemEdit(queue, 'a', patch({ model: 'opus' }));
			expect(next[0].paused).toBe(true);
		});
	});
	// ============================================================================
	// applyQueuedItemDispatchFailure
	// ============================================================================
	describe('applyQueuedItemDispatchFailure', () => {
		function sessionWithCard(overrides: Partial<Session> = {}): Session {
			const tab = s3_createMockAITab({
				id: 'tab-1',
				state: 'busy',
				thinkingStartTime: 111,
				logs: [
					{ id: 'log-old', timestamp: 1, source: 'user', text: 'send this' },
					{ id: 'log-card', timestamp: 2, source: 'user', text: 'send this', queuedItemId: 'q1' },
				],
			});
			return createMockSession({
				id: 's1',
				state: 'busy',
				busySource: 'ai',
				thinkingStartTime: 111,
				aiTabs: [tab],
				activeTabId: 'tab-1',
				executionQueue: [],
				...overrides,
			} as Partial<Session>);
		}
		const failed: QueuedItem = {
			id: 'q1',
			timestamp: 0,
			tabId: 'tab-1',
			type: 'message',
			text: 'send this',
		};
		it('releases the tab, removes only the card this dispatch wrote, and re-queues at the head', () => {
			const later: QueuedItem = { ...failed, id: 'q2', text: 'later' };
			const next = applyQueuedItemDispatchFailure(
				sessionWithCard({ executionQueue: [later] }),
				failed,
				{ collision: false }
			);
			expect(next.aiTabs[0].state).toBe('idle');
			expect(next.aiTabs[0].thinkingStartTime).toBeUndefined();
			expect(next.state).toBe('idle');
			// The identical message the user really did send earlier survives; only the
			// stamped card for this failed dispatch goes.
			expect(next.aiTabs[0].logs.map((l) => l.id)).toEqual(['log-old']);
			// Head of the queue, so it keeps its place ahead of everything behind it.
			expect(next.executionQueue.map((i) => i.id)).toEqual(['q1', 'q2']);
		});
		it.each([false, true])(
			'retains recovered work against a stale peer dequeue (collision=%s)',
			(collision) => {
				const baseline = sessionWithCard({ executionQueue: [failed] });
				const recovered = applyQueuedItemDispatchFailure(sessionWithCard(), failed, {
					collision,
				});
				// A peer persisted the original dequeue before hearing about spawn failure.
				const stored = mergeSessionPersistenceChanges(
					{ ...baseline, executionQueue: [] },
					recovered,
					baseline,
					true
				);
				expect(stored.executionQueue).toEqual(recovered.executionQueue);
				const mirrored = mergeSessionPersistenceChanges(
					{ ...baseline, executionQueue: [] },
					recovered,
					baseline,
					true,
					true
				);
				expect(mirrored.executionQueue).toEqual(recovered.executionQueue);
				// Once the recovered attempt really runs, its own removal must win.
				expect(
					mergeSessionPersistenceChanges(
						{ ...recovered, executionQueue: [] },
						recovered,
						recovered,
						true,
						true
					).executionQueue
				).toEqual([]);
			}
		);
		it('holds the item when the failure is not a transient collision', () => {
			const next = applyQueuedItemDispatchFailure(sessionWithCard(), failed, {
				collision: false,
			});
			expect(next.executionQueue.map((i) => i.id)).toEqual(['q1']);
			// Preserved and visible, but it cannot spin the queue against a wall that
			// would refuse it identically on the next tick.
			expect(next.executionQueue[0].paused).toBe(true);
		});
		// "Agent process already running": a process still owns the tab's key, and
		// only the exit handler removes it, so that exit will come and settle the tab.
		it('leaves a colliding tab and the agent busy, with the item runnable', () => {
			const next = applyQueuedItemDispatchFailure(sessionWithCard(), failed, {
				collision: true,
			});
			expect(next.aiTabs[0].state).toBe('busy');
			expect(next.state).toBe('busy');
			expect(next.busySource).toBe('ai');
			// The card still goes: this prompt was never delivered.
			expect(next.aiTabs[0].logs.map((l) => l.id)).toEqual(['log-old']);
			expect(next.executionQueue.map((i) => i.id)).toEqual(['q1']);
			expect(next.executionQueue[0].paused).toBeFalsy();
		});
		it('is idempotent when the item is already back in the queue', () => {
			// `retryStore.holdFailedItemInQueue` parks the failed turn in the queue for
			// the life of an outage. A second copy would double-send the prompt.
			const held = sessionWithCard({ executionQueue: [failed] });
			const next = applyQueuedItemDispatchFailure(held, failed, { collision: true });
			expect(next.executionQueue.map((i) => i.id)).toEqual(['q1']);
		});
		it('leaves the agent busy when another tab is still running its own turn', () => {
			const base = sessionWithCard();
			const withOther = {
				...base,
				aiTabs: [...base.aiTabs, s3_createMockAITab({ id: 'tab-2', state: 'busy' })],
			} as Session;
			const next = applyQueuedItemDispatchFailure(withOther, failed, { collision: false });
			expect(next.aiTabs.find((t) => t.id === 'tab-1')!.state).toBe('idle');
			expect(next.aiTabs.find((t) => t.id === 'tab-2')!.state).toBe('busy');
			expect(next.state).toBe('busy');
		});
		it('strips the card from a closed-but-still-draining orphan tab', () => {
			const orphan = s3_createMockAITab({
				id: 'tab-9',
				state: 'busy',
				logs: [{ id: 'log-card', timestamp: 2, source: 'user', text: 'x', queuedItemId: 'q1' }],
			});
			const base = createMockSession({
				id: 's1',
				state: 'busy',
				aiTabs: [s3_createMockAITab({ id: 'tab-1' })],
				activeTabId: 'tab-1',
				executionQueue: [],
				orphanedThinkingTabs: [orphan],
			} as Partial<Session>);
			const next = applyQueuedItemDispatchFailure(
				base,
				{ ...failed, tabId: 'tab-9' },
				{ collision: false }
			);
			expect(next.orphanedThinkingTabs![0].logs).toHaveLength(0);
			expect(next.orphanedThinkingTabs![0].state).toBe('idle');
		});
	});
	// The re-authentication resume replays a snapshotted prompt. If the user
	// already re-sent that prompt by hand (which is what they do when the failed
	// turn is invisible), running both spends two turns on one question.
	describe('applyReplayDispatch', () => {
		const busySession = () =>
			createMockSession({
				id: 's1',
				aiTabs: [s3_createMockAITab({ id: 'tab-1', state: 'busy' })],
				activeTabId: 'tab-1',
				executionQueue: [],
			} as Partial<Session>);
		it('refuses a tab that is mid-turn', () => {
			const result = applyReplayDispatch(busySession(), item('q1'));
			expect(result.blocked).toBe('target-tab-busy');
		});
		it('resends onto a tab the caller itself marked busy for this turn', () => {
			const result = applyReplayDispatch(busySession(), item('q1'), undefined, {
				targetBusyIsOurs: true,
			});
			expect(result.blocked).toBeUndefined();
			expect(result.session.aiTabs[0].state).toBe('busy');
			expect(result.session.state).toBe('busy');
		});
	});
	describe('isSameQueuedPrompt', () => {
		const base: QueuedItem = {
			id: 'a',
			timestamp: 0,
			tabId: 'tab-1',
			type: 'message',
			text: 'hi',
		};
		it('matches the same ask under a different id', () => {
			expect(isSameQueuedPrompt(base, { ...base, id: 'b', timestamp: 999 })).toBe(true);
		});
		it('ignores leading and trailing whitespace', () => {
			expect(isSameQueuedPrompt(base, { ...base, id: 'b', text: '  hi\n' })).toBe(true);
		});
		it('does not match a different tab', () => {
			expect(isSameQueuedPrompt(base, { ...base, id: 'b', tabId: 'tab-2' })).toBe(false);
		});
		it('does not match different text', () => {
			expect(isSameQueuedPrompt(base, { ...base, id: 'b', text: 'something else' })).toBe(false);
		});
		it('does not match when one carries attachments', () => {
			expect(isSameQueuedPrompt(base, { ...base, id: 'b', images: ['img'] })).toBe(false);
		});
		it('distinguishes slash commands by name and arguments', () => {
			const cmd: QueuedItem = {
				id: 'a',
				timestamp: 0,
				tabId: 'tab-1',
				type: 'command',
				command: '/x',
			};
			expect(isSameQueuedPrompt(cmd, { ...cmd, id: 'b' })).toBe(true);
			expect(isSameQueuedPrompt(cmd, { ...cmd, id: 'b', command: '/y' })).toBe(false);
			expect(isSameQueuedPrompt(cmd, { ...cmd, id: 'b', commandArgs: 'now' })).toBe(false);
		});
		it('findQueuedDuplicate locates the user copy in the queue', () => {
			const queue = [tabItem('other', 'tab-2'), { ...base, id: 'user-copy' }];
			expect(findQueuedDuplicate({ executionQueue: queue }, base)?.id).toBe('user-copy');
			expect(findQueuedDuplicate({ executionQueue: [] }, base)).toBeUndefined();
		});
	});
	/**
	 * A consult hold is a barrier for ONE tab: the turn that @mentioned another
	 * agent is not finished until the reply lands, so nothing queued for that tab
	 * may run ahead of it - while other tabs carry on.
	 */
	describe('consult hold', () => {
		const held = (tabId: string): QueuedItem => ({
			id: `hold-${tabId}`,
			timestamp: 0,
			tabId,
			type: 'message',
			text: 'Waiting',
			awaitingConsult: {
				pending: [{ targetSessionId: 's-b', targetAgentName: 'Backend' }],
				replies: [],
			},
		});
		it('is not runnable while it waits', () => {
			expect(isRunnableQueueItem(held('tab-1'))).toBe(false);
		});
		it('blocks later items for its own tab but not for other tabs', () => {
			const queue = [held('tab-1'), tabItem('same', 'tab-1'), tabItem('other', 'tab-2')];
			expect(nextRunnableQueueItem(queue)?.id).toBe('other');
			const { item: taken, remaining } = takeNextRunnableQueueItem(queue);
			expect(taken?.id).toBe('other');
			expect(remaining.map((i) => i.id)).toEqual(['hold-tab-1', 'same']);
		});
		it('leaves nothing runnable when only its own tab has work', () => {
			const queue = [held('tab-1'), tabItem('same', 'tab-1')];
			expect(hasRunnableQueueItem(queue)).toBe(false);
			expect(takeNextRunnableQueueItem(queue)).toEqual({ item: null, remaining: queue });
		});
		it('counts as work ahead of a new message', () => {
			const session = createMockSession({ aiTabs: [], executionQueue: [held('tab-1')] });
			expect(hasWorkAheadOfNewMessage(session)).toBe(true);
		});
		it('is found per tab', () => {
			const queue = [held('tab-1')];
			expect(hasConsultHoldForTab(queue, 'tab-1')).toBe(true);
			expect(hasConsultHoldForTab(queue, 'tab-2')).toBe(false);
			expect(hasConsultHoldForTab(queue, undefined)).toBe(false);
		});
		it('drops only its own tab, and returns the same queue when absent', () => {
			const other = tabItem('other', 'tab-1');
			const queue = [held('tab-1'), held('tab-2'), other];
			expect(dropConsultHold(queue, 'tab-1').map((i) => i.id)).toEqual(['hold-tab-2', 'other']);
			const plain = [other];
			expect(dropConsultHold(plain, 'tab-1')).toBe(plain);
		});
		it('cannot be force sent: it has nothing to send until the reply lands', () => {
			const session = { aiTabs: [{ id: 'tab-1', state: 'idle' }] } as unknown as Session;
			const e = getForceSendEligibility(session, held('tab-1'), { forcedParallelEnabled: true });
			expect(e.blockedReason).toBe('awaiting-consult');
			expect(e.canForce).toBe(false);
			expect(shouldOfferForceSend(e)).toBe(false);
		});
		it('is dropped when the turn that placed it fails to dispatch', () => {
			// The restored item places a fresh hold when it dispatches again; the old
			// one would otherwise deliver a continuation for a turn that never ran.
			const failedMention: QueuedItem = {
				id: 'q1',
				timestamp: 0,
				tabId: 'tab-1',
				type: 'message',
				text: 'ask @Backend',
				crossAgentMention: true,
			};
			const session = createMockSession({
				id: 's1',
				aiTabs: [s3_createMockAITab({ id: 'tab-1', state: 'busy' })],
				activeTabId: 'tab-1',
				executionQueue: [held('tab-1')],
			} as Partial<Session>);
			const recovered = applyQueuedItemDispatchFailure(session, failedMention, {
				collision: true,
			});
			expect(recovered.executionQueue.map((i) => i.id)).toEqual(['q1']);
		});
	});
	// ============================================================================
	// getSteerEligibility / shouldOfferSteer  (chat steering)
	// ============================================================================
	describe('getSteerEligibility', () => {
		function steerableSession(overrides: Partial<Session> = {}): Session {
			return createMockSession({
				id: 's1',
				toolType: 'claude-code',
				aiTabs: [s3_createMockAITab({ id: 'tab-1', state: 'busy' })],
				activeTabId: 'tab-1',
				claudeInteractive: { mode: 'interactive', modeReason: 'auto' },
				...overrides,
			} as Partial<Session>);
		}
		const item = { tabId: 'tab-1', text: 'change course' };
		it('allows steering a Claude interactive turn that is running', () => {
			const eligibility = getSteerEligibility(steerableSession(), item);
			expect(eligibility).toEqual({ canSteer: true });
			expect(shouldOfferSteer(eligibility)).toBe(true);
		});
		// A dispatch callback is another agent's report. Typing it into the running
		// turn would land it mid-thread as if the user wrote it, so the control is
		// not offered at all; the callback runs as its own turn once the tab is idle.
		it('refuses and hides Steer for a queued dispatch callback', () => {
			const eligibility = getSteerEligibility(steerableSession(), {
				...item,
				dispatchCallback: true,
			});
			expect(eligibility).toEqual({ canSteer: false, blockedReason: 'dispatch-callback' });
			expect(shouldOfferSteer(eligibility)).toBe(false);
			expect(describeSteerBlocked('dispatch-callback')).toMatch(/own turn/);
		});
		it('refuses when the target tab is not working', () => {
			// There is no turn in flight to steer, and this message is about to become
			// that turn anyway.
			const session = steerableSession({
				aiTabs: [s3_createMockAITab({ id: 'tab-1', state: 'idle' })],
			});
			expect(getSteerEligibility(session, item)).toEqual({
				canSteer: false,
				blockedReason: 'tab-not-working',
			});
		});
		it('refuses when the API token source is resolved', () => {
			// `claude --print` closes stdin and holds no writable PTY for the turn, so
			// there is physically nothing to type into.
			const session = steerableSession({
				claudeInteractive: { mode: 'api', modeReason: 'limit' },
			});
			expect(getSteerEligibility(session, item)).toEqual({
				canSteer: false,
				blockedReason: 'api-token-source',
			});
		});
		it('refuses a dynamic agent that has fallen back to API', () => {
			// The whole reason this reads the RESOLVED mode: a dynamic agent is configured
			// identically in both states, so only the resolved value knows which shape the
			// turn in flight actually has.
			const session = steerableSession({
				enableMaestroP: true,
				maestroPMode: 'dynamic',
				claudeInteractive: { mode: 'api', modeReason: 'limit' },
			} as Partial<Session>);
			expect(getSteerEligibility(session, item).blockedReason).toBe('api-token-source');
		});
		it('allows a dynamic agent currently resolved to interactive', () => {
			const session = steerableSession({
				enableMaestroP: true,
				maestroPMode: 'dynamic',
				claudeInteractive: { mode: 'interactive', modeReason: 'auto' },
			} as Partial<Session>);
			expect(getSteerEligibility(session, item).canSteer).toBe(true);
		});
		it('refuses when no mode has been resolved yet', () => {
			// Absent until the agent has spawned at least once. Unknown is not interactive.
			const session = steerableSession({ claudeInteractive: undefined });
			expect(getSteerEligibility(session, item).blockedReason).toBe('api-token-source');
		});
		it('refuses a provider that has no steering channel', () => {
			const session = steerableSession({ toolType: 'opencode' });
			expect(getSteerEligibility(session, item).blockedReason).toBe('not-claude');
		});
		it('offers steering only for native adapters with an in-turn channel', () => {
			for (const toolType of ['claude-code', 'copilot-cli', 'hermes', 'pi', 'omp'] as const) {
				const session = steerableSession({
					toolType,
					harnessControlMode: 'native',
					claudeInteractive: undefined,
				});
				expect(getSteerEligibility(session, item).canSteer, toolType).toBe(true);
			}
			const acpSession = steerableSession({
				toolType: 'qwen3-coder',
				harnessControlMode: 'native',
				claudeInteractive: undefined,
			});
			expect(getSteerEligibility(acpSession, item).blockedReason).toBe('not-claude');
		});
		it('allows native steering after Claude publishes API transport mode', () => {
			const session = steerableSession({
				harnessControlMode: 'native',
				claudeInteractive: { mode: 'api', modeReason: 'auto' },
			});
			expect(getSteerEligibility(session, { ...item, text: '/clear' }).canSteer).toBe(true);
		});
		it('keeps the TUI prefix guard when native startup resolves to interactive fallback', () => {
			const session = steerableSession({
				harnessControlMode: 'native',
				claudeInteractive: { mode: 'interactive', modeReason: 'auto' },
			});
			expect(getSteerEligibility(session, { ...item, text: '/clear' }).blockedReason).toBe(
				'tui-command-prefix'
			);
		});
		it('allows a Codex agent on the app-server transport', () => {
			// `turn/steer` reaches a running app-server turn; the Claude token-mode check
			// does not apply to Codex at all.
			const session = steerableSession({
				toolType: 'codex',
				codexTransport: 'app-server',
				claudeInteractive: undefined,
			});
			const eligibility = getSteerEligibility(session, item);
			expect(eligibility).toEqual({ canSteer: true });
			expect(shouldOfferSteer(eligibility)).toBe(true);
		});
		it('refuses a Codex agent on exec with codex-exec', () => {
			// `codex exec` is the default and accepts nothing once a turn has started.
			for (const codexTransport of [undefined, 'exec'] as const) {
				const eligibility = getSteerEligibility(
					steerableSession({ toolType: 'codex', codexTransport }),
					item
				);
				expect(eligibility).toEqual({ canSteer: false, blockedReason: 'codex-exec' });
				expect(shouldOfferSteer(eligibility)).toBe(false);
			}
		});
		it('applies the item refusals to a Codex app-server agent unchanged', () => {
			const session = steerableSession({ toolType: 'codex', codexTransport: 'app-server' });
			expect(
				getSteerEligibility(session, {
					tabId: 'tab-1',
					text: 'use this screenshot',
					images: ['maestro-image://store/abc.png'],
				}).blockedReason
			).toBe('has-images');
			expect(
				getSteerEligibility(session, { tabId: 'tab-1', text: 'x'.repeat(8193) }).blockedReason
			).toBe('too-long');
		});
		it('refuses a paused item, including one an unconfirmed steer just paused', () => {
			// Steering it again would type the text a second time.
			expect(getSteerEligibility(steerableSession(), { ...item, paused: true })).toEqual({
				canSteer: false,
				blockedReason: 'paused',
			});
		});
		it('refuses a Claude steer the TUI would read as a slash or bash command', () => {
			for (const text of ['/compact', '  /clear', '!rm -rf build']) {
				expect(
					getSteerEligibility(steerableSession(), { tabId: 'tab-1', text }).blockedReason
				).toBe('tui-command-prefix');
			}
			// Codex takes turn/steer as plain input.
			const codex = steerableSession({ toolType: 'codex', codexTransport: 'app-server' });
			expect(getSteerEligibility(codex, { tabId: 'tab-1', text: '/compact' }).canSteer).toBe(true);
		});
		it('refuses a read-only message into a turn that started with full access', () => {
			// Steering cannot narrow the permissions the running turn was spawned with.
			const fullAccessTurn = steerableSession({
				aiTabs: [
					s3_createMockAITab({
						id: 'tab-1',
						state: 'busy',
						logs: [{ id: 'u1', timestamp: 0, source: 'user', text: 'refactor it' }],
					}),
				],
			});
			expect(
				getSteerEligibility(fullAccessTurn, { ...item, readOnlyMode: true }).blockedReason
			).toBe('read-only');
			// The tab flipped to read-only after the turn started: dispatch would honor it.
			const flipped = steerableSession({
				aiTabs: [
					s3_createMockAITab({
						id: 'tab-1',
						state: 'busy',
						readOnlyMode: true,
						logs: [{ id: 'u1', timestamp: 0, source: 'user', text: 'refactor it' }],
					}),
				],
			});
			expect(getSteerEligibility(flipped, item).blockedReason).toBe('read-only');
		});
		it('allows a read-only message into a turn known to be read-only', () => {
			const readOnlyTurn = steerableSession({
				aiTabs: [
					s3_createMockAITab({
						id: 'tab-1',
						state: 'busy',
						readOnlyMode: true,
						logs: [{ id: 'u1', timestamp: 0, source: 'user', text: 'plan it', readOnly: true }],
					}),
				],
			});
			expect(getSteerEligibility(readOnlyTurn, { ...item, readOnlyMode: true }).canSteer).toBe(
				true
			);
		});
		it('refuses an item held for a reconnect', () => {
			expect(
				getSteerEligibility(steerableSession(), { ...item, waitingForConnection: true })
					.blockedReason
			).toBe('waiting-for-connection');
		});
		it('refuses an SSH Claude agent, whose TUI runs on another host', () => {
			const claude = steerableSession({
				sessionSshRemoteConfig: { enabled: true, remoteId: 'r1', workingDirOverride: undefined },
			} as Partial<Session>);
			expect(getSteerEligibility(claude, item).blockedReason).toBe('ssh-remote');
		});
		it('steers an SSH Codex agent on app-server, and names the transport for one on exec', () => {
			const remote = {
				toolType: 'codex',
				sshRemoteId: 'r1',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'r1', workingDirOverride: undefined },
			} as Partial<Session>;
			const appServer = steerableSession({ ...remote, codexTransport: 'app-server' });
			const exec = steerableSession(remote);
			expect(getSteerEligibility(appServer, item).canSteer).toBe(true);
			expect(getSteerEligibility(exec, item).blockedReason).toBe('codex-exec');
		});
		it('refuses when the agent has no tabs at all', () => {
			const session = steerableSession({ aiTabs: [], activeTabId: undefined });
			expect(getSteerEligibility(session, item).blockedReason).toBe('no-target-tab');
		});
		it('refuses an item with nothing to type', () => {
			// Steering TYPES into the composer, so an empty message has nothing to steer
			// with.
			expect(getSteerEligibility(steerableSession(), { tabId: 'tab-1', text: '   ' })).toEqual({
				canSteer: false,
				blockedReason: 'nothing-to-type',
			});
		});
		it('refuses an item carrying images rather than silently dropping them', () => {
			// Images reach a maestro-p turn as `@/path` mentions translated from a
			// stream-json envelope on stdin, and stdin is long closed once a turn is
			// running - there is no way to attach a file mid-turn. Typing the text alone
			// would discard what the user attached, so the item stays queued and sends
			// intact when the turn ends.
			expect(
				getSteerEligibility(steerableSession(), {
					tabId: 'tab-1',
					text: 'use this screenshot',
					images: ['maestro-image://store/abc.png'],
				})
			).toEqual({ canSteer: false, blockedReason: 'has-images' });
		});
		it('refuses a consult hold: its text is a placeholder until the reply lands', () => {
			expect(
				getSteerEligibility(steerableSession(), {
					tabId: 'tab-1',
					text: 'Waiting',
					awaitingConsult: {
						pending: [{ targetSessionId: 's-b', targetAgentName: 'Backend' }],
						replies: [],
					},
				})
			).toEqual({ canSteer: false, blockedReason: 'awaiting-consult' });
		});
		it('refuses an @mention whose consult has not fired yet', () => {
			// The consult fires when processQueuedItem dispatches the item. Steering
			// bypasses that, so the mentioned agent would never be asked.
			expect(
				getSteerEligibility(steerableSession(), {
					tabId: 'tab-1',
					text: 'ask @Backend about the schema',
					crossAgentMention: true,
				})
			).toEqual({ canSteer: false, blockedReason: 'cross-agent-mention' });
		});
		it('refuses an item carrying agent-only context rather than dropping it', () => {
			// agentContext holds a consult's replies and is prepended only at spawn.
			expect(
				getSteerEligibility(steerableSession(), {
					tabId: 'tab-1',
					text: 'continue',
					agentContext: 'Backend replied: use v2',
				})
			).toEqual({ canSteer: false, blockedReason: 'has-agent-context' });
		});
		it('refuses an item over the steering byte cap', () => {
			// maestro-p would refuse it; it waits and sends normally instead.
			expect(
				getSteerEligibility(steerableSession(), { tabId: 'tab-1', text: 'x'.repeat(8193) })
			).toEqual({ canSteer: false, blockedReason: 'too-long' });
		});
		it('is mutually exclusive with Force Send', () => {
			// Force Send needs the target tab IDLE, steering needs it BUSY, so a queued
			// card offers exactly one of them and never both.
			const busy = steerableSession();
			const idle = steerableSession({
				aiTabs: [s3_createMockAITab({ id: 'tab-1', state: 'idle' })],
			});
			const forceOpts = { forcedParallelEnabled: true };
			expect(getSteerEligibility(busy, item).canSteer).toBe(true);
			expect(getForceSendEligibility(busy, item, forceOpts).canForce).toBe(false);
			expect(getSteerEligibility(idle, item).canSteer).toBe(false);
			expect(getForceSendEligibility(idle, item, forceOpts).canForce).toBe(true);
		});
		it('is mutually exclusive with Force Send for a Codex app-server agent', () => {
			const codex = { toolType: 'codex', codexTransport: 'app-server' } as const;
			const busy = steerableSession(codex);
			const idle = steerableSession({
				...codex,
				aiTabs: [s3_createMockAITab({ id: 'tab-1', state: 'idle' })],
			});
			const forceOpts = { forcedParallelEnabled: true };
			expect(getSteerEligibility(busy, item).canSteer).toBe(true);
			expect(getForceSendEligibility(busy, item, forceOpts).canForce).toBe(false);
			expect(getSteerEligibility(idle, item).canSteer).toBe(false);
			expect(getForceSendEligibility(idle, item, forceOpts).canForce).toBe(true);
		});
	});
	describe('shouldOfferSteer', () => {
		it('hides the control for every blocked reason the card cannot fix', () => {
			// None of them is actionable from a queued card, so a dimmed button would just
			// be a dead control.
			for (const blockedReason of [
				'no-target-tab',
				'tab-not-working',
				'not-claude',
				'codex-exec',
				'api-token-source',
				'nothing-to-type',
				'awaiting-consult',
				'cross-agent-mention',
				'has-agent-context',
				'too-long',
				'paused',
				'waiting-for-connection',
				'ssh-remote',
				'steer-in-flight',
				'tui-command-prefix',
			] as const) {
				expect(shouldOfferSteer({ canSteer: false, blockedReason })).toBe(false);
			}
		});
		it('keeps a dimmed control for an item blocked only by its images', () => {
			// The card looks steerable, and Edit can drop the image, so the button stays
			// and its tooltip explains instead of vanishing.
			expect(shouldOfferSteer({ canSteer: false, blockedReason: 'has-images' })).toBe(true);
		});
		it('handles a missing eligibility', () => {
			expect(shouldOfferSteer(null)).toBe(false);
			expect(shouldOfferSteer(undefined)).toBe(false);
		});
	});
	describe('getSteerTitle', () => {
		it('describes the steer when it can run', () => {
			expect(getSteerTitle({ canSteer: true })).toMatch(/turn that is running now/);
		});
		it('explains the image block and names the remedy', () => {
			const title = getSteerTitle({ canSteer: false, blockedReason: 'has-images' });
			expect(title).toBe(describeSteerBlocked('has-images'));
			expect(title).toContain('Remove the image');
		});
	});
	describe('describeSteerBlocked', () => {
		it('words every blocked reason as its own sentence', () => {
			// A keyboard steer has no button to hide, so each reason has to say
			// something the user can act on rather than fall through to the generic line.
			const fallback = describeSteerBlocked(undefined);
			const reasons = [
				'no-target-tab',
				'tab-not-working',
				'not-claude',
				'codex-exec',
				'api-token-source',
				'nothing-to-type',
				'has-images',
				'awaiting-consult',
				'cross-agent-mention',
				'has-agent-context',
				'too-long',
				'paused',
				'waiting-for-connection',
				'ssh-remote',
				'steer-in-flight',
				'tui-command-prefix',
				'read-only',
			];
			const sentences = reasons.map((reason) => describeSteerBlocked(reason));
			for (const sentence of sentences) {
				expect(sentence).not.toBe(fallback);
				expect(sentence).toMatch(/^[A-Z].*\.$/);
			}
			expect(new Set(sentences).size).toBe(reasons.length);
		});
		it('names the remedy where there is one', () => {
			expect(describeSteerBlocked('codex-exec')).toContain('app server');
			expect(describeSteerBlocked('too-long')).toContain('8 KB');
		});
		it('falls back for a reason this build does not know', () => {
			// The reason crosses a process boundary as a plain string, so an unknown
			// one (or an Object.prototype key) must not leak through as the sentence.
			const fallback = describeSteerBlocked(undefined);
			expect(describeSteerBlocked('some-future-reason')).toBe(fallback);
			expect(describeSteerBlocked('toString')).toBe(fallback);
		});
	});
});
// Source: src/__tests__/renderer/utils/extensionColors.test.ts
describe('', () => {
	const darkTheme = THEMES['dracula'];
	const lightTheme = THEMES['github-light'];
	describe('getExtensionColor', () => {
		describe('known extension categories', () => {
			const cases: [string, string][] = [
				['.ts', 'typescript'],
				['.tsx', 'typescript'],
				['.js', 'typescript'],
				['.md', 'markdown'],
				['.json', 'config'],
				['.yaml', 'config'],
				['.css', 'styles'],
				['.html', 'html'],
				['.py', 'python'],
				['.rs', 'rust'],
				['.go', 'go'],
				['.sh', 'shell'],
				['.png', 'image'],
				['.jpg', 'image'],
				['.jpeg', 'image'],
				['.gif', 'image'],
				['.webp', 'image'],
				['.java', 'java'],
				['.kt', 'java'],
				['.c', 'cpp'],
				['.cpp', 'cpp'],
				['.h', 'cpp'],
				['.rb', 'ruby'],
				['.sql', 'data'],
				['.csv', 'data'],
				['.pdf', 'document'],
				['.docx', 'document'],
			];
			it.each(cases)('%s returns a colored badge (not theme border/dim)', (ext) => {
				const result = getExtensionColor(ext, darkTheme);
				expect(result.bg).not.toBe(darkTheme.colors.border);
				expect(result.text).not.toBe(darkTheme.colors.textDim);
				expect(result.bg).toContain('rgba');
				expect(result.text).toContain('rgba');
			});
		});
		describe('image extensions are visible (original bug)', () => {
			const imageExts = [
				'.png',
				'.jpg',
				'.jpeg',
				'.gif',
				'.webp',
				'.bmp',
				'.ico',
				'.tiff',
				'.avif',
			];
			it.each(imageExts)('%s returns a non-default color', (ext) => {
				const dark = getExtensionColor(ext, darkTheme);
				const light = getExtensionColor(ext, lightTheme);
				// Must not be theme border (the old invisible default)
				expect(dark.bg).not.toBe(darkTheme.colors.border);
				expect(light.bg).not.toBe(lightTheme.colors.border);
			});
		});
		describe('unknown extensions use theme accent (never invisible)', () => {
			it('derives color from theme accent for unknown extension', () => {
				const result = getExtensionColor('.xyz', darkTheme);
				// Should contain rgba (derived from hex accent)
				expect(result.bg).toContain('rgba');
				expect(result.text).toContain('rgba');
				// Should NOT be theme border
				expect(result.bg).not.toBe(darkTheme.colors.border);
				expect(result.text).not.toBe(darkTheme.colors.textDim);
			});
			it('different themes produce different accent-derived defaults', () => {
				const dracula = getExtensionColor('.xyz', THEMES['dracula']);
				const nord = getExtensionColor('.xyz', THEMES['nord']);
				// Different theme accents should produce different colors
				expect(dracula.bg).not.toBe(nord.bg);
			});
		});
		describe('light vs dark theme adaptation', () => {
			it('returns different opacity for light and dark themes', () => {
				const dark = getExtensionColor('.ts', darkTheme);
				const light = getExtensionColor('.ts', lightTheme);
				expect(dark.bg).not.toBe(light.bg);
				expect(dark.text).not.toBe(light.text);
			});
		});
		describe('case insensitivity', () => {
			it('handles uppercase extensions', () => {
				const lower = getExtensionColor('.png', darkTheme);
				const upper = getExtensionColor('.PNG', darkTheme);
				expect(upper).toEqual(lower);
			});
			it('handles mixed case', () => {
				const lower = getExtensionColor('.json', darkTheme);
				const mixed = getExtensionColor('.Json', darkTheme);
				expect(mixed).toEqual(lower);
			});
		});
		describe('colorblind mode', () => {
			it('returns colorblind-specific colors for known extensions', () => {
				const normal = getExtensionColor('.ts', darkTheme, false);
				const cb = getExtensionColor('.ts', darkTheme, true);
				// Colorblind palette uses different rgba values
				expect(cb.bg).not.toBe(normal.bg);
			});
			it('returns visible fallback for unknown extensions in colorblind mode', () => {
				const result = getExtensionColor('.xyz', darkTheme, true);
				expect(result.bg).toContain('rgba');
				expect(result.bg).not.toBe(darkTheme.colors.border);
			});
		});
		describe('return value shape', () => {
			it('always returns { bg, text } strings', () => {
				const exts = ['.ts', '.png', '.xyz', '.java', '.sql', '.pdf'];
				for (const ext of exts) {
					const result = getExtensionColor(ext, darkTheme);
					expect(typeof result.bg).toBe('string');
					expect(typeof result.text).toBe('string');
					expect(result.bg.length).toBeGreaterThan(0);
					expect(result.text.length).toBeGreaterThan(0);
				}
			});
		});
	});
});
// Source: src/__tests__/renderer/utils/fixedPitchFont.test.ts
describe('', () => {
	/** Advances in font units, keyed by the first family in the stack. */
	const REAL_FONT_METRICS: Record<
		string,
		{
			unitsPerEm: number;
			advances: Record<string, number>;
		}
	> = {
		'avenir next': { unitsPerEm: 1000, advances: { W: 1025, i: 296, l: 298, m: 924 } },
		menlo: { unitsPerEm: 2048, advances: { W: 1233, i: 1233, l: 1233, m: 1233 } },
	};
	/**
	 * A measurer backed by those real metrics. Resolves the first family in the
	 * stack it knows about, mimicking how the browser walks a font stack; an
	 * unknown stack falls through to a proportional system default, which is what
	 * actually happens when nothing resolves.
	 */
	function measureWith(knownFamilies = REAL_FONT_METRICS): MeasureAdvance {
		return (cssFont, char) => {
			const stack = cssFont.replace(/^\d+px\s+/, '');
			const size = Number(cssFont.match(/^(\d+)px/)?.[1] ?? 13);
			for (const family of stack
				.split(',')
				.map((f) => f.trim().replace(/["']/g, '').toLowerCase())) {
				const metrics = knownFamilies[family];
				if (metrics) {
					return (size * (metrics.advances[char] ?? metrics.advances.W)) / metrics.unitsPerEm;
				}
				// The generic always resolves, and always to a fixed-pitch face.
				if (family === 'monospace' || family === 'ui-monospace') return size * 0.6;
			}
			// Nothing resolved: the context default, which is proportional.
			return char === 'W' ? size * 0.9 : size * 0.28;
		};
	}
	const measure = measureWith();
	describe('withMonoFallback, as the terminal uses it', () => {
		// Documents WHY appending a fallback was not enough on its own: the broken
		// font resolved fine, so the appended chain was never reached. The helper's
		// own behaviour is covered by src/__tests__/shared/fontStack.test.ts.
		it('cannot rescue a proportional font that resolves', () => {
			const patched = withMonoFallback('Avenir Next');
			expect(patched).toBe(`Avenir Next, ${MONO_FALLBACK_STACK}`);
			expect(isFixedPitchStack(patched, 13, measure)).toBe(false);
		});
	});
	describe('isFixedPitchStack', () => {
		it('detects the real Avenir Next metrics as proportional', () => {
			expect(isFixedPitchStack('Avenir Next', 13, measure)).toBe(false);
		});
		it('detects the real Menlo metrics as fixed pitch', () => {
			expect(isFixedPitchStack('Menlo', 13, measure)).toBe(true);
		});
		it('treats an unresolvable stack as proportional, since the default is', () => {
			expect(isFixedPitchStack('No Such Font', 13, measure)).toBe(false);
		});
		// Subpixel metrics and hinting can leave a fractional difference in a face
		// that is genuinely fixed-pitch; that must not trigger an override.
		it('tolerates sub-pixel jitter in a genuinely fixed-pitch face', () => {
			const jittery: MeasureAdvance = (_f, char) => (char === 'W' ? 7.8301 : 7.8299);
			expect(isFixedPitchStack('Menlo', 13, jittery)).toBe(true);
		});
		it('does not second-guess the font when measurement is unusable', () => {
			expect(isFixedPitchStack('Menlo', 13, () => 0)).toBe(true);
			expect(isFixedPitchStack('Menlo', 13, () => Number.NaN)).toBe(true);
			expect(
				isFixedPitchStack('Menlo', 13, () => {
					throw new Error('canvas gone');
				})
			).toBe(true);
		});
	});
	describe('resolveTerminalFontFamily', () => {
		// The exact reported bug: fontFamily was "Avenir Next", shared with the app
		// chrome, and every terminal rendered on a broken grid.
		it('overrides the configured proportional font with a fixed-pitch stack', () => {
			expect(resolveTerminalFontFamily('Avenir Next', 13, measure)).toBe(MONO_FALLBACK_STACK);
		});
		it('produces a stack that is itself fixed pitch', () => {
			const resolved = resolveTerminalFontFamily('Avenir Next', 13, measure);
			expect(isFixedPitchStack(resolved, 13, measure)).toBe(true);
		});
		it('leaves a monospace choice alone rather than forcing its own', () => {
			expect(resolveTerminalFontFamily('Menlo', 13, measure)).toBe(`Menlo, ${MONO_FALLBACK_STACK}`);
		});
		// A missing font is already handled by the appended generic - the browser
		// reaches it and lands on a fixed-pitch face - so no override is needed. The
		// two mechanisms cover different failures and compose.
		it('lets the appended generic rescue a stack whose fonts are all missing', () => {
			const resolved = resolveTerminalFontFamily('No Such Font', 13, measure);
			expect(resolved).toBe(`No Such Font, ${MONO_FALLBACK_STACK}`);
			expect(isFixedPitchStack(resolved, 13, measure)).toBe(true);
		});
		// Without a canvas (jsdom, a locked-down renderer) there is no evidence, so
		// the user's configured font is kept rather than silently replaced.
		it('keeps the configured stack when it cannot measure', () => {
			expect(resolveTerminalFontFamily('Avenir Next', 13, null)).toBe(
				`Avenir Next, ${MONO_FALLBACK_STACK}`
			);
		});
	});
	/**
	 * The DOM surfaces call the no-canvas-of-their-own wrapper. Under jsdom there
	 * is no 2d context, so it takes the same evidence-free path a locked-down
	 * renderer would: keep the configured stack, guaranteed by an appended generic.
	 * The measured override itself is covered above, where a measurer exists.
	 */
	describe('resolveFixedPitchFontFamily', () => {
		it('guarantees a fixed-pitch tail even where it cannot measure', () => {
			expect(resolveFixedPitchFontFamily('Avenir Next')).toMatch(/monospace$/);
		});
		it('does not append a second generic to a stack that already ends in one', () => {
			expect(resolveFixedPitchFontFamily('Menlo, monospace')).toBe('Menlo, monospace');
		});
	});
});
// Source: src/__tests__/renderer/utils/gitLogSearch.test.ts
describe('', () => {
	const commit = {
		hash: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
		shortHash: 'a1b2c3d',
		subject: 'fix(usage): keep a capped plan account on the dashboard',
		author: 'Pedram Amini',
		date: '2026-09-17T02:52:13-05:00',
		refs: ['HEAD -> rc', 'origin/rc'],
	};
	describe('gitLogSearchTerms', () => {
		it('returns no terms for a blank or whitespace-only query', () => {
			expect(gitLogSearchTerms('')).toEqual([]);
			expect(gitLogSearchTerms('   \t ')).toEqual([]);
		});
		it('splits on whitespace and lowercases', () => {
			expect(gitLogSearchTerms('  Fix   Usage ')).toEqual(['fix', 'usage']);
		});
	});
	describe('matchesGitLogTerms', () => {
		it('matches everything when there is no query', () => {
			expect(matchesGitLogTerms(commit, [])).toBe(true);
		});
		it('matches a short-hash prefix, which is what a user types from memory', () => {
			expect(matchesGitLogTerms(commit, gitLogSearchTerms('a1b2'))).toBe(true);
			expect(matchesGitLogTerms(commit, gitLogSearchTerms('A1B2C3D'))).toBe(true);
		});
		it('matches a full-hash tail that the short hash alone does not contain', () => {
			expect(matchesGitLogTerms(commit, gitLogSearchTerms('12345678'))).toBe(true);
		});
		it('matches the subject, the author, a ref and the date', () => {
			expect(matchesGitLogTerms(commit, gitLogSearchTerms('dashboard'))).toBe(true);
			expect(matchesGitLogTerms(commit, gitLogSearchTerms('pedram'))).toBe(true);
			expect(matchesGitLogTerms(commit, gitLogSearchTerms('origin/rc'))).toBe(true);
			expect(matchesGitLogTerms(commit, gitLogSearchTerms('2026-09'))).toBe(true);
		});
		// The reason terms are ANDed rather than matched as one literal: the words a
		// user remembers are rarely adjacent in the subject line they came from.
		it('ANDs the terms, so separated words still find the commit', () => {
			expect(matchesGitLogTerms(commit, gitLogSearchTerms('fix usage'))).toBe(true);
			expect(matchesGitLogTerms(commit, gitLogSearchTerms('fix nothing'))).toBe(false);
		});
		it('does not match a term straddling two fields', () => {
			// 'rc' ends the last ref and 'Pedram' starts the author; concatenating the
			// haystack would invent 'rcpedram' as a hit.
			expect(matchesGitLogTerms(commit, ['a1b2c3dfix'])).toBe(false);
		});
		it('tolerates a commit with no short hash, refs or date', () => {
			expect(
				matchesGitLogTerms(
					{ hash: 'deadbeef', subject: 'x', author: 'y' },
					gitLogSearchTerms('dead')
				)
			).toBe(true);
		});
	});
});
// Source: src/__tests__/renderer/utils/grokWizard.test.ts
describe('', () => {
	describe('grokWizard helpers', () => {
		describe('GROK_WIZARD_DISCOVERY_ARGS', () => {
			it('caps turns, auto-approves, and bans subagents without plan mode', () => {
				expect(GROK_WIZARD_DISCOVERY_ARGS).toEqual([
					'--always-approve',
					'--max-turns',
					'8',
					'--no-subagents',
				]);
				expect(GROK_WIZARD_DISCOVERY_ARGS).not.toContain('--permission-mode');
				expect(GROK_WIZARD_DISCOVERY_ARGS).not.toContain('plan');
			});
		});
		describe('getGrokTextDelta', () => {
			it('returns text data only', () => {
				expect(getGrokTextDelta({ type: 'text', data: 'hello' })).toBe('hello');
				expect(getGrokTextDelta({ type: 'thought', data: 'thinking' })).toBeNull();
				expect(getGrokTextDelta({ type: 'text', data: '' })).toBeNull();
				expect(getGrokTextDelta({ type: 'text', data: 42 })).toBeNull();
				expect(getGrokTextDelta(null)).toBeNull();
			});
		});
		describe('extractGrokTextFromJsonl', () => {
			it('joins text deltas and skips thought', () => {
				const lines = [
					'{"type":"thought","data":"planning"}',
					'{"type":"text","data":"{\\"ready\\":"}',
					'{"type":"text","data":"true}"}',
					'{"type":"end","sessionId":"abc"}',
					'not-json',
					'',
				];
				expect(extractGrokTextFromJsonl(lines)).toBe('{"ready":true}');
			});
			it('returns null when no text deltas are present', () => {
				expect(extractGrokTextFromJsonl(['{"type":"thought","data":"x"}'])).toBeNull();
				expect(extractGrokTextFromJsonl([])).toBeNull();
			});
		});
	});
});
