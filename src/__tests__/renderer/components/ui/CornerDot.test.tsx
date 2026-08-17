/**
 * Tests for CornerDot - the shared corner pip (unread red dot, busy pulse).
 */

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CornerDot } from '../../../../renderer/components/ui/CornerDot';

function renderDot(props: Partial<React.ComponentProps<typeof CornerDot>> = {}) {
	const { container } = render(<CornerDot color="#ff0000" {...props} />);
	return container.firstElementChild as HTMLElement;
}

describe('CornerDot', () => {
	it('defaults to a small steady dot in the top-right corner', () => {
		const dot = renderDot();
		expect(dot.className).toContain('w-1.5');
		expect(dot.className).toContain('-top-0.5');
		expect(dot.className).toContain('-right-0.5');
		expect(dot.className).not.toContain('animate-pulse');
		expect(dot).toHaveStyle({ backgroundColor: '#ff0000' });
	});

	it('pulses and grows on request', () => {
		const dot = renderDot({ pulse: true, size: 'md' });
		expect(dot.className).toContain('animate-pulse');
		expect(dot.className).toContain('w-2');
	});

	it('hangs off the right edge when placement is right', () => {
		const dot = renderDot({ placement: 'right' });
		expect(dot.className).toContain('top-1/2');
		expect(dot.className).not.toContain('-top-0.5');
	});

	it('rings the dot so it reads on top of a filled parent', () => {
		expect(renderDot({ ringColor: '#123456' })).toHaveStyle({
			boxShadow: '0 0 0 1.5px #123456',
		});
	});

	// The dot repeats what its parent already says, so it stays out of the
	// a11y tree unless a title gives it something of its own to announce.
	it('is aria-hidden without a title and announced with one', () => {
		expect(renderDot().getAttribute('aria-hidden')).toBe('true');
		const titled = renderDot({ title: 'Unread messages' });
		expect(titled.getAttribute('aria-hidden')).toBeNull();
		expect(titled.getAttribute('title')).toBe('Unread messages');
	});

	// pointer-events-none would suppress the native title tooltip entirely.
	it('does not disable pointer events', () => {
		expect(renderDot({ title: 'Unread messages' }).className).not.toContain('pointer-events-none');
	});
});
