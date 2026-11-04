// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/utils/messageScrollNavigation.test.ts
// Source: src/__tests__/renderer/utils/modalSizing.test.ts
// Source: src/__tests__/renderer/utils/modelFamily.test.ts
// Source: src/__tests__/renderer/utils/outputSearch.test.ts
// Source: src/__tests__/renderer/utils/pagination.test.ts
// Source: src/__tests__/renderer/utils/providerAvailability.test.ts
// Source: src/__tests__/renderer/utils/providerTabSessions.test.ts
// Source: src/__tests__/renderer/utils/sessionAttention.test.ts
// Source: src/__tests__/renderer/utils/sessionVisibility.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
	jumpToMessageEdge,
	scrollMessageToTop,
	isTextInputTarget,
	isTextEntryTarget,
} from '../../../renderer/utils/messageScrollNavigation';
import {
	clampModalPosition,
	clampModalSize,
	defaultModalFloatPosition,
	DEFAULT_MODAL_SIZE,
	getModalMaxSize,
	MODAL_FLOAT_VISIBLE_MARGIN_X,
	MODAL_FLOAT_VISIBLE_MARGIN_Y,
	MODAL_VIEWPORT_PADDING,
	normalizeModalPosition,
	normalizeModalSize,
	resolveModalSize,
	sanitizeModalSizes,
	viewportModalSize,
} from '../../../renderer/utils/modalSizing';
import { getModelFamily, groupModelsByFamily } from '../../../renderer/utils/modelFamily';
import {
	outputSearchKeyFor,
	groupChatOutputSearchKey,
	groupChatSearchContentRevision,
	getActiveOutputSearchKey,
} from '../../../renderer/utils/outputSearch';
import { useGroupChatStore } from '../../../renderer/stores/groupChatStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import {
	clampPage,
	getPageRange,
	getPageSlice,
	getTotalPages,
} from '../../../renderer/utils/pagination';
import {
	filterToAvailableProviders,
	providerLocationLabel,
} from '../../../renderer/utils/providerAvailability';
import {
	switchAgentProvider,
	switchTabProvider,
	resolveTurnProvider,
	updateProviderSlot,
	codifyTurnSettings,
	captureQueuedTurnSettings,
	codifyQueuedTurnSettings,
} from '../../../renderer/utils/providerTabSessions';
import * as providerSwap from '../../../shared/maestro-lib/agents/providerSwap';
import type { AITab, Session } from '../../../renderer/types';
import type { ToolType } from '../../../shared/types';
import {
	sessionNeedsAttention,
	sessionOrChildrenNeedAttention,
	outageIdsFromSignature,
	type AttentionContext,
} from '../../../renderer/utils/sessionAttention';
import { createMockSession, createMockAITab } from '../../helpers';
import {
	filterSessionsVisibleInSidebar,
	isSessionVisibleInSidebar,
	type VisibilityScopableSession,
} from '../../../renderer/utils/sessionVisibility';
// Source: src/__tests__/renderer/utils/messageScrollNavigation.test.ts
describe('', () => {
	/**
	 * Build a scroll container with N message children. Each message is given a
	 * stubbed `getBoundingClientRect` so position math is deterministic in jsdom
	 * (which otherwise reports all zeros).
	 *
	 * Layout: container top sits at viewport y=0; messages are stacked starting at
	 * `firstTop`, each `height` tall, separated by `gap` pixels.
	 */
	function buildContainer(opts: {
		count: number;
		containerTop?: number;
		firstTop: number;
		height?: number;
		gap?: number;
		selector?: string;
	}): {
		container: HTMLElement;
		messages: HTMLElement[];
	} {
		const containerTop = opts.containerTop ?? 0;
		const height = opts.height ?? 100;
		const gap = opts.gap ?? 0;
		const sel = opts.selector ?? 'data-log-index';
		const container = document.createElement('div');
		container.scrollTop = 0;
		container.getBoundingClientRect = () =>
			({
				top: containerTop,
				bottom: containerTop + 500,
				left: 0,
				right: 500,
				width: 500,
				height: 500,
				x: 0,
				y: containerTop,
			}) as DOMRect;
		const messages: HTMLElement[] = [];
		for (let i = 0; i < opts.count; i++) {
			const el = document.createElement('div');
			el.setAttribute(sel, String(i));
			const top = opts.firstTop + i * (height + gap);
			el.getBoundingClientRect = () =>
				({
					top,
					bottom: top + height,
					left: 0,
					right: 500,
					width: 500,
					height,
					x: 0,
					y: top,
				}) as DOMRect;
			container.appendChild(el);
			messages.push(el);
		}
		return { container, messages };
	}
	describe('jumpToMessageEdge', () => {
		it('returns false when no messages match the selector', () => {
			const { container } = buildContainer({ count: 0, firstTop: 0 });
			expect(jumpToMessageEdge(container, '[data-log-index]', 'up')).toBe(false);
			expect(jumpToMessageEdge(container, '[data-log-index]', 'down')).toBe(false);
		});
		it('returns false when going down past the last visible message', () => {
			// Both messages already above container top - nothing below to jump to.
			const { container } = buildContainer({ count: 2, firstTop: -200 });
			expect(jumpToMessageEdge(container, '[data-log-index]', 'down')).toBe(false);
		});
		it('returns false when going up and no message is above the container top', () => {
			// All messages at or below container top - nothing above to jump to.
			const { container } = buildContainer({ count: 2, firstTop: 50 });
			expect(jumpToMessageEdge(container, '[data-log-index]', 'up')).toBe(false);
		});
		it('on Down, jumps to the next message whose top sits below the container top', () => {
			// Messages at y=10, y=110, y=210. Container at y=0.
			// First message (y=10) is below container top by 10px → it becomes target.
			const { container } = buildContainer({ count: 3, firstTop: 10 });
			const result = jumpToMessageEdge(container, '[data-log-index]', 'down');
			expect(result).toBe(true);
			// Aligning the first message to container top: scrollTop += 10 - 0 = 10
			expect(container.scrollTop).toBe(10);
		});
		it('on Up, jumps to the most recent message whose top is above the container top', () => {
			// Messages at y=-150, y=-50, y=50. Two are above the container top; target
			// should be the closest one above (y=-50, the second message).
			const { container } = buildContainer({ count: 3, firstTop: -150 });
			const result = jumpToMessageEdge(container, '[data-log-index]', 'up');
			expect(result).toBe(true);
			// Aligning the closest-above message: scrollTop += -50 - 0 = -50
			expect(container.scrollTop).toBe(-50);
		});
		it('ignores messages within the small edge tolerance band (treats them as "current")', () => {
			// First message sits 2px below container top - within EDGE_TOLERANCE_PX (4).
			// Down navigation should skip it and pick the next one at y=102.
			const { container } = buildContainer({ count: 2, firstTop: 2 });
			const result = jumpToMessageEdge(container, '[data-log-index]', 'down');
			expect(result).toBe(true);
			expect(container.scrollTop).toBe(102);
		});
		it('uses the supplied selector (e.g. data-message-timestamp for group chat)', () => {
			const { container } = buildContainer({
				count: 2,
				firstTop: 10,
				selector: 'data-message-timestamp',
			});
			expect(jumpToMessageEdge(container, '[data-message-timestamp]', 'down')).toBe(true);
			expect(jumpToMessageEdge(container, '[data-log-index]', 'down')).toBe(false);
		});
	});
	describe('scrollMessageToTop', () => {
		it('aligns the message top with the container top by adjusting scrollTop', () => {
			const { container, messages } = buildContainer({ count: 2, firstTop: 250 });
			container.scrollTop = 100;
			scrollMessageToTop(container, messages[0]);
			// scrollTop += messageTop(250) - containerTop(0) = 100 + 250 = 350
			expect(container.scrollTop).toBe(350);
		});
		it('moves scrollTop up when the target is above the container top', () => {
			const { container, messages } = buildContainer({ count: 2, firstTop: -80 });
			container.scrollTop = 500;
			scrollMessageToTop(container, messages[0]);
			// scrollTop += -80 - 0 = 420
			expect(container.scrollTop).toBe(420);
		});
	});
	describe('isTextInputTarget', () => {
		let input: HTMLInputElement;
		let textarea: HTMLTextAreaElement;
		let plain: HTMLDivElement;
		beforeEach(() => {
			input = document.createElement('input');
			textarea = document.createElement('textarea');
			plain = document.createElement('div');
		});
		it('returns true for <input>', () => {
			expect(isTextInputTarget(input)).toBe(true);
		});
		it('returns true for <textarea>', () => {
			expect(isTextInputTarget(textarea)).toBe(true);
		});
		it('returns true for contenteditable elements', () => {
			// jsdom does not implement the isContentEditable getter, so stub it.
			const editable = document.createElement('div');
			Object.defineProperty(editable, 'isContentEditable', { value: true });
			expect(isTextInputTarget(editable)).toBe(true);
		});
		it('returns false for plain elements', () => {
			expect(isTextInputTarget(plain)).toBe(false);
		});
		it('returns false for null or non-HTMLElement targets', () => {
			expect(isTextInputTarget(null)).toBe(false);
			expect(isTextInputTarget({} as EventTarget)).toBe(false);
		});
	});
	describe('isTextEntryTarget', () => {
		const input = (type?: string) => {
			const el = document.createElement('input');
			if (type) el.type = type;
			return el;
		};
		it('returns true for text-accepting inputs', () => {
			for (const type of ['text', 'search', 'url', 'email', 'password', 'number', 'tel']) {
				expect(isTextEntryTarget(input(type))).toBe(true);
			}
		});
		it('treats a typeless <input> as text', () => {
			expect(isTextEntryTarget(input())).toBe(true);
		});
		it('returns true for <textarea> and contenteditable', () => {
			expect(isTextEntryTarget(document.createElement('textarea'))).toBe(true);
			const editable = document.createElement('div');
			Object.defineProperty(editable, 'isContentEditable', { value: true });
			expect(isTextEntryTarget(editable)).toBe(true);
		});
		it('returns false for inputs that never take typed text', () => {
			for (const type of ['range', 'color', 'checkbox', 'radio', 'button', 'file']) {
				expect(isTextEntryTarget(input(type))).toBe(false);
			}
		});
		it('returns false for plain, null, and non-HTMLElement targets', () => {
			expect(isTextEntryTarget(document.createElement('div'))).toBe(false);
			expect(isTextEntryTarget(null)).toBe(false);
			expect(isTextEntryTarget({} as EventTarget)).toBe(false);
		});
	});
});
// Source: src/__tests__/renderer/utils/modalSizing.test.ts
describe('', () => {
	describe('modalSizing', () => {
		it('normalizes finite positive width and height values', () => {
			expect(normalizeModalSize({ width: 420.4, height: 320.6 })).toEqual({
				width: 420,
				height: 321,
			});
		});
		it('rejects invalid persisted modal sizes', () => {
			expect(normalizeModalSize(null)).toBeNull();
			expect(normalizeModalSize({ width: 400, height: 0 })).toBeNull();
			expect(normalizeModalSize({ width: Number.POSITIVE_INFINITY, height: 400 })).toBeNull();
			expect(normalizeModalSize({ width: '400', height: 300 })).toBeNull();
		});
		it('rejects fractional dimensions that round down to zero', () => {
			expect(normalizeModalSize({ width: 0.1, height: 0.1 })).toBeNull();
			expect(normalizeModalSize({ width: 0.4, height: 400 })).toBeNull();
		});
		it('sanitizes a persisted modal size map', () => {
			expect(
				sanitizeModalSizes({
					settings: { width: 900, height: 700 },
					bad: { width: -1, height: 300 },
					alsoBad: null,
				})
			).toEqual({
				settings: { width: 900, height: 700 },
			});
		});
		it('resolves max size from the 90vw and 90vh ceiling with padding', () => {
			expect(getModalMaxSize({ viewport: { width: 1000, height: 800 } })).toEqual({
				width: 900,
				height: 720,
			});
			expect(
				getModalMaxSize({
					viewport: { width: 500, height: 400 },
					viewportPadding: 40,
				})
			).toEqual({
				width: 420,
				height: 320,
			});
		});
		it('clamps size between defaults and viewport max', () => {
			expect(
				clampModalSize({ width: 1200, height: 900 }, { viewport: { width: 1000, height: 800 } })
			).toEqual({
				width: 900,
				height: 720,
			});
			expect(
				clampModalSize({ width: 10, height: 12 }, { viewport: { width: 1000, height: 800 } })
			).toEqual({
				width: 320,
				height: 240,
			});
		});
		it('honors explicit min and max bounds before viewport clamping', () => {
			expect(
				clampModalSize(
					{ width: 700, height: 700 },
					{
						minSize: { width: 420, height: 300 },
						maxSize: { width: 640, height: 520 },
						viewport: { width: 1200, height: 900 },
					}
				)
			).toEqual({
				width: 640,
				height: 520,
			});
		});
		it('reduces minimum size when the viewport is smaller than the default minimum', () => {
			expect(
				clampModalSize(
					{ width: 100, height: 80 },
					{
						viewport: { width: 200, height: 160 },
					}
				)
			).toEqual({
				width: 136,
				height: 96,
			});
		});
		it('ignores non-finite developer-supplied maxSize bounds instead of propagating NaN', () => {
			expect(
				getModalMaxSize({
					maxSize: { width: NaN, height: -1 },
					viewport: { width: 1000, height: 800 },
				})
			).toEqual({
				width: 900,
				height: 720,
			});
		});
		it('ignores non-finite developer-supplied minSize bounds instead of propagating NaN', () => {
			expect(
				clampModalSize(
					{ width: 500, height: 400 },
					{
						minSize: { width: NaN, height: 0 },
						viewport: { width: 1000, height: 800 },
					}
				)
			).toEqual({
				width: 500,
				height: 400,
			});
		});
		it('ignores non-finite developer-supplied defaultSize bounds instead of propagating NaN', () => {
			expect(
				resolveModalSize({
					defaultSize: { width: NaN, height: Number.POSITIVE_INFINITY },
					viewport: { width: 1000, height: 800 },
				})
			).toEqual(DEFAULT_MODAL_SIZE);
		});
		it('prefers a valid saved size and falls back to defaults for invalid data', () => {
			expect(
				resolveModalSize({
					savedSize: { width: 520, height: 340 },
					defaultSize: { width: 800, height: 600 },
					viewport: { width: 1000, height: 800 },
				})
			).toEqual({
				width: 520,
				height: 340,
			});
			expect(
				resolveModalSize({
					savedSize: { width: NaN, height: 340 },
					defaultSize: { width: 800, height: 600 },
					viewport: { width: 1000, height: 800 },
				})
			).toEqual({
				width: 800,
				height: 600,
			});
		});
		it('scales a default size to a fraction of the viewport', () => {
			expect(viewportModalSize({ width: 0.5, height: 0.25 }, { width: 1000, height: 800 })).toEqual(
				{
					width: 500,
					height: 200,
				}
			);
		});
		it('treats a missing or invalid viewport ratio as the full viewport', () => {
			expect(viewportModalSize({}, { width: 1000, height: 800 })).toEqual({
				width: 1000,
				height: 800,
			});
			expect(viewportModalSize({ width: NaN, height: 0 }, { width: 1000, height: 800 })).toEqual({
				width: 1000,
				height: 800,
			});
		});
		it('still caps a viewport-proportional default at the shared max ratio', () => {
			// A 0.95 ratio asks for more than a modal may take; the clamp wins.
			expect(
				resolveModalSize({
					defaultSize: viewportModalSize(
						{ width: 0.95, height: 0.95 },
						{ width: 1000, height: 800 }
					),
					viewport: { width: 1000, height: 800 },
				})
			).toEqual({ width: 900, height: 720 });
		});
	});
	describe('floating position helpers', () => {
		it('rejects non-finite or malformed positions', () => {
			expect(normalizeModalPosition(null)).toBeNull();
			expect(normalizeModalPosition({ x: 10 })).toBeNull();
			expect(normalizeModalPosition({ x: NaN, y: 10 })).toBeNull();
			expect(normalizeModalPosition({ x: 10.6, y: -4.2 })).toEqual({ x: 11, y: -4 });
		});
		it('clamps a position on both ends so the title bar stays grabbable', () => {
			const viewport = { width: 1000, height: 800 };
			expect(clampModalPosition({ x: -50, y: -50 }, viewport)).toEqual({ x: 0, y: 0 });
			// Far edge: leave MODAL_FLOAT_VISIBLE_MARGIN_X/Y of the window on screen.
			expect(clampModalPosition({ x: 5000, y: 5000 }, viewport)).toEqual({
				x: 1000 - MODAL_FLOAT_VISIBLE_MARGIN_X,
				y: 800 - MODAL_FLOAT_VISIBLE_MARGIN_Y,
			});
			expect(clampModalPosition({ x: 200, y: 150 }, viewport)).toEqual({ x: 200, y: 150 });
		});
		it('parks a first pop-out against the right edge, on screen even when tiny', () => {
			expect(
				defaultModalFloatPosition({ width: 600, height: 400 }, { width: 1600, height: 900 })
			).toEqual({ x: 1600 - 600 - MODAL_VIEWPORT_PADDING, y: MODAL_VIEWPORT_PADDING * 2 });
			// A window wider than the display would otherwise be placed off the left
			// edge; the padding floor plus the clamp keep it reachable.
			const tight = defaultModalFloatPosition(
				{ width: 1200, height: 800 },
				{ width: 700, height: 500 }
			);
			expect(tight.x).toBeGreaterThanOrEqual(0);
			expect(tight.x).toBeLessThanOrEqual(700 - MODAL_FLOAT_VISIBLE_MARGIN_X);
		});
	});
});
// Source: src/__tests__/renderer/utils/modelFamily.test.ts
describe('', () => {
	describe('getModelFamily', () => {
		it('maps vendor prefixes to family labels', () => {
			expect(getModelFamily('claude-sonnet-4.5')).toBe('Claude');
			expect(getModelFamily('gpt-5')).toBe('OpenAI');
			expect(getModelFamily('o3-mini')).toBe('OpenAI');
			expect(getModelFamily('gemini-2.5-pro')).toBe('Gemini');
			expect(getModelFamily('grok-4.5')).toBe('Grok');
		});
		it('reads the vendor from the last segment of a provider-qualified id', () => {
			expect(getModelFamily('github-copilot/claude-sonnet-4.5')).toBe('Claude');
			expect(getModelFamily('openrouter/google/gemini-2.5-flash')).toBe('Gemini');
		});
		it("recognizes Claude Code's bare aliases as Claude", () => {
			// Claude Code lists 'opus' and 'sonnet[1m]' alongside dated ids. They are
			// Anthropic models however they are spelled, and the Model & Effort console
			// names the vendor of whichever row the wheel is on - so a miss here reads
			// as an unlabelled caption sitting over a Claude model.
			expect(getModelFamily('opus')).toBe('Claude');
			expect(getModelFamily('sonnet')).toBe('Claude');
			expect(getModelFamily('haiku')).toBe('Claude');
			expect(getModelFamily('fable')).toBe('Claude');
			expect(getModelFamily('opus[1m]')).toBe('Claude');
		});
		it('does not claim ids that merely begin with those letters', () => {
			expect(getModelFamily('opusgpt')).toBe('Other');
			expect(getModelFamily('sonnetron-9')).toBe('Other');
		});
		it('falls back to Other rather than dropping an unknown id', () => {
			expect(getModelFamily('some-unreleased-thing')).toBe('Other');
		});
	});
	describe('groupModelsByFamily', () => {
		it('returns one unlabelled group when every model shares a family', () => {
			const groups = groupModelsByFamily(['claude-opus-4', 'claude-sonnet-4.5']);
			expect(groups).toEqual([{ family: null, models: ['claude-opus-4', 'claude-sonnet-4.5'] }]);
		});
		it('groups a mixed catalog by vendor with Other last', () => {
			const groups = groupModelsByFamily([
				'gpt-5',
				'mystery-model',
				'claude-sonnet-4.5',
				'gemini-2.5-pro',
				'gpt-5-mini',
			]);
			expect(groups.map((g) => g.family)).toEqual(['Claude', 'OpenAI', 'Gemini', 'Other']);
			expect(groups.find((g) => g.family === 'OpenAI')?.models).toEqual(['gpt-5', 'gpt-5-mini']);
			expect(groups.find((g) => g.family === 'Other')?.models).toEqual(['mystery-model']);
		});
		it('preserves the incoming order inside each group', () => {
			const groups = groupModelsByFamily(['claude-b', 'gpt-5', 'claude-a']);
			expect(groups.find((g) => g.family === 'Claude')?.models).toEqual(['claude-b', 'claude-a']);
		});
	});
});
// Source: src/__tests__/renderer/utils/outputSearch.test.ts
describe('', () => {
	describe('outputSearch keys', () => {
		beforeEach(() => {
			useGroupChatStore.setState({ activeGroupChatId: null });
			useSessionStore.setState({ sessions: [], activeSessionId: '' });
		});
		it('builds a stable agent+tab key', () => {
			expect(outputSearchKeyFor('sess-1', 'tab-a')).toBe('sess-1::tab-a');
			expect(outputSearchKeyFor('sess-1', null)).toBe('sess-1::');
		});
		it('builds a group-chat key that cannot collide with agent+tab keys', () => {
			expect(groupChatOutputSearchKey('gc-1')).toBe('group-chat::gc-1');
			expect(groupChatOutputSearchKey('gc-1')).not.toBe(outputSearchKeyFor('gc-1', null));
		});
		it('prefers the active group chat over the active agent for getActiveOutputSearchKey', () => {
			useSessionStore.setState({
				sessions: [
					{
						id: 'sess-1',
						activeTabId: 'tab-a',
					} as any,
				],
				activeSessionId: 'sess-1',
			});
			useGroupChatStore.setState({ activeGroupChatId: 'gc-99' });
			expect(getActiveOutputSearchKey()).toBe('group-chat::gc-99');
		});
		it('falls back to the active agent+tab when no group chat is open', () => {
			useSessionStore.setState({
				sessions: [
					{
						id: 'sess-1',
						activeTabId: 'tab-a',
					} as any,
				],
				activeSessionId: 'sess-1',
			});
			expect(getActiveOutputSearchKey()).toBe('sess-1::tab-a');
		});
	});
	describe('groupChatSearchContentRevision', () => {
		const query = 'alpha';
		it('changes when an existing message text grows (streaming) even if count stays 1', () => {
			const before = groupChatSearchContentRevision([{ content: 'hel' }], query, true);
			const after = groupChatSearchContentRevision([{ content: 'hello world' }], query, true);
			expect(before).not.toBe(after);
		});
		it('stays stable when neither text length, query, nor open flag changes', () => {
			const a = groupChatSearchContentRevision([{ content: 'hello' }], query, true);
			const b = groupChatSearchContentRevision([{ content: 'hello' }], query, true);
			expect(a).toBe(b);
		});
		it('still changes when a new message arrives', () => {
			const before = groupChatSearchContentRevision([{ content: 'hello' }], query, true);
			const after = groupChatSearchContentRevision(
				[{ content: 'hello' }, { content: 'alpha' }],
				query,
				true
			);
			expect(before).not.toBe(after);
		});
	});
});
// Source: src/__tests__/renderer/utils/pagination.test.ts
describe('', () => {
	describe('getTotalPages', () => {
		it('divides and rounds up', () => {
			expect(getTotalPages(64, 32)).toBe(2);
			expect(getTotalPages(65, 32)).toBe(3);
			expect(getTotalPages(1, 32)).toBe(1);
		});
		it('never reports zero pages, so "Page 1 of 0" is unrenderable', () => {
			expect(getTotalPages(0, 32)).toBe(1);
			expect(getTotalPages(-5, 32)).toBe(1);
		});
		it('treats a non-positive page size as unpaginated', () => {
			expect(getTotalPages(100, 0)).toBe(1);
			expect(getTotalPages(100, -1)).toBe(1);
		});
	});
	describe('clampPage', () => {
		it('passes through an in-range page', () => {
			expect(clampPage(2, 100, 32)).toBe(2);
		});
		it('clamps above the last page and below the first', () => {
			expect(clampPage(99, 100, 32)).toBe(4);
			expect(clampPage(0, 100, 32)).toBe(1);
			expect(clampPage(-3, 100, 32)).toBe(1);
		});
		it('collapses to page 1 when the list empties out', () => {
			expect(clampPage(7, 0, 32)).toBe(1);
		});
		it('rejects non-finite input rather than propagating NaN', () => {
			expect(clampPage(NaN, 100, 32)).toBe(1);
			expect(clampPage(Infinity, 100, 32)).toBe(1);
		});
		it('floors a fractional page', () => {
			expect(clampPage(2.9, 100, 32)).toBe(2);
		});
	});
	describe('getPageSlice', () => {
		const items = Array.from({ length: 100 }, (_, i) => i);
		it('returns the window for a given page', () => {
			expect(getPageSlice(items, 1, 32)[0]).toBe(0);
			expect(getPageSlice(items, 1, 32)).toHaveLength(32);
			expect(getPageSlice(items, 2, 32)[0]).toBe(32);
		});
		it('returns a short final page rather than padding it', () => {
			expect(getPageSlice(items, 4, 32)).toEqual([96, 97, 98, 99]);
		});
		it('clamps an out-of-range page to the last one instead of returning empty', () => {
			expect(getPageSlice(items, 999, 32)).toEqual([96, 97, 98, 99]);
		});
		it('returns everything when paging is disabled', () => {
			expect(getPageSlice(items, 1, 0)).toHaveLength(100);
		});
		it('handles an empty list', () => {
			expect(getPageSlice([], 3, 32)).toEqual([]);
		});
	});
	describe('getPageRange', () => {
		it('reports an inclusive 1-based range', () => {
			expect(getPageRange(100, 1, 32)).toEqual({ from: 1, to: 32 });
			expect(getPageRange(100, 2, 32)).toEqual({ from: 33, to: 64 });
		});
		it('stops the final range at the item count', () => {
			expect(getPageRange(100, 4, 32)).toEqual({ from: 97, to: 100 });
		});
		// "1-0 of 0" is the tell-tale sign of an unguarded range calculation.
		it('reports a zero range for an empty list', () => {
			expect(getPageRange(0, 1, 32)).toEqual({ from: 0, to: 0 });
		});
	});
});
// Source: src/__tests__/renderer/utils/providerAvailability.test.ts
describe('', () => {
	interface Provider {
		id: string;
		available: boolean;
	}
	const PROVIDERS: Provider[] = [
		{ id: 'claude-code', available: true },
		{ id: 'codex', available: false },
		{ id: 'opencode', available: true },
	];
	const isAvailable = (provider: Provider) => provider.available;
	describe('filterToAvailableProviders', () => {
		it('hides what this machine cannot run', () => {
			expect(filterToAvailableProviders(PROVIDERS, isAvailable, false).map((p) => p.id)).toEqual([
				'claude-code',
				'opencode',
			]);
		});
		it('returns everything when asked to show all', () => {
			expect(filterToAvailableProviders(PROVIDERS, isAvailable, true)).toEqual(PROVIDERS);
		});
		it('falls back to the full list when nothing is installed', () => {
			// A picker filtered to zero rows has no way to reach per-provider settings
			// and no way to proceed - it is a dead end, not an empty state.
			const none = PROVIDERS.map((p) => ({ ...p, available: false }));
			expect(filterToAvailableProviders(none, isAvailable, false)).toEqual(none);
		});
		it('falls back to the full list when nothing is installed, even with a pinned row', () => {
			// The availability bar reads "nothing detected" as "showing everything", so
			// a pin must not turn the fallback into a one-row list.
			const none = PROVIDERS.map((p) => ({ ...p, available: false }));
			expect(filterToAvailableProviders(none, isAvailable, false, (p) => p.id === 'codex')).toEqual(
				none
			);
		});
		it('keeps a pinned provider that would otherwise be filtered out', () => {
			expect(
				filterToAvailableProviders(PROVIDERS, isAvailable, false, (p) => p.id === 'codex').map(
					(p) => p.id
				)
			).toEqual(['claude-code', 'codex', 'opencode']);
		});
		it('does not duplicate a pinned provider that is already available', () => {
			expect(
				filterToAvailableProviders(
					PROVIDERS,
					isAvailable,
					false,
					(p) => p.id === 'claude-code'
				).map((p) => p.id)
			).toEqual(['claude-code', 'opencode']);
		});
		it('preserves the input order rather than floating the available ones', () => {
			// The pickers sort before filtering, so reordering here would silently
			// override the order the caller chose.
			const reversed = [...PROVIDERS].reverse();
			expect(filterToAvailableProviders(reversed, isAvailable, false).map((p) => p.id)).toEqual([
				'opencode',
				'claude-code',
			]);
		});
	});
	describe('providerLocationLabel', () => {
		it('names the remote host when detection ran over SSH', () => {
			expect(providerLocationLabel('build-box')).toBe('on build-box');
		});
		it('says locally when no remote is selected', () => {
			expect(providerLocationLabel()).toBe('locally');
			expect(providerLocationLabel(null)).toBe('locally');
			expect(providerLocationLabel('')).toBe('locally');
		});
	});
});
// Source: src/__tests__/renderer/utils/providerTabSessions.test.ts
describe('', () => {
	function makeTab(overrides: Partial<AITab> = {}): AITab {
		return {
			id: 'tab-1',
			agentSessionId: null,
			name: null,
			starred: false,
			logs: [],
			inputValue: '',
			stagedImages: [],
			createdAt: 0,
			state: 'idle',
			...overrides,
		} as AITab;
	}
	function makeSession(toolType: ToolType, overrides: Partial<Session> = {}): Session {
		return { id: 'session-1', toolType, ...overrides } as Session;
	}
	describe('provider swap re-exports', () => {
		it('are the library implementation, so renderer turn attribution and runtime parking cannot drift', () => {
			expect(switchAgentProvider).toBe(providerSwap.switchAgentProvider);
			expect(switchTabProvider).toBe(providerSwap.switchTabProvider);
			expect(resolveTurnProvider).toBe(providerSwap.resolveTurnProvider);
			expect(updateProviderSlot).toBe(providerSwap.updateProviderSlot);
		});
		it('parks an agent provider without dropping a tab', () => {
			const session = makeSession('claude-code', {
				customModel: 'opus',
				aiTabs: [makeTab({ agentSessionId: 'claude-abc' }), makeTab({ id: 'tab-2' })],
			});
			const { agent } = switchAgentProvider(session, 'codex');
			expect(agent.toolType).toBe('codex');
			expect(agent.aiTabs.map((tab) => tab.id)).toEqual(['tab-1', 'tab-2']);
			expect(agent.aiTabs[0].providerSessions?.['claude-code']?.agentSessionId).toBe('claude-abc');
			expect(agent.providerOverrides?.['claude-code']).toEqual({ customModel: 'opus' });
		});
	});
	describe('codifyTurnSettings', () => {
		it('freezes the provider, model, and effort a turn is sent with', () => {
			const tab = makeTab({ customModel: 'opus', customEffort: 'xhigh' });
			const session = makeSession('claude-code', { customModel: 'sonnet', customEffort: 'low' });
			expect(codifyTurnSettings(tab, session)).toEqual({
				turnProvider: 'claude-code',
				turnModel: 'opus',
				turnEffort: 'xhigh',
			});
		});
		it('falls back to the agent-level overrides when the tab has none', () => {
			const session = makeSession('codex', { customModel: 'gpt-5', customEffort: 'medium' });
			expect(codifyTurnSettings(makeTab(), session)).toEqual({
				turnProvider: 'codex',
				turnModel: 'gpt-5',
				turnEffort: 'medium',
			});
		});
		it('leaves model and effort undefined when the agent default applies', () => {
			// Undefined is meaningful: consumers render no pill rather than labeling
			// the turn with a model name nobody chose.
			expect(codifyTurnSettings(makeTab(), makeSession('claude-code'))).toEqual({
				turnProvider: 'claude-code',
				turnModel: undefined,
				turnEffort: undefined,
			});
		});
	});
	describe('captureQueuedTurnSettings', () => {
		it('freezes the model and effort in force when the item is queued', () => {
			const tab = makeTab({ customModel: 'opus', customEffort: 'xhigh' });
			const session = makeSession('claude-code', { customModel: 'sonnet', customEffort: 'low' });
			expect(captureQueuedTurnSettings(tab, session)).toEqual({
				model: 'opus',
				effort: 'xhigh',
			});
		});
		it('captures the agent default as an explicit pair of undefined fields', () => {
			// The OBJECT is the capture flag, so it must exist even when both values
			// are the agent's own default - otherwise dispatch falls back to the live
			// values and the item inherits a model the user picked afterwards.
			const captured = captureQueuedTurnSettings(makeTab(), makeSession('codex'));
			expect(captured).toEqual({ model: undefined, effort: undefined });
		});
	});
	describe('codifyQueuedTurnSettings', () => {
		it('uses destination settings for migrated queued items while keeping their saved settings intact', () => {
			const item = { id: 'queued', turnSettings: { model: 'haiku', effort: 'low' } };
			const session = makeSession('codex', {
				providerTranslationQueuedOrigins: { queued: 'claude-code' },
				customModel: 'gpt-6',
				customEffort: 'high',
			});
			expect(codifyQueuedTurnSettings(item, undefined, session)).toEqual({
				turnProvider: 'codex',
				turnModel: 'gpt-6',
				turnEffort: 'high',
			});
			expect(item.turnSettings.model).toBe('haiku');
		});
		it('runs a queued item under what it was queued with, not the live values', () => {
			const item = { turnSettings: { model: 'haiku', effort: 'low' } };
			// The user has since switched the tab to a big model.
			const tab = makeTab({ customModel: 'opus', customEffort: 'xhigh' });
			const session = makeSession('claude-code');
			expect(codifyQueuedTurnSettings(item, tab, session)).toEqual({
				turnProvider: 'claude-code',
				turnModel: 'haiku',
				turnEffort: 'low',
			});
		});
		it('keeps an item queued on the agent default on the default', () => {
			const item = { turnSettings: {} };
			const tab = makeTab({ customModel: 'opus', customEffort: 'xhigh' });
			expect(codifyQueuedTurnSettings(item, tab, makeSession('claude-code'))).toEqual({
				turnProvider: 'claude-code',
				turnModel: undefined,
				turnEffort: undefined,
			});
		});
		it('falls back to the live values for items queued before capture existed', () => {
			const tab = makeTab({ customModel: 'opus', customEffort: 'xhigh' });
			expect(codifyQueuedTurnSettings({}, tab, makeSession('claude-code'))).toEqual({
				turnProvider: 'claude-code',
				turnModel: 'opus',
				turnEffort: 'xhigh',
			});
		});
		it('always spawns on the live provider, which owns the resume token', () => {
			const item = { turnSettings: { model: 'haiku', effort: 'low' } };
			expect(codifyQueuedTurnSettings(item, makeTab(), makeSession('codex')).turnProvider).toBe(
				'codex'
			);
		});
		it('honors an override the user set while EDITING the queued message', () => {
			// The queued item was captured on haiku/low, then the user opened the
			// edit modal and switched it to opus/xhigh. The edit rewrites
			// turnSettings, so dispatch must spawn on the edited values - not the
			// original capture, and not the tab's live selection either.
			const edited = { turnSettings: { model: 'opus', effort: 'xhigh' } };
			const tab = makeTab({ customModel: 'sonnet', customEffort: 'medium' });
			expect(codifyQueuedTurnSettings(edited, tab, makeSession('claude-code'))).toEqual({
				turnProvider: 'claude-code',
				turnModel: 'opus',
				turnEffort: 'xhigh',
			});
		});
		it('sends an edited-back-to-default message on the agent default', () => {
			// Clearing a picker in the edit modal drops the field. That must mean
			// "use the agent default", not "fall back to the tab's current model".
			const cleared = { turnSettings: { effort: 'xhigh' } };
			const tab = makeTab({ customModel: 'sonnet', customEffort: 'medium' });
			expect(codifyQueuedTurnSettings(cleared, tab, makeSession('claude-code'))).toEqual({
				turnProvider: 'claude-code',
				turnModel: undefined,
				turnEffort: 'xhigh',
			});
		});
	});
});
// Source: src/__tests__/renderer/utils/sessionAttention.test.ts
describe('', () => {
	const EMPTY_CTX: AttentionContext = {
		batchSessionIds: new Set(),
		stuckOutageIds: new Set(),
	};
	describe('outageIdsFromSignature', () => {
		it('returns an empty set for an empty signature (no phantom empty-string id)', () => {
			const ids = outageIdsFromSignature('');
			expect(ids.size).toBe(0);
			expect(ids.has('')).toBe(false);
		});
		it('splits a comma-joined signature into ids', () => {
			expect(outageIdsFromSignature('a,b,c')).toEqual(new Set(['a', 'b', 'c']));
		});
	});
	describe('sessionNeedsAttention', () => {
		it('is false for an idle, read agent with no batch or outage', () => {
			expect(sessionNeedsAttention(createMockSession({ id: 'a' }), EMPTY_CTX)).toBe(false);
		});
		it('is true when any AI tab is unread', () => {
			const session = createMockSession({
				id: 'a',
				aiTabs: [createMockAITab({ hasUnread: true })],
			});
			expect(sessionNeedsAttention(session, EMPTY_CTX)).toBe(true);
		});
		it('is false when the only unread tab is a hidden consult tab', () => {
			// A cross-agent @mention is answered in the background: it draws no chip on
			// the consulted agent, so an unread on it would be a badge with nothing on
			// screen to clear it.
			const session = createMockSession({
				id: 'a',
				aiTabs: [createMockAITab({ hasUnread: true, hidden: true })],
			});
			expect(sessionNeedsAttention(session, EMPTY_CTX)).toBe(false);
		});
		it('is true when a visible tab is unread alongside a hidden consult tab', () => {
			const session = createMockSession({
				id: 'a',
				aiTabs: [
					createMockAITab({ id: 'consult', hasUnread: true, hidden: true }),
					createMockAITab({ id: 'visible', hasUnread: true }),
				],
			});
			expect(sessionNeedsAttention(session, EMPTY_CTX)).toBe(true);
		});
		it('is true when busy', () => {
			expect(sessionNeedsAttention(createMockSession({ id: 'a', state: 'busy' }), EMPTY_CTX)).toBe(
				true
			);
		});
		it('is true when in an error state', () => {
			expect(sessionNeedsAttention(createMockSession({ id: 'a', state: 'error' }), EMPTY_CTX)).toBe(
				true
			);
		});
		it('is true when auto-running an Auto Run batch even though idle and read', () => {
			const ctx: AttentionContext = {
				batchSessionIds: new Set(['b1']),
				stuckOutageIds: new Set(),
			};
			expect(sessionNeedsAttention(createMockSession({ id: 'b1' }), ctx)).toBe(true);
		});
		it('is true when stuck auto-retrying an outage', () => {
			const ctx: AttentionContext = {
				batchSessionIds: new Set(),
				stuckOutageIds: new Set(['s1']),
			};
			expect(sessionNeedsAttention(createMockSession({ id: 's1' }), ctx)).toBe(true);
		});
		it('matches batch/outage membership by id, not by another agent id', () => {
			const ctx: AttentionContext = {
				batchSessionIds: new Set(['other']),
				stuckOutageIds: new Set(['nope']),
			};
			expect(sessionNeedsAttention(createMockSession({ id: 'a' }), ctx)).toBe(false);
		});
	});
	describe('sessionOrChildrenNeedAttention', () => {
		it('is false when neither the parent nor any child needs attention', () => {
			const parent = createMockSession({ id: 'p' });
			const child = createMockSession({ id: 'c', parentSessionId: 'p' });
			expect(sessionOrChildrenNeedAttention(parent, [child], EMPTY_CTX)).toBe(false);
		});
		it('is true when the parent itself needs attention', () => {
			const parent = createMockSession({ id: 'p', state: 'error' });
			expect(sessionOrChildrenNeedAttention(parent, [], EMPTY_CTX)).toBe(true);
		});
		it('is true when a worktree child is busy', () => {
			const parent = createMockSession({ id: 'p' });
			const child = createMockSession({ id: 'c', parentSessionId: 'p', state: 'busy' });
			expect(sessionOrChildrenNeedAttention(parent, [child], EMPTY_CTX)).toBe(true);
		});
		it('is true when a worktree child is auto-running a batch', () => {
			const parent = createMockSession({ id: 'p' });
			const child = createMockSession({ id: 'c', parentSessionId: 'p' });
			const ctx: AttentionContext = {
				batchSessionIds: new Set(['c']),
				stuckOutageIds: new Set(),
			};
			expect(sessionOrChildrenNeedAttention(parent, [child], ctx)).toBe(true);
		});
		it('is true when a worktree child is stuck in an outage', () => {
			const parent = createMockSession({ id: 'p' });
			const child = createMockSession({ id: 'c', parentSessionId: 'p' });
			const ctx: AttentionContext = {
				batchSessionIds: new Set(),
				stuckOutageIds: new Set(['c']),
			};
			expect(sessionOrChildrenNeedAttention(parent, [child], ctx)).toBe(true);
		});
		it('handles an undefined children list', () => {
			expect(
				sessionOrChildrenNeedAttention(
					createMockSession({ id: 'p', state: 'busy' }),
					undefined,
					EMPTY_CTX
				)
			).toBe(true);
			expect(
				sessionOrChildrenNeedAttention(createMockSession({ id: 'p2' }), undefined, EMPTY_CTX)
			).toBe(false);
		});
	});
});
// Source: src/__tests__/renderer/utils/sessionVisibility.test.ts
describe('', () => {
	/** Sessions carry ids in production; the predicate only reads `isPianola`. */
	type TestSession = VisibilityScopableSession & {
		id: string;
	};
	describe('isSessionVisibleInSidebar', () => {
		it('keeps an ordinary agent regardless of the pianola flag', () => {
			expect(isSessionVisibleInSidebar({}, { pianolaEnabled: false })).toBe(true);
			expect(isSessionVisibleInSidebar({}, { pianolaEnabled: true })).toBe(true);
		});
		it('hides the Pianola agent while its Encore flag is off', () => {
			expect(isSessionVisibleInSidebar({ isPianola: true }, { pianolaEnabled: false })).toBe(false);
			expect(isSessionVisibleInSidebar({ isPianola: true }, {})).toBe(false);
		});
		it('shows the Pianola agent once its Encore flag is on', () => {
			expect(isSessionVisibleInSidebar({ isPianola: true }, { pianolaEnabled: true })).toBe(true);
		});
	});
	describe('filterSessionsVisibleInSidebar', () => {
		const alpha: TestSession = { id: 'a' };
		const pianola: TestSession = { id: 'p', isPianola: true };
		it('drops the Pianola agent while the flag is off', () => {
			expect(filterSessionsVisibleInSidebar([alpha, pianola], { pianolaEnabled: false })).toEqual([
				alpha,
			]);
		});
		it('returns the same array identity when nothing is hidden', () => {
			const sessions = [alpha, pianola];
			// Flag on: no filtering, so memoized consumers keep a stable reference.
			expect(filterSessionsVisibleInSidebar(sessions, { pianolaEnabled: true })).toBe(sessions);
			// Flag off but no Pianola present: still no new array.
			const ordinary: TestSession[] = [alpha];
			expect(filterSessionsVisibleInSidebar(ordinary, { pianolaEnabled: false })).toBe(ordinary);
		});
	});
});
