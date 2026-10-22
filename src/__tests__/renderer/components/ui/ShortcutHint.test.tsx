/**
 * Tests for ShortcutHint - the shared key-cap chip and pinned hint row that
 * advertise a keyboard shortcut next to the control it fires.
 *
 * The chord is formatted through the real formatter so these assertions hold on
 * both macOS ('⌘ ⇧ R') and Windows/Linux ('Ctrl+Shift+R').
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
	ShortcutHint,
	ShortcutKeys,
	shortcutSuffix,
	shortcutText,
} from '../../../../renderer/components/ui/ShortcutHint';
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
		const { container } = render(<ShortcutHint theme={mockTheme} keys={KEYS} label="Try:" />);
		expect(screen.getByText('Try:')).toBeInTheDocument();
		expect(container.firstElementChild).toHaveTextContent(`Try: ${CHORD}`);
	});

	// A chip in a narrow menu row must never let its chord wrap into a stack.
	it('never wraps or shrinks', () => {
		const { container } = render(<ShortcutHint theme={mockTheme} keys={KEYS} />);
		const chip = container.firstElementChild as HTMLElement;
		expect(chip.className).toContain('whitespace-nowrap');
		expect(chip.className).toContain('shrink-0');
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
	});
});

describe('ShortcutKeys', () => {
	it('draws one cap per key and reads as the formatted chord', () => {
		const { container } = render(<ShortcutKeys theme={mockTheme} keys={KEYS} />);
		const caps = container.querySelectorAll('kbd');
		expect(caps).toHaveLength(3);
		expect(caps[2]).toHaveTextContent('R');
		expect(container.firstElementChild).toHaveTextContent(CHORD);
		expect(container.firstElementChild).toHaveAttribute('data-shortcut-keys', 'Meta+Shift+r');
	});

	it('draws the caps in the accent color, and never wraps', () => {
		const { container } = render(<ShortcutKeys theme={mockTheme} keys={KEYS} />);
		const root = container.firstElementChild as HTMLElement;
		expect(root.className).toContain('whitespace-nowrap');
		expect(root.className).toContain('shrink-0');
		expect(container.querySelector('kbd')).toHaveStyle({ color: mockTheme.colors.accent });
	});

	it("uses the accent's foreground color on an accent surface", () => {
		const { container } = render(<ShortcutKeys theme={mockTheme} keys={KEYS} onAccent />);
		expect(container.querySelector('kbd')).toHaveStyle({
			color: mockTheme.colors.accentForeground,
		});
	});

	it('joins alternative chords with "or"', () => {
		const { container } = render(
			<ShortcutKeys theme={mockTheme} keys={[['Escape'], ['Meta', 'w']]} />
		);
		expect(container.querySelectorAll('kbd')).toHaveLength(3);
		expect(screen.getByText('or')).toBeInTheDocument();
		expect(container.firstElementChild).toHaveAttribute('data-shortcut-keys', 'Escape | Meta+w');
	});

	it('renders nothing for no keys', () => {
		const { container } = render(<ShortcutKeys theme={mockTheme} keys={[]} />);
		expect(container).toBeEmptyDOMElement();
	});
});

describe('shortcutText', () => {
	it('formats chords for a native title and passes a string through', () => {
		expect(shortcutText(KEYS)).toBe(CHORD);
		expect(shortcutText([['Escape'], KEYS])).toBe(`${formatShortcutKeys(['Escape'])} or ${CHORD}`);
		expect(shortcutText('+')).toBe('+');
		expect(shortcutText(undefined)).toBe('');
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
