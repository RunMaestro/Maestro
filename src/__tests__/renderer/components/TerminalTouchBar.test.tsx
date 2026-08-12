/**
 * Tests for TerminalTouchBar - the on-screen terminal key bar for touch devices.
 *
 * Covers: every button emits the correct PTY sequence on pointer-down, the Ctrl
 * button drives the sticky toggle and reflects its armed state, and pointer-down
 * is prevented so focus (and the virtual keyboard) stays on the terminal.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TerminalTouchBar } from '../../../renderer/components/TerminalTouchBar';
import { TERMINAL_KEY_SEQUENCES } from '../../../renderer/utils/terminalKeys';
import type { Theme } from '../../../renderer/types';

const theme: Theme = {
	id: 'dark',
	name: 'Dark',
	mode: 'dark',
	colors: {
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		textMain: '#d4d4d4',
		textDim: '#808080',
		accent: '#007acc',
		accentDim: '#004a7f',
		border: '#3c3c3c',
		selection: '#264f78',
	},
} as unknown as Theme;

function renderBar(overrides: Partial<React.ComponentProps<typeof TerminalTouchBar>> = {}) {
	const onKey = vi.fn();
	const onToggleCtrl = vi.fn();
	render(
		<TerminalTouchBar
			theme={theme}
			ctrlArmed={false}
			onToggleCtrl={onToggleCtrl}
			onKey={onKey}
			{...overrides}
		/>
	);
	return { onKey, onToggleCtrl };
}

describe('TerminalTouchBar', () => {
	it('renders all eight keys', () => {
		renderBar();
		// getByLabelText throws if the element is absent, so a successful lookup is the assertion.
		for (const label of ['Escape', 'Tab', 'Control', 'Up', 'Down', 'Left', 'Right', 'Enter']) {
			expect(screen.getByLabelText(label)).toBeTruthy();
		}
	});

	it('emits the matching escape sequence on pointer-down for each key', () => {
		const { onKey } = renderBar();

		fireEvent.pointerDown(screen.getByLabelText('Escape'));
		fireEvent.pointerDown(screen.getByLabelText('Tab'));
		fireEvent.pointerDown(screen.getByLabelText('Enter'));
		fireEvent.pointerDown(screen.getByLabelText('Up'));
		fireEvent.pointerDown(screen.getByLabelText('Down'));
		fireEvent.pointerDown(screen.getByLabelText('Left'));
		fireEvent.pointerDown(screen.getByLabelText('Right'));

		expect(onKey.mock.calls.map((c) => c[0])).toEqual([
			TERMINAL_KEY_SEQUENCES.esc,
			TERMINAL_KEY_SEQUENCES.tab,
			TERMINAL_KEY_SEQUENCES.enter,
			TERMINAL_KEY_SEQUENCES.up,
			TERMINAL_KEY_SEQUENCES.down,
			TERMINAL_KEY_SEQUENCES.left,
			TERMINAL_KEY_SEQUENCES.right,
		]);
	});

	it('Ctrl toggles via onToggleCtrl and never emits a key sequence', () => {
		const { onKey, onToggleCtrl } = renderBar();
		fireEvent.pointerDown(screen.getByLabelText('Control'));
		expect(onToggleCtrl).toHaveBeenCalledTimes(1);
		expect(onKey).not.toHaveBeenCalled();
	});

	it('reflects the armed state on the Ctrl button', () => {
		renderBar({ ctrlArmed: true });
		expect(screen.getByLabelText('Control').getAttribute('aria-pressed')).toBe('true');
	});

	it('prevents the default pointer-down so terminal focus is not stolen', () => {
		renderBar();
		const escBtn = screen.getByLabelText('Escape');
		// fireEvent returns false when the event was cancelled (preventDefault called).
		const notCancelled = fireEvent.pointerDown(escBtn);
		expect(notCancelled).toBe(false);
	});
});
