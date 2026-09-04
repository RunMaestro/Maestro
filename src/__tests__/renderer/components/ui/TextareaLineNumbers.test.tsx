/**
 * Tests for TextareaLineNumbers - the scroll-synced, wrap-aware line-number
 * gutter shared by the Auto Run expanded editor and the Cue YAML editor.
 *
 * jsdom has no layout engine, so wrap measurement itself cannot be asserted
 * here. These tests guard the mechanism: one entry per logical line, the
 * numbers track the textarea's scrollTop, and the gutter/text metrics stay in
 * step as the document grows past 9, 99, 999 lines.
 */

import { useRef } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
	TextareaLineNumbers,
	lineNumberGutterMetrics,
} from '../../../../renderer/components/ui/TextareaLineNumbers';
import { createMockTheme } from '../../../helpers/mockTheme';

function Harness({
	value,
	fontSize,
	remeasureKey,
}: {
	value: string;
	fontSize?: string;
	remeasureKey?: string | number;
}) {
	const ref = useRef<HTMLTextAreaElement>(null);
	return (
		<div className="relative">
			<TextareaLineNumbers
				textareaRef={ref}
				value={value}
				theme={createMockTheme()}
				remeasureKey={remeasureKey}
			/>
			<textarea
				ref={ref}
				data-testid="editor"
				value={value}
				readOnly
				style={{
					paddingLeft: lineNumberGutterMetrics(value).textPaddingLeft,
					...(fontSize ? { fontSize } : {}),
				}}
			/>
		</div>
	);
}

describe('lineNumberGutterMetrics', () => {
	it('reserves at least two digits so a short document does not reflow on line 10', () => {
		expect(lineNumberGutterMetrics('one').digits).toBe(2);
		expect(lineNumberGutterMetrics('a\nb\nc').digits).toBe(2);
	});

	it('widens with the line count', () => {
		const hundred = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
		const thousand = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n');
		expect(lineNumberGutterMetrics(hundred).digits).toBe(3);
		expect(lineNumberGutterMetrics(thousand).digits).toBe(4);
	});

	it('keeps the text padding wider than the gutter so digits never touch the text', () => {
		const metrics = lineNumberGutterMetrics('a\nb');
		expect(metrics.gutterWidth).toBe('calc(2ch + 18px)');
		expect(metrics.textPaddingLeft).toBe('calc(2ch + 24px)');
	});
});

describe('TextareaLineNumbers', () => {
	it('renders one number per logical line', () => {
		render(<Harness value={'first\nsecond\nthird'} />);
		const gutter = screen.getByTestId('line-numbers');
		expect(gutter.textContent).toBe('123');
	});

	it('counts the trailing blank line a newline creates', () => {
		render(<Harness value={'first\n'} />);
		expect(screen.getByTestId('line-numbers').textContent).toBe('12');
	});

	it('hides the gutter from assistive tech - it labels the textarea, it is not content', () => {
		render(<Harness value={'a'} />);
		expect(screen.getByTestId('line-numbers')).toHaveAttribute('aria-hidden', 'true');
	});

	it('translates the numbers by the textarea scroll position', () => {
		render(<Harness value={'a\nb\nc'} />);
		const textarea = screen.getByTestId('editor');
		const rows = screen.getByTestId('line-numbers').firstElementChild as HTMLElement;

		expect(rows.style.transform).toBe('translateY(0px)');

		Object.defineProperty(textarea, 'scrollTop', { value: 42, configurable: true });
		fireEvent.scroll(textarea);

		expect(rows.style.transform).toBe('translateY(-42px)');
	});

	it('pushes the textarea text clear of the gutter', () => {
		render(<Harness value={'a\nb'} />);
		expect(screen.getByTestId('editor')).toHaveStyle({ paddingLeft: 'calc(2ch + 24px)' });
	});

	describe('remeasureKey', () => {
		// The gutter is a sibling rendered BEFORE the textarea, so its layout effect
		// runs while `textareaRef.current` is still null and the mount pass measures
		// nothing. The first real measurement therefore lands on the first re-run,
		// which is what these tests drive with the key.
		it('re-mirrors the textarea typography when the key changes', () => {
			const { rerender } = render(<Harness value={'a\nb'} fontSize="14px" remeasureKey={1} />);
			rerender(<Harness value={'a\nb'} fontSize="14px" remeasureKey={1.1} />);
			expect(screen.getByTestId('line-numbers')).toHaveStyle({ fontSize: '14px' });

			rerender(<Harness value={'a\nb'} fontSize="21px" remeasureKey={1.5} />);
			expect(screen.getByTestId('line-numbers')).toHaveStyle({ fontSize: '21px' });
		});

		it('holds the old typography when the key does not move - the bug the prop exists for', () => {
			// A font-size change leaves the border box the same size, so the
			// component's own ResizeObserver never fires. With nothing in the deps to
			// notice, the gutter keeps the previous font until something else re-runs
			// the measurement.
			const { rerender } = render(<Harness value={'a\nb'} fontSize="14px" remeasureKey={1} />);
			rerender(<Harness value={'a\nb'} fontSize="14px" remeasureKey={1.1} />);
			expect(screen.getByTestId('line-numbers')).toHaveStyle({ fontSize: '14px' });

			rerender(<Harness value={'a\nb'} fontSize="21px" remeasureKey={1.1} />);
			expect(screen.getByTestId('line-numbers')).toHaveStyle({ fontSize: '14px' });
		});
	});
});
