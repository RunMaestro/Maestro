/**
 * Tests for CountBadge - the shared numeric pill (tab-group panel count).
 */

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CountBadge } from '../../../../renderer/components/ui/CountBadge';
import { mockTheme } from '../../../helpers/mockTheme';

function renderBadge(props: Partial<React.ComponentProps<typeof CountBadge>> = {}) {
	const { container } = render(<CountBadge count={3} theme={mockTheme} label="panel" {...props} />);
	return container.firstElementChild as HTMLElement;
}

describe('CountBadge', () => {
	it('renders the count', () => {
		expect(renderBadge().textContent).toBe('3');
	});

	it('renders a zero rather than hiding itself - showing it is the caller call', () => {
		expect(renderBadge({ count: 0 }).textContent).toBe('0');
	});

	it('announces the count with its noun so a screen reader hears more than a digit', () => {
		const badge = renderBadge();
		expect(badge.getAttribute('aria-label')).toBe('3 panels');
		expect(badge.getAttribute('title')).toBe('3 panels');
	});

	it('uses the singular at one', () => {
		expect(renderBadge({ count: 1 }).getAttribute('aria-label')).toBe('1 panel');
	});

	it('caps the display at max but still announces the true count', () => {
		const badge = renderBadge({ count: 250, max: 99 });
		expect(badge.textContent).toBe('99+');
		expect(badge.getAttribute('aria-label')).toBe('250 panels');
	});

	it('does not cap at exactly max', () => {
		expect(renderBadge({ count: 99, max: 99 }).textContent).toBe('99');
	});

	it('uses tabular numerals so the pill does not jitter as the count changes', () => {
		expect(renderBadge().className).toContain('tabular-nums');
	});

	it('takes the theme accent, and lets a caller override style', () => {
		const badge = renderBadge({ style: { opacity: '0.5' } });
		expect(badge.style.color).toBeTruthy();
		expect(badge.style.opacity).toBe('0.5');
	});

	it('passes through className and data-testid', () => {
		const badge = renderBadge({ className: 'ml-1', 'data-testid': 'panel-count' });
		expect(badge.className).toContain('ml-1');
		expect(badge.getAttribute('data-testid')).toBe('panel-count');
	});
});
