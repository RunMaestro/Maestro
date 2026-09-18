/**
 * Tests for the annotator's keydown targeting rules.
 *
 * The regression these lock down: the annotator never moved focus on open, so a
 * text field UNDERNEATH the overlay (the chat composer, most often) kept the
 * caret. The old guard deferred to any focused form control, which meant Cmd+Z
 * undid the user's chat message instead of a stroke. Only the annotator's own
 * text fields may claim a keystroke now.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	ANNOTATOR_ROOT_ATTR,
	isAnnotatorFormControl,
	isAnnotatorTextEntry,
} from '../../../../renderer/components/ImageAnnotator/annotatorKeyboard';

let annotatorRoot: HTMLElement;
let outside: HTMLElement;

function mount(parent: HTMLElement, el: HTMLElement): HTMLElement {
	parent.appendChild(el);
	return el;
}

function input(type?: string): HTMLInputElement {
	const el = document.createElement('input');
	if (type) el.type = type;
	return el;
}

beforeEach(() => {
	annotatorRoot = document.createElement('div');
	annotatorRoot.setAttribute(ANNOTATOR_ROOT_ATTR, '');
	outside = document.createElement('div');
	document.body.append(annotatorRoot, outside);
});

afterEach(() => {
	annotatorRoot.remove();
	outside.remove();
});

describe('isAnnotatorTextEntry', () => {
	it('claims the annotator own text label editor', () => {
		const textarea = mount(annotatorRoot, document.createElement('textarea'));
		expect(isAnnotatorTextEntry(textarea)).toBe(true);
	});

	it('ignores a textarea outside the annotator (stale focus under the overlay)', () => {
		const composer = mount(outside, document.createElement('textarea'));
		expect(isAnnotatorTextEntry(composer)).toBe(false);
	});

	it('ignores the drawer sliders and color swatches, which never take text', () => {
		expect(isAnnotatorTextEntry(mount(annotatorRoot, input('range')))).toBe(false);
		expect(isAnnotatorTextEntry(mount(annotatorRoot, input('color')))).toBe(false);
		expect(isAnnotatorTextEntry(mount(annotatorRoot, input('checkbox')))).toBe(false);
	});

	it('claims a text input inside the annotator, typed or untyped', () => {
		expect(isAnnotatorTextEntry(mount(annotatorRoot, input('text')))).toBe(true);
		expect(isAnnotatorTextEntry(mount(annotatorRoot, input()))).toBe(true);
		expect(isAnnotatorTextEntry(mount(annotatorRoot, input('number')))).toBe(true);
	});

	it('claims a contenteditable inside the annotator only', () => {
		// jsdom does not implement the isContentEditable getter, so stub it.
		const editable = () => {
			const el = document.createElement('div');
			Object.defineProperty(el, 'isContentEditable', { value: true });
			return el;
		};
		expect(isAnnotatorTextEntry(mount(annotatorRoot, editable()))).toBe(true);
		expect(isAnnotatorTextEntry(mount(outside, editable()))).toBe(false);
	});

	it('ignores the focused overlay root itself', () => {
		expect(isAnnotatorTextEntry(annotatorRoot)).toBe(false);
		expect(isAnnotatorTextEntry(null)).toBe(false);
	});
});

describe('isAnnotatorFormControl', () => {
	it('lets the annotator sliders keep their own arrow keys', () => {
		expect(isAnnotatorFormControl(mount(annotatorRoot, input('range')))).toBe(true);
		expect(isAnnotatorFormControl(mount(annotatorRoot, document.createElement('select')))).toBe(
			true
		);
	});

	it('does not defer to form controls outside the annotator', () => {
		expect(isAnnotatorFormControl(mount(outside, input('range')))).toBe(false);
		expect(isAnnotatorFormControl(mount(outside, document.createElement('textarea')))).toBe(false);
	});

	it('does not treat the overlay root as a control', () => {
		expect(isAnnotatorFormControl(annotatorRoot)).toBe(false);
	});
});
