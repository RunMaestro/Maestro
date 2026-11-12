/**
 * Tests for ShortcutHint - the shared key-cap chip and pinned hint row that
 * advertise a keyboard shortcut next to the control it fires.
 *
 * The chord is formatted through the real formatter so these assertions hold on
 * both macOS ('⌘ ⇧ R') and Windows/Linux ('Ctrl+Shift+R').
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ShortcutHint, shortcutSuffix } from '../../../../renderer/components/ui/ShortcutHint';
import { formatShortcutKeys } from '../../../../renderer/utils/shortcutFormatter';
import { mockTheme } from '../../../helpers/mockTheme';

const KEYS = ['Meta', 'Shift', 'r'];
const CHORD = formatShortcutKeys(KEYS);

describe('ShortcutHint', () => {
	it('renders the chord as a right-aligned chip by default', () => {
		const { container } = render(<ShortcutHint theme={mockTheme} keys={KEYS} />);
		const chip = container.firstElementChild as HTMLElement;

		expect(chip.tagName).toBe('SPAN');
		expect(chip).toHaveTextContent(CHORD);
		expect(chip.className).toContain('ml-auto');
	});

	it('prefixes the chord with a label when one is supplied', () => {
		render(<ShortcutHint theme={mockTheme} keys={KEYS} label="Try:" />);
		expect(screen.getByText(`Try: ${CHORD}`)).toBeInTheDocument();
	});

	// An action can ship unbound. A blank key-cap would advertise a combo that
	// does nothing, so the component renders nothing at all instead.
	it('renders nothing for an unbound action', () => {
		const { container } = render(<ShortcutHint theme={mockTheme} keys={[]} />);
		expect(container).toBeEmptyDOMElement();
	});

	describe('row variant', () => {
		it('renders a non-interactive header that cannot be reached by keyboard', () => {
			const { container } = render(
				<ShortcutHint theme={mockTheme} keys={KEYS} label="Try:" variant="row" />
			);
			const row = container.firstElementChild as HTMLElement;

			expect(row.tagName).toBe('DIV');
			expect(row.closest('button')).toBeNull();
			expect(row).not.toHaveAttribute('tabindex');
			expect(row.className).toContain('select-none');
		});

		// The trailing control must survive on a phone, where every element
		// carrying data-shortcut-hint is hidden - so only the chord carries it.
		it('pins a trailing control at the right end without hiding it with the chord', () => {
			const { container } = render(
				<ShortcutHint
					theme={mockTheme}
					keys={KEYS}
					label="Try:"
					variant="row"
					trailing={<button type="button">Refresh</button>}
				/>
			);
			const row = container.firstElementChild as HTMLElement;
			const button = screen.getByRole('button', { name: 'Refresh' });

			expect(row).not.toHaveAttribute('data-shortcut-hint');
			expect(screen.getByText(`Try: ${CHORD}`)).toHaveAttribute('data-shortcut-hint');
			expect(button.closest('[data-shortcut-hint]')).toBeNull();
		});

		it('still draws the row for a trailing control when the action is unbound', () => {
			render(
				<ShortcutHint
					theme={mockTheme}
					keys={[]}
					variant="row"
					trailing={<button type="button">Refresh</button>}
				/>
			);
			expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
			expect(screen.queryByText(CHORD)).toBeNull();
		});
	});
});

describe('shortcutSuffix', () => {
	it('wraps a bound chord in parentheses with a leading space', () => {
		expect(shortcutSuffix(KEYS)).toBe(` (${CHORD})`);
	});

	// Callers concatenate blindly (`Close tab${shortcutSuffix(keys)}`), so an
	// unbound or missing action must contribute nothing rather than an empty
	// pair of parens.
	it('contributes nothing when the action is unbound', () => {
		expect(shortcutSuffix([])).toBe('');
		expect(shortcutSuffix(undefined)).toBe('');
	});
});
