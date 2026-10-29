import { createRef, type ComponentProps } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ComposerTextarea } from '../../../../renderer/components/ChatComposer';
import { KEYSTROKE_TEXTAREA_MAX_HEIGHT } from '../../../../renderer/utils/textareaSizing';
import { createMockTheme } from '../../../helpers/mockTheme';

const theme = createMockTheme();

type Props = ComponentProps<typeof ComposerTextarea>;

function renderComposer(overrides: Partial<Props> = {}) {
	const props: Props = {
		theme,
		value: '',
		inputRef: createRef<HTMLTextAreaElement>(),
		placeholder: 'Type a message...',
		spellCheck: false,
		onChange: vi.fn(),
		onKeyDown: vi.fn(),
		onPaste: vi.fn(),
		onDrop: vi.fn(),
		...overrides,
	};
	const view = render(<ComposerTextarea {...props} />);
	return {
		...view,
		props,
		textarea: view.container.querySelector('textarea') as HTMLTextAreaElement,
		overlay: () => view.container.querySelector<HTMLElement>('.maestro-input-text-overlay'),
		rerenderWith: (next: Partial<Props>) =>
			view.rerender(<ComposerTextarea {...props} {...next} />),
	};
}

describe('ComposerTextarea', () => {
	it('renders the surface placeholder, value and spell check into the ref', () => {
		const inputRef = createRef<HTMLTextAreaElement>();
		const { textarea } = renderComposer({
			inputRef,
			value: 'hello',
			placeholder: 'Talking to Agent',
			spellCheck: true,
		});

		expect(inputRef.current).toBe(textarea);
		expect(textarea).toHaveAttribute('placeholder', 'Talking to Agent');
		expect(textarea.value).toBe('hello');
		expect(textarea).toHaveAttribute('spellcheck', 'true');
		expect(textarea.style.maxHeight).toBe(`${KEYSTROKE_TEXTAREA_MAX_HEIGHT}px`);
	});

	describe('mention chips', () => {
		it('chips an agent name only when the roster knows it', () => {
			const { overlay, rerenderWith } = renderComposer({ value: 'ask @Alpha now' });
			expect(overlay()).toBeNull();

			rerenderWith({ knownMentionNames: new Set(['alpha']) });
			expect(overlay()).not.toBeNull();
		});

		it('draws no chips while turned off', () => {
			const { overlay } = renderComposer({
				value: 'check @src/index.ts',
				mentionChips: false,
			});
			expect(overlay()).toBeNull();
		});

		it('lifts the textarea above the overlay only while chips are drawn', () => {
			const { textarea, rerenderWith } = renderComposer({ value: 'plain' });
			expect(textarea.style.zIndex).toBe('');

			rerenderWith({ value: 'check @src/index.ts' });
			expect(textarea.style.zIndex).toBe('1');
		});
	});

	describe('geometry', () => {
		it('defaults to two rows with the bottom padding the 176px cap needs', () => {
			const { textarea, overlay } = renderComposer({ value: 'check @src/index.ts' });
			expect(textarea.rows).toBe(2);
			expect(textarea.className).toContain('pb-1');
			expect(textarea.className).toContain('min-h-[3.5rem]');
			expect(overlay()?.style.paddingBottom).toBe('0.25rem');
			expect(overlay()?.style.paddingLeft).toBe('0.75rem');
		});

		it('draws one row without bottom padding, overlay included', () => {
			const { textarea, overlay } = renderComposer({ value: 'check @src/index.ts', rows: 1 });
			expect(textarea.rows).toBe(1);
			expect(textarea.className).not.toContain('pb-1');
			expect(textarea.className).toContain('min-h-[2.5rem]');
			expect(overlay()?.style.paddingBottom).toBe('0px');
			expect(overlay()?.style.paddingLeft).toBe('0.75rem');
		});

		it('draws a prefix before the textarea and narrows its left padding', () => {
			const { textarea, getByText } = renderComposer({ prefix: <span>$</span> });
			expect(getByText('$').nextElementSibling).toBe(textarea);
			expect(textarea.className).toContain('pl-1.5');
			expect(textarea.className).not.toContain('pl-3');
		});
	});

	it('gives the textarea and the chips the same font override', () => {
		const { textarea, overlay } = renderComposer({
			value: 'grep @src/app.ts',
			fontFamily: 'Menlo, monospace',
		});
		expect(textarea.style.fontFamily).toBe('Menlo, monospace');
		expect(overlay()?.style.fontFamily).toBe(textarea.style.fontFamily);
	});

	it('stays focusable while read-only', () => {
		const { textarea } = renderComposer({ readOnly: true });
		textarea.focus();
		expect(textarea.readOnly).toBe(true);
		expect(document.activeElement).toBe(textarea);
	});

	it('forwards the surface handlers', () => {
		const onFocus = vi.fn();
		const onBlur = vi.fn();
		const { textarea, props } = renderComposer({ onFocus, onBlur });

		fireEvent.focus(textarea);
		fireEvent.change(textarea, { target: { value: 'x' } });
		fireEvent.keyDown(textarea, { key: 'Enter' });
		fireEvent.paste(textarea);
		fireEvent.drop(textarea);
		fireEvent.blur(textarea);

		expect(onFocus).toHaveBeenCalledTimes(1);
		expect(props.onChange).toHaveBeenCalledTimes(1);
		expect(props.onKeyDown).toHaveBeenCalledTimes(1);
		expect(props.onPaste).toHaveBeenCalledTimes(1);
		expect(props.onDrop).toHaveBeenCalledTimes(1);
		expect(onBlur).toHaveBeenCalledTimes(1);
	});

	it('accepts a drop by cancelling dragover', () => {
		const { textarea } = renderComposer();
		const dragOver = new Event('dragover', { bubbles: true, cancelable: true });
		textarea.dispatchEvent(dragOver);
		expect(dragOver.defaultPrevented).toBe(true);
	});
});
