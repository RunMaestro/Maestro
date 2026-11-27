/**
 * Tests for GroupPill - the badge that names an agent's group, shared by the
 * Left Bar's bookmarked agents and the Group Settings pill label preview.
 */

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GroupPill } from '../../../../renderer/components/ui/GroupPill';
import { mockTheme } from '../../../helpers/mockTheme';

const GROUP_NAME = '[1] Aleyemma/Money-Sessions';

function renderPill(props: Partial<React.ComponentProps<typeof GroupPill>> = {}) {
	const { container } = render(
		<GroupPill theme={mockTheme} group={{ name: GROUP_NAME }} {...props} />
	);
	return container.firstElementChild as HTMLElement;
}

describe('GroupPill', () => {
	it('draws the automatic abbreviation for a group with no shortLabel', () => {
		expect(renderPill().textContent).toBe('AMS');
	});

	it('draws the shortLabel when the group has one', () => {
		const pill = renderPill({ group: { name: GROUP_NAME, shortLabel: 'Money' } });
		expect(pill.textContent).toBe('Money');
	});

	it('falls back to the abbreviation for a blank shortLabel', () => {
		expect(renderPill({ group: { name: GROUP_NAME, shortLabel: '   ' } }).textContent).toBe('AMS');
		expect(renderPill({ group: { name: GROUP_NAME, shortLabel: '' } }).textContent).toBe('AMS');
	});

	it('draws the full group name, truncated, and ignores the shortLabel when full', () => {
		const pill = renderPill({ group: { name: GROUP_NAME, shortLabel: 'Money' }, full: true });
		expect(pill.textContent).toBe(GROUP_NAME);
		expect(pill.className).toContain('truncate');
		expect(pill.className).toContain('max-w-[140px]');
	});

	it('is not truncated in its short form', () => {
		expect(renderPill().className).not.toContain('truncate');
	});

	it('keeps the full group name as the title in every form', () => {
		expect(renderPill().title).toBe(GROUP_NAME);
		expect(renderPill({ group: { name: GROUP_NAME, shortLabel: 'Money' } }).title).toBe(GROUP_NAME);
		expect(renderPill({ full: true }).title).toBe(GROUP_NAME);
	});

	it('carries the row chip class and the theme colors of the Left Bar badge', () => {
		const pill = renderPill();
		expect(pill.className).toContain('row-group-chip');
		expect(pill.style.backgroundColor).toBeTruthy();
		expect(pill.style.color).toBeTruthy();
	});

	it('carries an optional test id', () => {
		expect(renderPill({ testId: 'pill' }).getAttribute('data-testid')).toBe('pill');
		expect(renderPill().hasAttribute('data-testid')).toBe(false);
	});
});
