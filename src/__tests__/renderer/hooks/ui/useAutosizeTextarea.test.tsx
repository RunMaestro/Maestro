import { render, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it } from 'vitest';
import { useAutosizeTextarea } from '../../../../renderer/hooks/ui/useAutosizeTextarea';

function Harness({
	value,
	maxHeight = 112,
	selectionEnd = value.length,
	scrollHeight = 200,
	initialScrollTop = 0,
}: {
	value: string;
	maxHeight?: number;
	selectionEnd?: number;
	scrollHeight?: number;
	initialScrollTop?: number;
}) {
	const ref = useRef<HTMLTextAreaElement | null>(null);
	useAutosizeTextarea({ textareaRef: ref, value, maxHeight });

	return (
		<textarea
			ref={(el) => {
				if (!el) return;
				// `defaultValue` is applied once, so a rerender would leave the DOM
				// value on the FIRST render's text. The caret rule compares
				// selectionEnd against the live value, so a stale value makes the
				// harness - not the hook - decide the outcome. Track it here.
				el.value = value;
				Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
				Object.defineProperty(el, 'selectionEnd', { value: selectionEnd, configurable: true });
				el.scrollTop = initialScrollTop;
				ref.current = el;
			}}
			defaultValue={value}
			aria-label="input"
		/>
	);
}

describe('useAutosizeTextarea', () => {
	it('caps the grown height at maxHeight', async () => {
		const { getByLabelText } = render(<Harness value="hello" maxHeight={112} />);

		await waitFor(() => {
			expect((getByLabelText('input') as HTMLTextAreaElement).style.height).toBe('112px');
		});
	});

	it('keeps the caret line visible when typing at the end of a scrolled composer', async () => {
		const { getByLabelText, rerender } = render(<Harness value="hello" />);

		rerender(<Harness value="hello!" />);

		await waitFor(() => {
			// Scrolled to the bottom rather than left at 0 by the height='auto' toggle,
			// which is what used to clip the line being typed.
			expect((getByLabelText('input') as HTMLTextAreaElement).scrollTop).toBe(200);
		});
	});

	it('leaves the scroll position alone when editing mid-text', async () => {
		const { getByLabelText, rerender } = render(
			<Harness value="hello there" selectionEnd={2} initialScrollTop={60} />
		);

		rerender(<Harness value="hexllo there" selectionEnd={3} initialScrollTop={60} />);

		await waitFor(() => {
			expect((getByLabelText('input') as HTMLTextAreaElement).scrollTop).toBe(60);
		});
	});
});
