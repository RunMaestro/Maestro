/**
 * Tests for StartTruncatedText - one line that clips its start, not its end.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StartTruncatedText } from '../../../../renderer/components/ui/StartTruncatedText';

describe('StartTruncatedText', () => {
	it('clips on one line with the ellipsis at the start', () => {
		render(<StartTruncatedText testId="path">src/a/b/file.tsx</StartTruncatedText>);
		const el = screen.getByTestId('path');
		expect(el).toHaveClass('min-w-0', 'overflow-hidden', 'text-ellipsis', 'whitespace-nowrap');
		expect(el).toHaveStyle({ direction: 'rtl', textAlign: 'left' });
	});

	it('isolates the text in a <bdi> so punctuation stays put', () => {
		render(<StartTruncatedText testId="path">file (1).tsx</StartTruncatedText>);
		const text = screen.getByText('file (1).tsx');
		expect(text.tagName).toBe('BDI');
		expect(text.parentElement).toBe(screen.getByTestId('path'));
	});

	it('defaults the tooltip to string children', () => {
		render(<StartTruncatedText testId="path">src/a/b/file.tsx</StartTruncatedText>);
		expect(screen.getByTestId('path')).toHaveAttribute('title', 'src/a/b/file.tsx');
	});

	it('uses an explicit title, and null suppresses it', () => {
		const { rerender } = render(
			<StartTruncatedText testId="path" title="full name">
				name
			</StartTruncatedText>
		);
		expect(screen.getByTestId('path')).toHaveAttribute('title', 'full name');
		rerender(
			<StartTruncatedText testId="path" title={null}>
				name
			</StartTruncatedText>
		);
		expect(screen.getByTestId('path')).not.toHaveAttribute('title');
	});

	it('merges caller classes and styles', () => {
		render(
			<StartTruncatedText testId="path" className="font-mono" style={{ color: 'red' }}>
				x
			</StartTruncatedText>
		);
		const el = screen.getByTestId('path');
		expect(el).toHaveClass('font-mono', 'overflow-hidden');
		expect(el).toHaveStyle({ color: 'rgb(255, 0, 0)', direction: 'rtl' });
	});
});
