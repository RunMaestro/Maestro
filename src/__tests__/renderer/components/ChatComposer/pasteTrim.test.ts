import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	applyTrimmedTextPaste,
	clipboardHasImage,
} from '../../../../renderer/components/ChatComposer/pasteTrim';

function clipboard(text: string, types: string[] = ['text/plain']) {
	return {
		items: types.map((type) => ({ type })),
		getData: (format: string) => (format === 'text/plain' ? text : ''),
	} as unknown as DataTransfer;
}

function pasteEvent(text: string, value: string, selection: [number, number]) {
	const target = document.createElement('textarea');
	target.value = value;
	target.selectionStart = selection[0];
	target.selectionEnd = selection[1];
	const preventDefault = vi.fn();
	const event = {
		clipboardData: clipboard(text),
		target,
		preventDefault,
	} as unknown as React.ClipboardEvent;
	return { event, target, preventDefault };
}

describe('clipboardHasImage', () => {
	it('is true when any item is an image', () => {
		expect(clipboardHasImage(clipboard('', ['text/plain', 'image/png']))).toBe(true);
	});

	it('is false for text only', () => {
		expect(clipboardHasImage(clipboard('hi'))).toBe(false);
	});
});

describe('applyTrimmedTextPaste', () => {
	let rafCallbacks: FrameRequestCallback[];
	beforeEach(() => {
		rafCallbacks = [];
		vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
			rafCallbacks.push(cb);
			return rafCallbacks.length;
		});
	});
	afterEach(() => vi.unstubAllGlobals());

	it('replaces the selection with the trimmed text and puts the caret after it', () => {
		const { event, target, preventDefault } = pasteEvent('  world\n', 'hello XX!', [6, 8]);
		// A controlled textarea renders the new value before the caret moves.
		const setValue = vi.fn((next: string) => {
			target.value = next;
		});

		expect(applyTrimmedTextPaste(event, 'hello XX!', setValue)).toBe(true);

		expect(preventDefault).toHaveBeenCalled();
		expect(setValue).toHaveBeenCalledWith('hello world!');
		rafCallbacks.forEach((cb) => cb(0));
		expect(target.selectionStart).toBe(11);
		expect(target.selectionEnd).toBe(11);
	});

	it('splices into the value the caller passes, not the element', () => {
		const { event } = pasteEvent(' x ', 'stale', [0, 0]);
		const setValue = vi.fn();

		applyTrimmedTextPaste(event, 'fresh', setValue);

		expect(setValue).toHaveBeenCalledWith('xfresh');
	});

	it('leaves the native paste alone when trimming changes nothing', () => {
		const { event, preventDefault } = pasteEvent('already trim', '', [0, 0]);
		const setValue = vi.fn();

		expect(applyTrimmedTextPaste(event, '', setValue)).toBe(false);

		expect(preventDefault).not.toHaveBeenCalled();
		expect(setValue).not.toHaveBeenCalled();
		expect(rafCallbacks).toHaveLength(0);
	});

	it('leaves an empty paste alone', () => {
		const { event, preventDefault } = pasteEvent('', 'abc', [3, 3]);
		const setValue = vi.fn();

		expect(applyTrimmedTextPaste(event, 'abc', setValue)).toBe(false);
		expect(preventDefault).not.toHaveBeenCalled();
	});
});
