/**
 * Tests for MiniBadge - the shared uppercase text chip ("WT", "Snoozed").
 */

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MiniBadge } from '../../../../renderer/components/ui/MiniBadge';
import { mockTheme } from '../../../helpers/mockTheme';

function renderBadge(props: Partial<React.ComponentProps<typeof MiniBadge>> = {}) {
	const { container } = render(<MiniBadge label="Snoozed" theme={mockTheme} {...props} />);
	return container.firstElementChild as HTMLElement;
}

describe('MiniBadge', () => {
	it('renders the label verbatim, leaving the uppercasing to CSS', () => {
		// A screen reader reads the DOM text, not the rendered casing, so the
		// string must stay as the caller wrote it.
		expect(renderBadge().textContent).toBe('Snoozed');
		expect(renderBadge().className).toContain('uppercase');
	});

	it('tints text and fill from one color, defaulting to the theme accent', () => {
		expect(renderBadge().style.color).toBeTruthy();
		const warned = renderBadge({ color: '#ff0000' });
		expect(warned.style.color).toBe('rgb(255, 0, 0)');
		expect(warned.style.backgroundColor).toBe('rgba(255, 0, 0, 0.125)');
	});

	it('carries an optional tooltip and test id', () => {
		const badge = renderBadge({ title: 'Worktree agent', testId: 'wt-badge' });
		expect(badge.getAttribute('title')).toBe('Worktree agent');
		expect(badge.getAttribute('data-testid')).toBe('wt-badge');
	});
});
