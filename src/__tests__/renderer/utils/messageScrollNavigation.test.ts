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
