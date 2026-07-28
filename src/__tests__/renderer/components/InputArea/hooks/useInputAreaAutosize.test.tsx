import { render, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it } from 'vitest';
import { useInputAreaAutosize } from '../../../../../renderer/components/InputArea/hooks/useInputAreaAutosize';

function Harness({
	value,
	selectionEnd = value.length,
	initialScrollTop = 0,
}: {
	value: string;
	selectionEnd?: number;
	initialScrollTop?: number;
}) {
	const ref = useRef<HTMLTextAreaElement>(null);
	useInputAreaAutosize({ inputRef: ref, inputValue: value, activeTabId: 'tab-1' });

	return (
		<textarea
			ref={(el) => {
				if (!el) return;
				// The real composer textarea is controlled, so its DOM value tracks
				// inputValue. defaultValue is uncontrolled and would keep the previous
				// render's value across a rerender, so mirror the current value here -
				// scrollTextareaToCaretEnd reads textarea.value.length.
				el.value = value;
				Object.defineProperty(el, 'scrollHeight', { value: 200, configurable: true });
				Object.defineProperty(el, 'selectionEnd', { value: selectionEnd, configurable: true });
				el.scrollTop = initialScrollTop;
				ref.current = el;
			}}
			defaultValue={value}
			aria-label="input"
		/>
	);
}

describe('useInputAreaAutosize', () => {
	it('resizes a programmatic value change with the unified 176 cap', async () => {
		const { getByLabelText } = render(<Harness value="hello" />);

		await waitFor(() => {
			expect((getByLabelText('input') as HTMLTextAreaElement).style.height).toBe('176px');
		});
	});

	it('scrolls to the end when the caret is at the end of the value', async () => {
		const { getByLabelText } = render(<Harness value="hello" />);

		await waitFor(() => {
			expect((getByLabelText('input') as HTMLTextAreaElement).scrollTop).toBe(200);
		});
	});

	it('leaves the scroll position untouched when the caret is on an earlier line', async () => {
		const { getByLabelText } = render(
			<Harness value={'hello\nworld'} selectionEnd={2} initialScrollTop={42} />
		);

		await waitFor(() => {
			expect((getByLabelText('input') as HTMLTextAreaElement).style.height).toBe('176px');
		});
		// Exercises scrollTextareaToCaretEnd's contract directly: with selectionEnd on a
		// line before the final one it is a no-op, so the prior scroll position survives
		// the resize. NOTE: this harness pins selectionEnd via Object.defineProperty. The
		// real deferred @-mention / template flows place their caret in a later rAF, so
		// they do NOT reach the helper in this mid-text state during the commit-phase
		// effect (see PR #1294 discussion) - this only documents the helper itself.
		expect((getByLabelText('input') as HTMLTextAreaElement).scrollTop).toBe(42);
	});

	it('scrolls when the caret is mid-way through the final line', async () => {
		// Widened gate: a caret anywhere in the last logical line still snaps that row
		// into view, so a programmatic insertion that lands before trailing characters
		// no longer leaves the caret row clipped.
		const { getByLabelText } = render(
			<Harness value={'hello\nworld'} selectionEnd={8} initialScrollTop={42} />
		);

		await waitFor(() => {
			expect((getByLabelText('input') as HTMLTextAreaElement).scrollTop).toBe(200);
		});
	});

	it('scrolls a restored shorter draft with the caret at the end', async () => {
		const longDraft = 'a'.repeat(400);
		const { rerender, getByLabelText } = render(<Harness value={longDraft} />);

		// Restore a SHORTER draft with the caret at its end. The removed
		// shouldScrollTextareaToEnd heuristic used to skip this because the new value
		// was not longer than the old one, leaving scrollTop stale below the caret.
		rerender(<Harness value="hi" selectionEnd={2} initialScrollTop={40} />);

		await waitFor(() => {
			expect((getByLabelText('input') as HTMLTextAreaElement).scrollTop).toBe(200);
		});
	});
});
