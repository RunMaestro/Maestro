/**
 * @file messageScrollNavigation.test.ts
 * @description Tests for the pure message-by-message scroll navigation helpers
 *              used by TerminalOutput and GroupChatMessages.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
	jumpToMessageEdge,
	scrollMessageToTop,
	isTextInputTarget,
	isTextEntryTarget,
	isNormalMode,
} from '../../../renderer/utils/messageScrollNavigation';

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
}): { container: HTMLElement; messages: HTMLElement[] } {
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

	// CodeMirror and xterm paint most of themselves as plain divs, so a keydown
	// inside one lands on a node that no tagName test would call a text field.
	describe('editor and terminal surfaces', () => {
		/** A detached `<div class={surfaceClass}>` wrapping one plain child. */
		const surface = (surfaceClass: string) => {
			const root = document.createElement('div');
			root.className = surfaceClass;
			const inner = document.createElement('div');
			root.appendChild(inner);
			return { root, inner };
		};

		it('counts a plain element inside a CodeMirror editor', () => {
			const { inner } = surface('cm-editor');
			expect(isTextEntryTarget(inner)).toBe(true);
		});

		it('counts the .cm-editor root itself', () => {
			const { root } = surface('cm-editor');
			expect(isTextEntryTarget(root)).toBe(true);
		});

		it('counts an element nested several levels inside a CodeMirror editor', () => {
			const { inner } = surface('cm-editor');
			const gutter = document.createElement('div');
			gutter.className = 'cm-gutters';
			const marker = document.createElement('span');
			gutter.appendChild(marker);
			inner.appendChild(gutter);
			expect(isTextEntryTarget(marker)).toBe(true);
		});

		it('counts a non-HTMLElement node inside a CodeMirror editor (an SVG icon)', () => {
			// Proves the surface check runs against Element, not HTMLElement: an
			// SVG child would otherwise fall straight through to false.
			const { inner } = surface('cm-editor');
			const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			inner.appendChild(svg);
			expect(svg instanceof HTMLElement).toBe(false);
			expect(isTextEntryTarget(svg)).toBe(true);
		});

		it('counts a plain element inside an xterm terminal', () => {
			const { inner } = surface('xterm');
			expect(isTextEntryTarget(inner)).toBe(true);
		});

		it('counts the .xterm root itself', () => {
			const { root } = surface('xterm');
			expect(isTextEntryTarget(root)).toBe(true);
		});

		it("counts xterm's hidden helper textarea", () => {
			const { root } = surface('xterm');
			const helper = document.createElement('textarea');
			helper.className = 'xterm-helper-textarea';
			root.appendChild(helper);
			expect(isTextEntryTarget(helper)).toBe(true);
		});

		it('does not count a sibling of an editor or a terminal', () => {
			const wrapper = document.createElement('div');
			const { root } = surface('cm-editor');
			const sibling = document.createElement('div');
			wrapper.append(root, sibling);
			expect(isTextEntryTarget(sibling)).toBe(false);
		});

		it('does not count a class that merely starts with the surface name', () => {
			const decoy = document.createElement('div');
			decoy.className = 'cm-editor-host xterm-wrapper';
			expect(isTextEntryTarget(decoy)).toBe(false);
		});
	});
});

describe('isNormalMode', () => {
	/** A stand-in Document so a test can pin `activeElement` without focusing. */
	const docWith = (activeElement: Element | null) => ({ activeElement }) as unknown as Document;

	const body = () => document.body;

	it('is true when neither the target nor the focused element takes text', () => {
		const div = document.createElement('div');
		expect(isNormalMode({ target: div }, docWith(body()))).toBe(true);
	});

	it('is true for a null target when nothing text-entry holds focus', () => {
		expect(isNormalMode({ target: null }, docWith(null))).toBe(true);
	});

	it('is false when the event target is a text field', () => {
		const input = document.createElement('input');
		expect(isNormalMode({ target: input }, docWith(body()))).toBe(false);
	});

	it('is false when the target is inside a CodeMirror editor', () => {
		const root = document.createElement('div');
		root.className = 'cm-editor';
		const inner = document.createElement('div');
		root.appendChild(inner);
		expect(isNormalMode({ target: inner }, docWith(body()))).toBe(false);
	});

	it('is false when the target is inside an xterm terminal', () => {
		const root = document.createElement('div');
		root.className = 'xterm';
		const screen = document.createElement('div');
		root.appendChild(screen);
		expect(isNormalMode({ target: screen }, docWith(body()))).toBe(false);
	});

	it('is false when focus sits in a text field the event missed', () => {
		// The annotator case: the overlay owns the keydown while the composer
		// textarea underneath still holds focus.
		const overlay = document.createElement('div');
		const composer = document.createElement('textarea');
		expect(isNormalMode({ target: overlay }, docWith(composer))).toBe(false);
	});

	it('is false when focus sits in a terminal the event missed', () => {
		const overlay = document.createElement('div');
		const term = document.createElement('div');
		term.className = 'xterm';
		const helper = document.createElement('textarea');
		term.appendChild(helper);
		expect(isNormalMode({ target: overlay }, docWith(helper))).toBe(false);
	});

	it('reads the real document by default', () => {
		const input = document.createElement('input');
		document.body.appendChild(input);
		try {
			const outside = document.createElement('div');
			document.body.appendChild(outside);
			expect(isNormalMode({ target: outside })).toBe(true);
			input.focus();
			expect(document.activeElement).toBe(input);
			expect(isNormalMode({ target: outside })).toBe(false);
			input.blur();
			expect(isNormalMode({ target: outside })).toBe(true);
			outside.remove();
		} finally {
			input.remove();
		}
	});
});
